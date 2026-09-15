# dcc-watch

A long-running daemon that watches the in-scope **dcccrypto/percolator** repos
and drafts a professional technical **X (Twitter) thread every few days** —
covering the major changes and resolved issues, and *how they affect* integrators,
LPs, traders, and keeper operators. Drafts are written for review; **nothing is
posted automatically.**

## What it tracks

The 10-repo Primacy-of-Impact scope from `dcccrypto/percolator-ops/ledger/audit-scope.md`,
minus the decommissioned `percolator-api` (edit `src/config.ts` to change):

`percolator` · `percolator-prog` · `percolator-stake` · `percolator-nft` ·
`percolator-match` · `percolator-sdk` · `percolator-indexer` · `percolator-launch` ·
`percolator-oracle-keeper` (the live keeper — **not** the out-of-scope `percolator-keeper`).

At compose time it also reads `dcccrypto/percolator-ops/ledger/*` (deployments,
releases, PR verdicts, findings) so the post can correctly separate **shipped /
deployed on-chain** from **merged-but-not-yet-live**.

## How it works

- **Watch** — every `POLL_INTERVAL_SECONDS` (default 300s) it checks each repo's
  default-branch head; on a change it records the new commits and merged PRs into
  `state.json`. This is the continuous watch.
- **Compose** — every `POST_INTERVAL_DAYS` (default 2) it bundles everything
  accumulated, pulls file-level diff stats, adds the ledger context, and asks
  Claude to write the thread (`prompts/post-system.md` is the writer's brief).
- **Deliver** — writes `drafts/YYYY-MM-DD-update.md` (the thread + a collapsible
  source digest). Set `GIT_COMMIT_DRAFTS=true` to also commit+push each draft.

## Setup

```bash
npm install
cp .env.example .env      # fill in GITHUB_TOKEN and ANTHROPIC_API_KEY
```

- **GITHUB_TOKEN** — read access to the tracked repos. If any are private, use a
  classic PAT with `repo` scope, or a fine-grained token with *Contents: read* +
  *Pull requests: read*. (A missing/renamed/no-access repo is skipped with a
  warning, not a crash.)
- **ANTHROPIC_API_KEY** — for drafting.

## Run

```bash
npm run once          # single poll pass, no drafting (smoke test / cron)
npm run compose       # draft now from whatever's pending (test the writer)
npm start             # the daemon (watch + draft on cadence)
```

Keep it alive on a box with pm2:

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

## Notes

- First boot sets a baseline per repo (no history backfill) and starts the post
  clock, so the first draft lands one full interval later.
- `state.json` and `.env` are git-ignored. Delete `state.json` to reset baselines.
- Model defaults to `claude-opus-5`; set `ANTHROPIC_MODEL=claude-sonnet-5` for a
  cheaper run.
