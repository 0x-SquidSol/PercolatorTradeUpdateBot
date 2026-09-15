import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const STATE_PATH = new URL("../state.json", import.meta.url);

export interface PendingCommit {
  kind: "commit";
  repo: string;
  sha: string;
  message: string;
  author: string;
  url: string;
  at: string;
}

export interface PendingPR {
  kind: "pr";
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  at: string;
}

export type PendingChange = PendingCommit | PendingPR;

export interface RepoState {
  /** ISO timestamp of the last poll — used as the `since` cursor. */
  lastPollAt: string;
  /** Head SHA of the default branch at the last poll. */
  lastSeenSha: string | null;
  /** Head SHA at the last time we drafted a post (the diff base for the next). */
  lastPostedSha: string | null;
}

export interface State {
  /** ISO timestamp of the last drafted post, or null if none yet. */
  lastPostAt: string | null;
  repos: Record<string, RepoState>;
  /** Everything observed since the last post, cleared when a post is drafted. */
  pending: PendingChange[];
}

export function emptyState(): State {
  return { lastPostAt: null, repos: {}, pending: [] };
}

export async function loadState(): Promise<State> {
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      lastPostAt: parsed.lastPostAt ?? null,
      repos: parsed.repos ?? {},
      pending: parsed.pending ?? [],
    };
  } catch (err) {
    console.error("[state] could not parse state.json, starting fresh:", err);
    return emptyState();
  }
}

export async function saveState(state: State): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
