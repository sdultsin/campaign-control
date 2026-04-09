import type { AuditEntry, RunSummary, DaySummary } from './types';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateUtcMinusDays(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function prevDate(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDate(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function serveDashboard(
  kv: KVNamespace,
  params: URLSearchParams,
): Promise<Response> {
  const daysParam = params.get('days');
  if (daysParam !== null) {
    return serveSummaryView(kv, parseInt(daysParam, 10) || 7);
  }
  const dateParam = params.get('date') ?? todayUtc();
  const typeFilter = params.get('type') ?? 'all';
  return serveDateView(kv, dateParam, typeFilter);
}

async function serveDateView(
  kv: KVNamespace,
  date: string,
  typeFilter: string,
): Promise<Response> {
  const logPrefix = `log:${date}`;
  const logListed = await kv.list({ prefix: logPrefix, limit: 200 });

  const entries: AuditEntry[] = [];
  for (const key of logListed.keys) {
    const raw = await kv.get(key.name);
    if (raw) {
      const entry = JSON.parse(raw) as AuditEntry;
      if (typeFilter === 'all' || entry.action === typeFilter) {
        entries.push(entry);
      }
    }
  }
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const totalKeys = logListed.keys.length;
  const hasMore = !logListed.list_complete;

  const runPrefix = `run:${date}`;
  const runListed = await kv.list({ prefix: runPrefix });
  const runs: RunSummary[] = [];
  for (const key of runListed.keys) {
    const raw = await kv.get(key.name);
    if (raw) runs.push(JSON.parse(raw) as RunSummary);
  }
  runs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const html = renderDateView(date, entries, runs, typeFilter, hasMore, totalKeys);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function serveSummaryView(
  kv: KVNamespace,
  days: number,
): Promise<Response> {
  const rows: DaySummary[] = [];

  for (let i = 0; i < days; i++) {
    const date = dateUtcMinusDays(i);
    const listed = await kv.list({ prefix: `run:${date}` });

    let disabled = 0, blocked = 0, warned = 0, errors = 0, runsCompleted = 0;
    for (const key of listed.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      const run = JSON.parse(raw) as RunSummary;
      disabled += run.variantsDisabled;
      blocked += run.variantsBlocked;
      warned += run.variantsWarned ?? 0;
      errors += run.errors;
      runsCompleted++;
    }

    rows.push({ date, disabled, blocked, warned, errors, runsCompleted });
  }

  const html = renderSummaryView(rows, days);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso: string): string {
  return iso.slice(11, 19);
}

function renderDateView(
  date: string,
  entries: AuditEntry[],
  runs: RunSummary[],
  typeFilter: string,
  hasMore: boolean,
  totalKeys: number,
): string {
  const prev = prevDate(date);
  const next = nextDate(date);
  const today = todayUtc();

  const filterLinks = ['all', 'DISABLED', 'BLOCKED', 'WARNING', 'RE_ENABLED', 'EXPIRED', 'CM_OVERRIDE']
    .map((t) => {
      const active = t === typeFilter;
      return `<a href="/__dashboard?date=${date}&type=${t}" style="${active ? 'color:#60a5fa;font-weight:bold;' : 'color:#9ca3af;'}text-decoration:none;margin-right:12px;">${t}</a>`;
    })
    .join('');

  const runCards = runs.length === 0
    ? '<p style="color:#6b7280;">No runs recorded for this date.</p>'
    : runs.map((r) => {
        const durationSec = (r.durationMs / 1000).toFixed(1);
        const dryTag = r.dryRun ? ' <span style="color:#f59e0b;">[DRY RUN]</span>' : '';
        return `<div style="background:#1e293b;border-radius:8px;padding:12px 16px;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;">
          <span style="color:#94a3b8;">Run ${formatTime(r.timestamp)} UTC${dryTag}</span>
          <span>${r.workspacesProcessed} workspaces</span>
          <span>${r.campaignsEvaluated} campaigns</span>
          <span style="color:#ef4444;">${r.variantsDisabled} disabled</span>
          <span style="color:#f59e0b;">${r.variantsBlocked} blocked</span>
          <span style="color:#3b82f6;">${r.variantsWarned ?? 0} warned</span>
          <span style="color:${r.errors > 0 ? '#ef4444' : '#6b7280'};">${r.errors} errors</span>
          <span style="color:#6b7280;">${durationSec}s</span>
        </div>`;
      }).join('');

  const tableRows = entries.length === 0
    ? '<tr><td colspan="10" style="text-align:center;color:#6b7280;padding:24px;">No actions recorded for this date/filter.</td></tr>'
    : entries.map((e) => {
        const bgColor = e.action === 'DISABLED' ? '#3d1515' : e.action === 'BLOCKED' ? '#3d2d0a' : '#1e293b';
        const opacity = e.dryRun ? 'opacity:0.6;font-style:italic;' : '';
        const ratio = e.trigger.opportunities === 0 ? 'inf' : e.trigger.ratio;
        return `<tr style="background:${bgColor};${opacity}">
          <td>${formatTime(e.timestamp)}</td>
          <td><span style="color:${e.action === 'DISABLED' ? '#ef4444' : e.action === 'BLOCKED' ? '#f59e0b' : '#3b82f6'}">${e.action}</span></td>
          <td>${escapeHtml(e.workspace)}</td>
          <td title="${escapeHtml(e.campaign)}">${escapeHtml(e.campaign.length > 45 ? e.campaign.slice(0, 42) + '...' : e.campaign)}</td>
          <td>${e.step}</td>
          <td>${e.variantLabel}</td>
          <td style="text-align:right;">${e.trigger.sent.toLocaleString()}</td>
          <td style="text-align:right;">${e.trigger.opportunities}</td>
          <td style="text-align:right;">${ratio}:1</td>
          <td>${e.cm ?? '<span style="color:#6b7280;">--</span>'}</td>
        </tr>`;
      }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auto Turn-Off Dashboard - ${date}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; padding: 24px; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th { text-align: left; padding: 8px 12px; background: #1e293b; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155; }
    td { padding: 6px 12px; border-bottom: 1px solid #1e293b; white-space: nowrap; }
    .nav { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
    .section { margin-bottom: 32px; }
  </style>
</head>
<body>
  <h1 style="font-size:20px;margin-bottom:16px;">Auto Turn-Off Audit Log</h1>
  <div class="nav">
    <a href="/__dashboard?date=${prev}">&larr; ${prev}</a>
    <strong>${date}</strong>
    ${date < today ? `<a href="/__dashboard?date=${next}">${next} &rarr;</a>` : '<span style="color:#4b5563;">today</span>'}
    <span style="margin-left:auto;">${filterLinks}</span>
    <a href="/__dashboard?days=7" style="margin-left:16px;">Last 7 days</a>
  </div>
  <div class="section">
    <h2 style="font-size:16px;color:#94a3b8;margin-bottom:12px;">Run Summaries</h2>
    ${runCards}
  </div>
  <div class="section">
    <h2 style="font-size:16px;color:#94a3b8;margin-bottom:12px;">Actions (${entries.length}${hasMore ? ` of ${totalKeys}+, showing first 200` : ''})</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr><th>Time</th><th>Action</th><th>Workspace</th><th>Campaign</th><th>Step</th><th>Var</th><th style="text-align:right;">Sent</th><th style="text-align:right;">Opps</th><th style="text-align:right;">Ratio</th><th>CM</th></tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

function renderSummaryView(rows: DaySummary[], days: number): string {
  const tableRows = rows.map((r) => {
    const hasErrors = r.errors > 0;
    return `<tr>
      <td><a href="/__dashboard?date=${r.date}">${r.date}</a></td>
      <td style="text-align:right;">${r.runsCompleted}</td>
      <td style="text-align:right;color:#ef4444;">${r.disabled}</td>
      <td style="text-align:right;color:#f59e0b;">${r.blocked}</td>
      <td style="text-align:right;color:#3b82f6;">${r.warned}</td>
      <td style="text-align:right;color:${hasErrors ? '#ef4444' : '#6b7280'};">${r.errors}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auto Turn-Off - Last ${days} Days</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; padding: 24px; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; max-width: 700px; }
    th { text-align: left; padding: 8px 12px; background: #1e293b; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155; }
    td { padding: 6px 12px; border-bottom: 1px solid #1e293b; }
  </style>
</head>
<body>
  <h1 style="font-size:20px;margin-bottom:16px;">Auto Turn-Off — Last ${days} Days</h1>
  <p style="margin-bottom:16px;"><a href="/__dashboard">&larr; Back to today</a></p>
  <table>
    <thead>
      <tr><th>Date</th><th style="text-align:right;">Runs</th><th style="text-align:right;">Disabled</th><th style="text-align:right;">Blocked</th><th style="text-align:right;">Warned</th><th style="text-align:right;">Errors</th></tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
</body>
</html>`;
}
