import { CONFIG } from "./config.js";
import { composeNow, pollOnce, runDaemon } from "./watcher.js";
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

const args = new Set(process.argv.slice(2));

if (args.has("--compose-now")) {
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
