# Handoff: Git Hash Version Tagging

**Spec:** `specs/cc-version-tagging.md`
**Deployed:** 2026-03-20, version `7b95a92`
**Review:** APPROVED (all 8 checklist items passed)

## What the spec asked for

Replace hardcoded `worker_version: 'v2'` in all 5 Supabase table writes with the git short hash, auto-generated at build time via a deploy script.

## What was built

1. **`src/version.ts`** (generated, gitignored) — exports `WORKER_VERSION` constant, written by deploy.sh
2. **`src/supabase.ts`** — imports `WORKER_VERSION`, replaced all 5 hardcoded `'v2'` strings
3. **`deploy.sh`** — generates version.ts from `git rev-parse --short HEAD`, then runs `npx wrangler deploy`
4. **`.gitignore`** — added `src/version.ts`
5. **`VERSION_REGISTRY.md`** — full version history (legacy v2 time windows + automated versions table)
6. **`CLAUDE.md`** — deploy protocol instructions

## What to watch

- If someone runs raw `npx wrangler deploy` without deploy.sh, rows will show `worker_version: 'dev'` — easily spotted
- After every future deploy, add a row to VERSION_REGISTRY.md
- No Supabase schema changes needed (`worker_version` column is already `text`)
