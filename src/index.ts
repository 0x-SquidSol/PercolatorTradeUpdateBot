import { CONFIG } from "./config.js";
import { backfill, composeNow, pollOnce, runDaemon } from "./watcher.js";
import { loadState } from "./state.js";

function requireSecrets(needAnthropic: boolean): void {
  const missing: string[] = [];
  if (!CONFIG.githubToken) missing.push("GITHUB_TOKEN");
  if (needAnthropic && !CONFIG.anthropicKey) missing.push("ANTHROPIC_API_KEY");
  if (missing.length) {
    console.error(`[dcc-watch] missing env: ${missing.join(", ")} (see .env.example)`);
    process.exit(1);
  }
}

const argv = process.argv.slice(2);
const args = new Set(argv);

function flagValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("-")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

if (args.has("--backfill") || argv.some((a) => a.startsWith("--backfill="))) {
  // Seed pending from the last N days (default 7), then draft immediately.
  requireSecrets(true);
  const days = Number(flagValue("--backfill") ?? "7") || 7;
  const state = await loadState();
  const n = await backfill(state, days);
  console.log(`Backfilled ${n} change(s) from the last ${days}d.`);
  const path = await composeNow(state);
  console.log(path ? `Drafted: ${path}` : "Nothing worth drafting.");
} else if (args.has("--compose-now")) {
  // Draft immediately from whatever is pending — for testing the writer.
  requireSecrets(true);
  const state = await loadState();
  const path = await composeNow(state);
  console.log(path ? `Drafted: ${path}` : "Nothing to draft.");
} else if (args.has("--once")) {
  // Single poll pass, no drafting — for testing the watcher / cron use.
  requireSecrets(false);
  const state = await loadState();
  const n = await pollOnce(state);
  console.log(`Poll complete: ${n} new change(s) recorded.`);
} else {
  requireSecrets(true);
  await runDaemon();
}
