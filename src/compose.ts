import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { CONFIG, TRACKED_REPOS } from "./config.js";
import { diffDigest, fetchLedger } from "./github.js";
import { repoKey, type State } from "./state.js";

const SYSTEM_PROMPT_PATH = new URL("../prompts/post-system.md", import.meta.url);

/** Build the human-readable digest handed to the model. */
export async function buildDigest(state: State): Promise<string> {
  const byRepo = new Map<string, typeof state.pending>();
  for (const change of state.pending) {
    const list = byRepo.get(change.repo) ?? [];
    list.push(change);
    byRepo.set(change.repo, list);
  }

  const sections: string[] = [];
  for (const repo of TRACKED_REPOS) {
    const key = repoKey(repo.owner, repo.name);
    const changes = byRepo.get(key);
    if (!changes || changes.length === 0) continue;

    const lines: string[] = [`## ${key} — ${repo.role}${repo.onchain ? " [on-chain]" : ""}`];

    const prs = changes.filter((c) => c.kind === "pr");
    if (prs.length) {
      lines.push(`Merged PRs:`);
      for (const pr of prs) {
        if (pr.kind !== "pr") continue;
        lines.push(`- #${pr.number} "${pr.title}" by ${pr.author} — ${pr.url}`);
        const body = pr.body.trim();
        if (body) lines.push(`  ${body.replace(/\r?\n/g, " ").slice(0, 600)}`);
      }
    }

    const commits = changes.filter((c) => c.kind === "commit");
    if (commits.length) {
      lines.push(`Commits (${commits.length}):`);
      for (const c of commits.slice(0, 40)) {
        if (c.kind !== "commit") continue;
        lines.push(`- ${c.sha.slice(0, 8)} ${c.message} (${c.author})`);
      }
    }

    // File-level diff stats give the model substance beyond messages.
    const rs = state.repos[key];
    if (rs?.lastPostedSha && rs.lastSeenSha) {
      const digest = await diffDigest(repo, rs.lastPostedSha, rs.lastSeenSha);
      if (digest) {
        lines.push(
          `Diff: ${digest.commitCount} commits, +${digest.additions}/-${digest.deletions} across ${digest.files.length} files.`,
        );
        const top = [...digest.files]
          .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
          .slice(0, 15);
        for (const f of top) lines.push(`  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`);
      }
    }

    sections.push(lines.join("\n"));
  }

  let digest = sections.join("\n\n");
  if (digest.length > CONFIG.maxDigestChars) digest = digest.slice(0, CONFIG.maxDigestChars) + "\n…(truncated)";
  return digest;
}

export interface DraftedPost {
  thread: string;
  digest: string;
}

/** Compose the X-thread draft from accumulated changes + ledger context. */
export async function draftPost(state: State): Promise<DraftedPost | null> {
  const digest = await buildDigest(state);
  if (!digest.trim()) return null; // nothing worth posting

  const ledger = await fetchLedger();
  const ledgerText = ledger
    .map((l) => `### ${l.path}\n${l.text.slice(0, 8000)}`)
    .join("\n\n");

  const system = await readFile(SYSTEM_PROMPT_PATH, "utf8");
  const anthropic = new Anthropic({ apiKey: CONFIG.anthropicKey });

  const userMessage = [
    `Code changes since the last update:\n\n${digest}`,
    ledgerText
      ? `\n\nOperational ledger (deployed truth — use to separate shipped vs merged):\n\n${ledgerText}`
      : `\n\n(No ledger context available this run — be conservative about claiming anything is deployed.)`,
    `\n\nWrite the update thread now.`,
  ].join("");

  // Opus 5 thinks by default (adaptive); max_tokens must leave room for both the
  // reasoning and the answer, or the thread comes back empty. Bound the thinking
  // with effort — this is summarization, not a hard reasoning task.
  const resp = await anthropic.messages.create({
    model: CONFIG.anthropicModel,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  if (resp.stop_reason === "refusal") {
    console.warn("[compose] model declined to draft this cycle.");
    return null;
  }

  const thread = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return thread ? { thread, digest } : null;
}
