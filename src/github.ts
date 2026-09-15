import { Octokit } from "@octokit/rest";
import { CONFIG, OPS_LEDGER, type RepoConfig } from "./config.js";

const octokit = new Octokit({ auth: CONFIG.githubToken || undefined });

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  url: string;
  at: string;
}

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  at: string;
}

export interface RepoHead {
  sha: string;
  defaultBranch: string;
}

/** True for a GitHub "not found / no access" so callers can warn and skip. */
function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}

export async function getHead(repo: RepoConfig): Promise<RepoHead | null> {
  try {
    const { data: r } = await octokit.repos.get({ owner: repo.owner, repo: repo.name });
    const { data: branch } = await octokit.repos.getBranch({
      owner: repo.owner,
      repo: repo.name,
      branch: r.default_branch,
    });
    return { sha: branch.commit.sha, defaultBranch: r.default_branch };
  } catch (err) {
    if (isMissing(err)) {
      console.warn(`[github] ${repo.owner}/${repo.name}: not found or no access — skipping (check the name/token scope).`);
      return null;
    }
    throw err;
  }
}

/** Commits on the default branch strictly after `sinceIso`. */
export async function commitsSince(repo: RepoConfig, sinceIso: string): Promise<CommitInfo[]> {
  try {
    const commits = await octokit.paginate(octokit.repos.listCommits, {
      owner: repo.owner,
      repo: repo.name,
      since: sinceIso,
      per_page: 100,
    });
    return commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split("\n")[0] ?? c.commit.message,
      author: c.author?.login ?? c.commit.author?.name ?? "unknown",
      url: c.html_url,
      at: c.commit.author?.date ?? c.commit.committer?.date ?? sinceIso,
    }));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/** PRs merged strictly after `sinceIso` (the richest unit for a changelog). */
export async function mergedPRsSince(repo: RepoConfig, sinceIso: string): Promise<PRInfo[]> {
  try {
    const since = new Date(sinceIso).getTime();
    const prs = await octokit.paginate(octokit.pulls.list, {
      owner: repo.owner,
      repo: repo.name,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 50,
    });
    const out: PRInfo[] = [];
    for (const pr of prs) {
      if (!pr.merged_at) continue;
      if (new Date(pr.merged_at).getTime() <= since) {
        // listing is newest-updated first; once we pass the cursor we can stop
        // (a closed-unmerged PR could still update later, so only break on merged)
        continue;
      }
      out.push({
        number: pr.number,
        title: pr.title,
        body: (pr.body ?? "").slice(0, 4000),
        author: pr.user?.login ?? "unknown",
        url: pr.html_url,
        at: pr.merged_at,
      });
    }
    return out;
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

export interface DiffDigest {
  commitCount: number;
  additions: number;
  deletions: number;
  files: { filename: string; status: string; additions: number; deletions: number }[];
}

/** File-level change summary between two SHAs (base..head). */
export async function diffDigest(repo: RepoConfig, baseSha: string, headSha: string): Promise<DiffDigest | null> {
  if (baseSha === headSha) return null;
  try {
    const { data } = await octokit.repos.compareCommitsWithBasehead({
      owner: repo.owner,
      repo: repo.name,
      basehead: `${baseSha}...${headSha}`,
    });
    const files = (data.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
    return {
      commitCount: data.total_commits,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      files,
    };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Fetch the ops ledger markdown files for deploy/release context (best-effort). */
export async function fetchLedger(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const path of OPS_LEDGER.files) {
    try {
      const { data } = await octokit.repos.getContent({ owner: OPS_LEDGER.owner, repo: OPS_LEDGER.name, path });
      if (!Array.isArray(data) && data.type === "file" && data.content) {
        out.push({ path, text: Buffer.from(data.content, "base64").toString("utf8") });
      }
    } catch (err) {
      if (!isMissing(err)) console.warn(`[github] ledger ${path}: ${(err as Error).message}`);
    }
  }
  return out;
}
