import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveDashboardItem, resolveStaleItems } from '../src/supabase';

type Row = Record<string, unknown>;
type TableStore = Record<string, Row[]>;

class SelectBuilder {
  private filters: Array<(row: Row) => boolean> = [];

  constructor(private rows: Row[]) {}

  eq(field: string, value: unknown): this {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  is(field: string, value: unknown): this {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  limit(count: number): Promise<{ data: Row[]; error: null }> {
    return Promise.resolve({ data: this.filtered().slice(0, count), error: null });
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.filtered();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: this.filtered(), error: null }).then(onfulfilled, onrejected);
  }

  private filtered(): Row[] {
    return this.rows.filter((row) => this.filters.every((filter) => filter(row)));
  }
}

class UpdateBuilder {
  private filters: Array<(row: Row) => boolean> = [];
  private executed = false;

  constructor(
    private rows: Row[],
    private payload: Row,
  ) {}

  eq(field: string, value: unknown): this {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  is(field: string, value: unknown): this {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  then<TResult1 = { error: null }, TResult2 = never>(
    onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (!this.executed) {
      for (const row of this.rows) {
        if (this.filters.every((filter) => filter(row))) {
          Object.assign(row, this.payload);
        }
      }
      this.executed = true;
    }
    return Promise.resolve({ error: null }).then(onfulfilled, onrejected);
  }
}

function createSupabaseStub(tables: TableStore): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        select() {
          return new SelectBuilder(rows);
        },
        update(payload: Row) {
          return new UpdateBuilder(rows, payload);
        },
        insert(payload: Row | Row[]) {
          const inserts = Array.isArray(payload) ? payload : [payload];
          rows.push(...inserts.map((row) => ({ ...row })));
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe('resolveDashboardItem', () => {
  it('matches the exact row and writes a resolution log entry', async () => {
    const tables: TableStore = {
      cc_dashboard_items: [
        {
          id: 'row-1',
          item_type: 'STEP_FROZEN',
          cm: 'CARLOS',
          campaign_id: 'campaign-1',
          campaign_name: 'Campaign 1',
          workspace_id: 'workspace-1',
          step: 2,
          variant: null,
          created_at: '2026-04-13T21:09:26.933Z',
          resolved_at: null,
        },
        {
          id: 'row-2',
          item_type: 'STEP_FROZEN',
          cm: 'LEO',
          campaign_id: 'campaign-2',
          campaign_name: 'Campaign 2',
          workspace_id: 'workspace-2',
          step: 2,
          variant: null,
          created_at: '2026-04-13T21:09:26.933Z',
          resolved_at: null,
        },
      ],
      cc_resolution_log: [],
    };
    const sb = createSupabaseStub(tables);

    const resolved = await resolveDashboardItem(sb, {
      campaign_id: 'campaign-1',
      item_type: 'STEP_FROZEN',
      step: 2,
      variant: null,
      resolution_method: 'auto_rehab',
    });

    expect(resolved).toBe(true);
    expect(tables.cc_dashboard_items[0].resolved_at).toBeTruthy();
    expect(tables.cc_dashboard_items[1].resolved_at).toBeNull();
    expect(tables.cc_resolution_log).toHaveLength(1);
    expect(tables.cc_resolution_log[0]).toMatchObject({
      item_type: 'STEP_FROZEN',
      campaign_id: 'campaign-1',
      resolution_method: 'auto_rehab',
      step: 2,
      variant: null,
    });
  });

  it('is idempotent once the dashboard row is already resolved', async () => {
    const tables: TableStore = {
      cc_dashboard_items: [
        {
          id: 'row-1',
          item_type: 'STEP_FROZEN',
          cm: 'CARLOS',
          campaign_id: 'campaign-1',
          campaign_name: 'Campaign 1',
          workspace_id: 'workspace-1',
          step: 2,
          variant: null,
          created_at: '2026-04-13T21:09:26.933Z',
          resolved_at: null,
        },
      ],
      cc_resolution_log: [],
    };
    const sb = createSupabaseStub(tables);

    expect(await resolveDashboardItem(sb, {
      campaign_id: 'campaign-1',
      item_type: 'STEP_FROZEN',
      step: 2,
      variant: null,
      resolution_method: 'auto_rehab',
    })).toBe(true);

    expect(await resolveDashboardItem(sb, {
      campaign_id: 'campaign-1',
      item_type: 'STEP_FROZEN',
      step: 2,
      variant: null,
      resolution_method: 'auto_rehab',
    })).toBe(false);

    expect(tables.cc_resolution_log).toHaveLength(1);
  });
});

describe('resolveStaleItems', () => {
  it('auto-resolves DRY_RUN_KILL rows while leaving permanent DISABLED rows open', async () => {
    const tables: TableStore = {
      cc_dashboard_items: [
        {
          id: 'dry-run-1',
          item_type: 'DRY_RUN_KILL',
          cm: 'CARLOS',
          campaign_id: 'campaign-1',
          campaign_name: 'Campaign 1',
          workspace_id: 'workspace-1',
          step: 2,
          variant: 0,
          created_at: '2026-04-13T21:09:26.933Z',
          resolved_at: null,
        },
        {
          id: 'disabled-1',
          item_type: 'DISABLED',
          cm: 'CARLOS',
          campaign_id: 'campaign-1',
          campaign_name: 'Campaign 1',
          workspace_id: 'workspace-1',
          step: 2,
          variant: 1,
          created_at: '2026-04-13T21:09:26.933Z',
          resolved_at: null,
        },
      ],
      cc_resolution_log: [],
    };
    const sb = createSupabaseStub(tables);

    const resolved = await resolveStaleItems(sb, 'CARLOS', new Set(), 'scan-3');

    expect(resolved).toBe(1);
    expect(tables.cc_dashboard_items[0].resolved_at).toBeTruthy();
    expect(tables.cc_dashboard_items[1].resolved_at).toBeNull();
    expect(tables.cc_resolution_log).toHaveLength(1);
    expect(tables.cc_resolution_log[0]).toMatchObject({
      item_type: 'DRY_RUN_KILL',
      campaign_id: 'campaign-1',
      resolution_method: 'auto',
    });
  });
});
