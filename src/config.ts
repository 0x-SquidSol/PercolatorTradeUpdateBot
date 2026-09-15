import "dotenv/config";

export interface RepoConfig {
  owner: string;
  name: string;
  /** What this repo is, so the drafter can explain impact accurately. */
  role: string;
  /** On-chain program vs off-chain service/lib — colours how we frame impact. */
  onchain: boolean;
}

/**
 * The in-scope dcccrypto repos we track, from
 * dcccrypto/percolator-ops/ledger/audit-scope.md (§2, the nine-repo scope),
 * minus the decommissioned percolator-api, plus the deployed-but-uncounted
 * matcher (its real remote is `percolator-match`, not `percolator-matcher`).
 *
 * NOT tracked, on purpose:
 *  - aeyakovenko/percolator[-prog]  → upstream baseline, never deployed by dcccrypto
 *  - 0x-SquidSol/percolator-keeper  → a different, out-of-scope repo (not the live keeper)
 *
 * Candidate (ambiguous — a dcccrypto/percolator-vault clone exists locally but
 * isn't in the nine): add here if you decide it's shipping code.
 */
export const TRACKED_REPOS: RepoConfig[] = [
  { owner: "dcccrypto", name: "percolator", role: "Risk engine (path-dep, compiled into the wrapper)", onchain: true },
  { owner: "dcccrypto", name: "percolator-prog", role: "On-chain wrapper program", onchain: true },
  { owner: "dcccrypto", name: "percolator-stake", role: "Insurance/backing vault & LP shares (StakePool)", onchain: true },
  { owner: "dcccrypto", name: "percolator-nft", role: "Position-NFT program; recovery/emergency-burn", onchain: true },
  { owner: "dcccrypto", name: "percolator-match", role: "On-chain matcher (deployed; scope TBD)", onchain: true },
  { owner: "dcccrypto", name: "percolator-sdk", role: "TypeScript SDK (@percolatorct/sdk)", onchain: false },
  { owner: "dcccrypto", name: "percolator-indexer", role: "Candles/trades/stats indexer service", onchain: false },
  { owner: "dcccrypto", name: "percolator-launch", role: "Frontend monorepo (playground/marketing/price-ws)", onchain: false },
  { owner: "dcccrypto", name: "percolator-oracle-keeper", role: "The live keeper — prices markets & cranks", onchain: false },
];

/**
 * Not a headline change-source, but the operational source of truth. We read
 * these ledger files at compose time so the drafter knows what actually
 * deployed, what's merged-but-unshipped, and the review verdicts — the raw
 * material for accurate "how it affects" analysis.
 */
export const OPS_LEDGER = {
  owner: "dcccrypto",
  name: "percolator-ops",
  files: [
    "ledger/deployments.md",
    "ledger/releases.md",
    "ledger/prs.md",
    "ledger/findings.md",
  ],
};

function num(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(envVar: string, fallback: boolean): boolean {
  const raw = process.env[envVar];
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() === "true";
}

export const CONFIG = {
  githubToken: process.env.GITHUB_TOKEN ?? "",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
  pollIntervalSeconds: num("POLL_INTERVAL_SECONDS", 300),
  postIntervalDays: num("POST_INTERVAL_DAYS", 2),
  draftsDir: process.env.DRAFTS_DIR ?? "drafts",
  gitCommitDrafts: bool("GIT_COMMIT_DRAFTS", false),
  /** Cap on diff/PR text handed to the model per compose, to bound cost. */
  maxDigestChars: num("MAX_DIGEST_CHARS", 60_000),
};
