import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { CONFIG, TRACKED_REPOS } from "./config.js";
import { diffDigest, fetchLedger } from "./github.js";
import { repoKey, type State } from "./state.js";

const SYSTEM_PROMPT_PATH = new URL("../prompts/post-system.md", import.meta.url);
/**
 * Optional operator context the ledger cannot know yet.
 *
 * The ledger records what has ALREADY happened. An imminent release is not in
 * it until it ships, so without this the drafter cannot mention a launch that
 * is days away without inventing it — which the system prompt forbids. Absent
 * file means unchanged behaviour.
 */
const RELEASE_CONTEXT_PATH = new URL("../release-context.md", import.meta.url);

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

/** Tweets, split the way the system prompt says to emit them. */
export function splitTweets(thread: string): string[] {
  return thread
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter((t) => /^\d+\//.test(t));
}

/**
 * The system prompt's HARD limits, checked rather than hoped for.
 *
 * "4–7 tweets total" and "each ≤ 280 characters" are numbers, not style — and
 * nothing was verifying them. The 2026-09-30 draft came back with 8 tweets and
 * one at 290 characters, which would have been posted as-is. A model that
 * drifts past a countable rule should be told, not trusted.
 */
export function specViolations(thread: string): string[] {
  const tweets = splitTweets(thread);
  const out: string[] = [];
  if (tweets.length < 4 || tweets.length > 7) {
    out.push(`${tweets.length} tweets — the prompt asks for 4-7.`);
  }
  for (const t of tweets) {
    if (t.length > 280) {
      out.push(`tweet ${t.slice(0, t.indexOf("/") + 1)} is ${t.length} chars — over 280.`);
    }
  }
  return out;
}

/** Compose the X-thread draft from accumulated changes + ledger context. */
export async function draftPost(state: State): Promise<DraftedPost | null> {
  const digest = await buildDigest(state);
  if (!digest.trim()) return null; // nothing worth posting

  const ledger = await fetchLedger();
  const ledgerText = ledger
    .map((l) => `### ${l.path}\n${l.text.slice(0, 8000)}`)
    .join("\n\n");

  let releaseContext = "";
  try {
    releaseContext = (await readFile(RELEASE_CONTEXT_PATH, "utf8")).trim();
  } catch {
    /* no operator context this run — the common case */
  }

  const system = await readFile(SYSTEM_PROMPT_PATH, "utf8");
  const anthropic = new Anthropic({ apiKey: CONFIG.anthropicKey });

  const userMessage = [
    `Code changes since the last update:\n\n${digest}`,
    ledgerText
      ? `\n\nOperational ledger (deployed truth — use to separate shipped vs merged):\n\n${ledgerText}`
      : `\n\n(No ledger context available this run — be conservative about claiming anything is deployed.)`,
    releaseContext
      ? `\n\nOperator-supplied release context (TREAT AS FACT — from the team, not yet in the ledger):\n\n${releaseContext}`
      : "",
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

  const textOf = (r: Anthropic.Message): string =>
    r.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

  let thread = textOf(resp);

  // ONE self-correction pass. "4-7 tweets" and "<= 280 characters" are
  // countable, and the model drifts past both when the cycle is busy: the
  // 2026-09-30 run came back at 8 tweets twice, and an earlier one at 290
  // characters. Handing the violation back is cheaper and more reliable than
  // restating the rule more loudly in the system prompt, and it keeps the
  // prompt the single description of the voice.
  const firstPass = specViolations(thread);
  if (firstPass.length) {
    console.warn(`[compose] SPEC: ${firstPass.join(" ")} — asking for one revision.`);
    const retry = await anthropic.messages.create({
      model: CONFIG.anthropicModel,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: thread },
        {
          role: "user",
          content:
            `That draft breaks the brief: ${firstPass.join(" ")}\n\n` +
            `Rewrite it to comply. Keep the same facts, ordering and voice — ` +
            `merge or cut the weakest item rather than trimming every tweet, ` +
            `and keep the opening hook and the final "More detail:" tweet.`,
        },
      ],
    });
    const revised = textOf(retry);
    const secondPass = specViolations(revised);
    if (revised && secondPass.length <= firstPass.length) thread = revised;
    for (const problem of specViolations(thread)) {
      console.warn(`[compose] SPEC (still): ${problem}`);
    }
  }

  return thread ? { thread, digest } : null;
}
