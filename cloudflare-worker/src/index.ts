/**
 * Review-request poller — replaces the GitHub Actions cron (~/.github/workflows/notify-review.yml)
 *
 * On every cron tick (or any GET to the worker URL):
 *   1. Search GitHub for open PRs (>7 days old) requesting the token's owner as reviewer
 *   2. Diff the set of PR URLs against the last-seen set in Workers KV
 *   3. POST a Slack message for each NEW PR
 *   4. Persist the current set
 *
 * Secrets (wrangler secret put ...): GH_TOKEN, SLACK_WEBHOOK_URL
 */

export interface Env {
  STATE: KVNamespace;
  GH_TOKEN: string;
  SLACK_WEBHOOK_URL: string;
}

const STATE_KEY = "seen-pr-urls";
const MAX_AGE_DAYS = 7;

// ---- time helpers -----------------------------------------------------------

/** YYYY-MM-DD for (now - MAX_AGE_DAYS) in Brisbane time. */
function cutoffDate(): string {
  const d = new Date(Date.now() - MAX_AGE_DAYS * 86400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Etc/GMT-10",
    dateStyle: "short",
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")}`;
}

/** Brisbane weekday (1=Mon..7=Sun) and hour (0-23) — UTC+10, no DST. */
function brisbaneNow(): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Etc/GMT-10",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { weekday, hour: parseInt(get("hour"), 10) };
}

// ---- main pipeline ------------------------------------------------------------

async function runCheck(env: Env, skipHoursGuard: boolean): Promise<string> {
  // Working-hours gate: Brisbane Mon-Fri 07:00-18:59 only (unless manual)
  if (!skipHoursGuard) {
    const { weekday, hour } = brisbaneNow();
    if (weekday >= 6 || hour < 7 || hour > 18) {
      return `Outside Brisbane Mon-Fri 07:00-18:59 (weekday=${weekday} hour=${hour}). Skipping.`;
    }
  }

  // FRESH requests only: PRs opened in the last MAX_AGE_DAYS (Brisbane time).
  const q = `is:pr is:open review-requested:@me created:>=${cutoffDate()}`;
  const res = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100`, {
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "review-notifier-worker",
    },
  });
  if (!res.ok) return `GitHub search failed: ${res.status} ${await res.text()}`;

  const data = (await res.json()) as {
    total_count: number;
    items: Array<{
      html_url: string;
      title: string;
      created_at: string;
      user: { login: string };
      repository_url: string;
    }>;
  };

  const pending = data.items;
  const now = pending.map((p) => p.html_url).sort();

  // First-ever run: seed silently (don't spam the backlog)
  const prevRaw = await env.STATE.get(STATE_KEY);
  if (prevRaw === null) {
    await env.STATE.put(STATE_KEY, JSON.stringify(now));
    return `First run: seeded state with ${now.length} pending PR(s); no notifications sent.`;
  }

  const seen: string[] = JSON.parse(prevRaw);
  const fresh = now.filter((u) => !seen.includes(u));

  for (const url of fresh) {
    const pr = pending.find((p) => p.html_url === url)!;
    const ageDays = Math.floor((Date.now() - Date.parse(pr.created_at)) / 86400_000);
    const repo = pr.repository_url.split("/repos/")[1];

    const text =
      `*Review Requested* (PR opened ${ageDays} day(s) ago)\n` +
      `*PR:* <${pr.html_url}|${pr.title}>\n` +
      `*Repo:* ${repo}\n` +
      `*Author:* ${pr.user.login}`;

    const slackRes = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!slackRes.ok) return `Slack post failed for ${url}: ${slackRes.status} ${await slackRes.text()}`;
  }

  // state := current set (a PR re-requested later re-notifies)
  await env.STATE.put(STATE_KEY, JSON.stringify(now));
  return `Done. New notifications: ${fresh.length} (total pending: ${now.length}).`;
}

export default {
  // cron trigger — catches the schedule
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCheck(env, false).then((msg) => console.log(`[scheduled] ${msg}`))
    );
  },

  // manual test: hit the worker URL to run a check any time (skips hours guard)
  async fetch(_req: Request, env: Env): Promise<Response> {
    const msg = await runCheck(env, true);
    return new Response(msg, { headers: { "Content-Type": "text/plain" } });
  },
};
