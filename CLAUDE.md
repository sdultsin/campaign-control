# Campaign Control Auto Turn-Off Worker

## Deploy Protocol

Always deploy via the deploy script, never raw `npx wrangler deploy`:

    cd builds/auto-turn-off
    ./deploy.sh

After each deploy:
1. Confirm `src/version.ts` has the current git hash
2. Query any Supabase table for the latest row -- worker_version should be the git hash
3. Add the new version to VERSION_REGISTRY.md
