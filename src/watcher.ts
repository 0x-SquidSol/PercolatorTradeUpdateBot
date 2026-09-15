import { CONFIG, TRACKED_REPOS } from "./config.js";
import { commitBefore, commitsSince, getHead, mergedPRsSince } from "./github.js";
import { draftPost } from "./compose.js";
import { writeDraft } from "./draft.js";
import { loadState, repoKey, saveState, type State } from "./state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One poll pass: record new commits + merged PRs across all tracked repos. */
export async function pollOnce(state: State): Promise<number> {
  const now = new Date().toISOString();
  let newCount = 0;

  for (const repo of TRACKED_REPOS) {
    const key = repoKey(repo.owner, repo.name);
    const rs = (state.repos[key] ??= { lastPollAt: now, lastSeenSha: null, lastPostedSha: null });

    const head = await getHead(repo);
    if (!head) continue; // missing/no-access — already warned

    // On first sight, set the baseline and don't backfill history.
    if (rs.lastSeenSha === null) {
      rs.lastSeenSha = head.sha;
      rs.lastPostedSha = head.sha;
      rs.lastPollAt = now;
      console.log(`[watch] ${key}: baseline @ ${head.sha.slice(0, 8)}`);
      continue;
    }

    if (head.sha === rs.lastSeenSha) {
      rs.lastPollAt = now;
      continue;
    }

    const since = rs.lastPollAt;
    const [commits, prs] = await Promise.all([commitsSince(repo, since), mergedPRsSince(repo, since)]);

    for (const c of commits) {
      state.pending.push({ kind: "commit", repo: key, sha: c.sha, message: c.message, author: c.author, url: c.url, at: c.at });
      newCount++;
    }
    for (const pr of prs) {
      state.pending.push({ kind: "pr", repo: key, number: pr.number, title: pr.title, body: pr.body, author: pr.author, url: pr.url, at: pr.at });
      newCount++;
    }

    if (commits.length || prs.length) {
      console.log(`[watch] ${key}: +${commits.length} commits, +${prs.length} merged PRs`);
    }
    rs.lastSeenSha = head.sha;
    rs.lastPollAt = now;
  }

  await saveState(state);
  return newCount;
}

/**
 * Seed `pending` from the last `days` of history across all repos, so the first
 * draft has real material instead of waiting a full cycle. For testing/tuning.
 */
export async function backfill(state: State, days: number): Promise<number> {
  const now = new Date();
  const sinceIso = new Date(now.getTime() - days * 86_400_000).toISOString();
  let n = 0;

  for (const repo of TRACKED_REPOS) {
    const key = repoKey(repo.owner, repo.name);
    const head = await getHead(repo);
    if (!head) continue;

    const [commits, prs, base] = await Promise.all([
      commitsSince(repo, sinceIso),
      mergedPRsSince(repo, sinceIso),
      commitBefore(repo, sinceIso),
    ]);

    for (const c of commits) {
      state.pending.push({ kind: "commit", repo: key, sha: c.sha, message: c.message, author: c.author, url: c.url, at: c.at });
      n++;
    }
    for (const pr of prs) {
      state.pending.push({ kind: "pr", repo: key, number: pr.number, title: pr.title, body: pr.body, author: pr.author, url: pr.url, at: pr.at });
      n++;
    }

    state.repos[key] = { lastPollAt: now.toISOString(), lastSeenSha: head.sha, lastPostedSha: base };
    if (commits.length || prs.length) {
      console.log(`[backfill] ${key}: +${commits.length} commits, +${prs.length} merged PRs`);
    }
  }

  await saveState(state);
  return n;
}

function dueToPost(state: State, now = Date.now()): boolean {
  if (state.pending.length === 0) return false;
  if (!state.lastPostAt) {
    // First-ever post: wait one full interval of accumulation before drafting.
    return false;
  }
  const elapsedDays = (now - new Date(state.lastPostAt).getTime()) / 86_400_000;
  return elapsedDays >= CONFIG.postIntervalDays;
}

/** Draft a post now if there's anything pending; clears pending on success. */
export async function composeNow(state: State): Promise<string | null> {
  const post = await draftPost(state);
  if (!post) {
    console.log("[compose] nothing worth posting.");
    // Still advance the clock so we don't retry every tick on an empty period.
    state.lastPostAt = new Date().toISOString();
    await saveState(state);
    return null;
  }
  const path = await writeDraft(post);
  state.lastPostAt = new Date().toISOString();
  state.pending = [];
  for (const rs of Object.values(state.repos)) rs.lastPostedSha = rs.lastSeenSha;
  await saveState(state);
  return path;
}

/** The daemon: poll on an interval, draft when the cadence elapses. */
export async function runDaemon(): Promise<void> {
  const state = await loadState();
  // Seed lastPostAt on first boot so the first post fires one interval later.
  if (!state.lastPostAt) {
    state.lastPostAt = new Date().toISOString();
    await saveState(state);
  }
  console.log(
    `[dcc-watch] watching ${TRACKED_REPOS.length} repos every ${CONFIG.pollIntervalSeconds}s; ` +
      `drafting every ${CONFIG.postIntervalDays}d.`,
  );

  for (;;) {
    try {
      await pollOnce(state);
      if (dueToPost(state)) await composeNow(state);
    } catch (err) {
      console.error("[dcc-watch] poll cycle error:", (err as Error).message);
    }
    await sleep(CONFIG.pollIntervalSeconds * 1000);
  }
}
