#!/usr/bin/env bash
# Find open PRs that currently have "@me" (owner of GH_TOKEN) requested as
# reviewer, Slack-notify the NEW ones, and rewrite the state file with the
# current set. Called by .github/workflows/notify-review.yml.
#
# Requires env: GH_TOKEN, SLACK_WEBHOOK_URL
set -euo pipefail

STATE_FILE=".github/review-notified.txt"

# --- working-hours guard (Brisbane time, UTC+10, no DST) ----------------
# Cron fires hourly in UTC; the script decides whether it's "work time".
# Manual workflow_dispatch runs set this to 1 and skip the guard.
if [ "${SKIP_WORKING_HOURS_GUARD:-0}" != "1" ]; then
  hour="$(TZ=Etc/GMT-10 date +%H)"
  weekday="$(TZ=Etc/GMT-10 date +%u)"   # 1=Mon ... 7=Sun
  if [ "$weekday" -ge 6 ] || [ "$hour" -lt 7 ] || [ "$hour" -gt 18 ]; then
    echo "Outside Brisbane Mon-Fri 07:00-18:59 (now: weekday=$weekday hour=$hour). Skipping."
    exit 0
  fi
fi

tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# --- fetch open PRs requesting my review -------------------------------
# note: this covers DIRECT review requests on you. Team requests
# (@org/team) do not appear in `review-requested:@me` search results.
gh search prs --state open --review-requested "@me" \
  --json url,title,repository,author --limit 100 > "$tmp/current.json"

count=$(jq 'length' "$tmp/current.json")

# --- first run: seed state silently so it doesn't spam every backlog PR
if [ ! -f "$STATE_FILE" ]; then
  mkdir -p "$(dirname "$STATE_FILE")"
  jq -r '.[].url' "$tmp/current.json" | sort -u > "$STATE_FILE"
  echo "First run: seeded state with $count pending PR(s); no notifications sent."
  exit 0
fi

# --- empty result: keep old state (guards against search index glitches)
if [ "$count" -eq 0 ]; then
  echo "No open PRs requesting your review; state unchanged."
  exit 0
fi

jq -r '.[].url' "$tmp/current.json" | sort > "$tmp/now.txt"
sort -u "$STATE_FILE" > "$tmp/seen.txt"
comm -23 "$tmp/now.txt" "$tmp/seen.txt" > "$tmp/new.txt"

notified=0
while IFS= read -r url; do
  pr=$(jq --arg url "$url" '.[] | select(.url == $url)' "$tmp/current.json")

  jq -n \
    --argjson pr "$pr" \
    '{text: ("*Review Requested*\n"
      + "*PR:* <" + $pr.url + "|" + $pr.title + ">\n"
      + "*Repo:* " + $pr.repository.nameWithOwner + "\n"
      + "*Author:* " + $pr.author.login)}' |
    curl -sf -X POST -H 'Content-type: application/json' -d @- "$SLACK_WEBHOOK_URL"

  echo "Notified: $url"
  notified=$((notified + 1))
done < "$tmp/new.txt"

# --- state := current set (so re-requests after you review notify again)
mv "$tmp/now.txt" "$STATE_FILE"

echo "Done. New notifications: $notified (total pending: $count)"
