import { cfg, getCliOption, hasCliFlag } from "./src/config.js";
import { isNetworkOrCdpError } from "./src/utils.js";
import { runCommand, startInteractiveCli, printHelp } from "./src/cli.js";
import { startWebServer } from "./src/server.js";
import { getOrSwitchBrowser, closeActiveBrowserSession } from "./src/browser_manager.js";
import {
  writeSessionInfo, getActiveSession, ignoreSighup,
  registerCleanup, clearSessionInfo,
} from "./src/session.js";

async function main() {

  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // ── status: check if a session is already running ──────────────────────────
  if (args.includes("status") || args.includes("--status")) {
    const active = await getActiveSession();
    if (active) {
      const age = Math.round((Date.now() - new Date(active.startedAt).getTime()) / 60000);
      console.log(`\n✅ Session running (PID ${active.pid}, started ${age}m ago)`);
      console.log(`   Web UI: ${active.url}`);
      console.log(`   Last active: ${new Date(active.lastActiveAt).toLocaleTimeString()}`);
      console.log(`\n   Reconnect: open ${active.url} in your browser`);
      console.log(`   Or run:    npx tsx index.ts --reconnect\n`);
    } else {
      console.log("\n⚪ No active session found.\n");
      console.log("   Start one with:  npx tsx index.ts --ui\n");
    }
    process.exit(0);
  }

  // ── reconnect: open existing session UI in browser ─────────────────────────
  if (args.includes("--reconnect") || args.includes("reconnect")) {
    const active = await getActiveSession();
    if (active) {
      const age = Math.round((Date.now() - new Date(active.startedAt).getTime()) / 60000);
      console.log(`\n✅ Reconnecting to session (PID ${active.pid}, started ${age}m ago)`);
      console.log(`   Web UI: ${active.url}`);
      console.log(`\n   Opening in browser...\n`);
      // Open the URL in the default browser
      const { exec } = await import("node:child_process");
      exec(`open "${active.url}" 2>/dev/null || xdg-open "${active.url}" 2>/dev/null || start "${active.url}"`);
      // Also print for terminal copy-paste
      console.log(`   If browser didn't open, navigate to: ${active.url}\n`);
    } else {
      console.log("\n⚪ No active session found. Start one with:\n");
      console.log("   npx tsx index.ts --ui\n");
    }
    process.exit(0);
  }

  const isUiMode = hasCliFlag(["--ui", "--web"]);
  const uiPort = parseInt(getCliOption(["--port", "-p"]) || "7788", 10);
  const interactive = hasCliFlag(["-i", "--interactive"]);

  if (args.includes("precheck") || args.includes("--precheck") || args.includes("doctor")) {
    const { runBrowserPrecheck } = await import("./src/browser_resolver.js");
    console.log("\n🔍 Running Stagehand Browser Diagnostics & Pre-Check...\n");
    const res = await runBrowserPrecheck(cfg.browser);
    console.log(`Browser: ${res.browserName} (${res.isOsDefault ? "OS Default" : "Custom"})`);
    console.log(`Binary:  ${res.binaryPath}`);
    console.log(`Profile: ${res.userDataDir}`);
    console.log(`Overall: ${res.ok ? "✅ READY TO USE" : "⚠️ NEEDS ATTENTION"}\n`);
    for (const t of res.tests) {
      const icon = t.status === "pass" ? "✅" : t.status === "warn" ? "⚠️" : "❌";
      console.log(`  ${icon} [${t.status.toUpperCase()}] ${t.name}: ${t.message}`);
      if (t.fixHint) console.log(`     💡 Fix hint: ${t.fixHint}`);
    }
    if (res.recommendations.length > 0) {
      console.log("\n💡 Recommendations:");
      res.recommendations.forEach((r) => console.log(`   - ${r}`));
    }
    console.log("");
    process.exit(res.ok ? 0 : 1);
  }

  // Extract prompt tokens
  const promptTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (
      a === "-i" ||
      a === "--interactive" ||
      a === "--ui" ||
      a === "--web" ||
      a === "-h" ||
      a === "--help" ||
      a === "--headless" ||
      a === "--headed" ||
      a === "--no-headless" ||
      a === "--use-own-browser" ||
      a === "--my-browser" ||
      a === "--own-browser" ||
      a === "--keep-browser-open" ||
      a === "--disable-security"
    ) {
      continue;
    }
    if (a === "-c" || a === "--config" || a === "-p" || a === "--port" || a === "--cdp" || a === "--cdp-url" || a === "--wss") {
      i++;
      continue;
    }
    if (
      a.startsWith("-c=") ||
      a.startsWith("--config=") ||
      a.startsWith("-p=") ||
      a.startsWith("--port=") ||
      a.startsWith("--cdp=") ||
      a.startsWith("--wss=")
    ) {
      continue;
    }
    promptTokens.push(a);
  }

  const prompt = promptTokens.join(" ").trim();
  const oneShot = prompt && !interactive && !isUiMode;

  let sessionState: any;
  try {
    sessionState = await getOrSwitchBrowser();
  } catch (err: any) {
    console.error("❌ Initialization error:", err?.message || err);
    process.exit(isNetworkOrCdpError(err) ? 2 : 1);
  }

  const { browser, sh, page } = sessionState;

  // Mode 1: Web UI Server
  if (isUiMode) {
    // Write session info + survive terminal close (SIGHUP)
    writeSessionInfo(uiPort);
    ignoreSighup();
    registerCleanup(closeActiveBrowserSession);
    startWebServer(sh, page, uiPort);
    if (prompt) {
      try {
        await runCommand(prompt, sh, page);
      } catch (e: any) {
        console.error("❌", e?.message || e);
      }
    }
    return;
  }

  // Mode 2: One-shot CLI command execution
  if (oneShot) {
    let exitCode = 0;
    try {
      const ok = await runCommand(prompt, sh, page);
      if (!ok) exitCode = 1;
    } catch (e: any) {
      console.error("❌", e?.message || e);
      exitCode = isNetworkOrCdpError(e) ? 2 : 1;
    } finally {
      await closeActiveBrowserSession();
      process.exit(exitCode);
    }
  }

  // Mode 3: Interactive CLI
  await startInteractiveCli(sh, page, prompt);
  await closeActiveBrowserSession();
  process.exit(0);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err?.message || err);
  process.exit(1);
});