# review-notifier — Cloudflare Worker

Replaces the GitHub Actions cron in `.github/workflows/notify-review.yml` with a
Cloudflare Worker cron, because GitHub's scheduled workflows kept silently
never firing for this repo (verified: all runs were `workflow_dispatch`, zero
`schedule` events across 3 days and 3 different cron expressions).

The Worker does the whole job itself — no Actions minutes, no state commits:

1. Hourly cron tick → GitHub search: open PRs opened within the last 7 days,
   `review-requested:@me`
2. Dedupe against last-seen URL list in Workers KV
3. Slack message per new PR (with PR-age in the text)
4. Working-hours gate: Brisbane Mon–Fri 07:00–18:59 locally (UTC+10, no DST)

## One-time setup

```bash
cd cloudflare-worker
npx wrangler login                                  # opens browser
npx wrangler kv namespace create STATE              # prints an id → paste into wrangler.toml
npx wrangler secret put GH_TOKEN                    # fine-grained PAT, read-only Metadata+Pull requests
npx wrangler secret put SLACK_WEBHOOK_URL           # same webhook as before
npx wrangler deploy
```

## Verify

Open the deployed worker URL (printed by deploy, e.g. `https://review-notifier.<account>.workers.dev`)
in a browser — it runs a check immediately (hours guard skipped for manual hits)
and returns the result text. Employees of no one: the URL is unauthenticated;
it only ever triggers the same safe poll.

## Cutover

Once the worker is verified working:

1. Delete the `schedule:` block from `.github/workflows/notify-review.yml`
   (keep `workflow_dispatch:` — manual runs remain a useful fallback)
2. Agree what to do with `.github/scripts/poll-review-requests.sh` — delete it,
   or keep for reference

## Free-tier headroom

- Requests: ~24/day vs 100k/day — no concern
- KV writes: ~24/day vs 1,000/day — no concern
- Cron triggers: included on the free plan (max 3 schedules/worker)
