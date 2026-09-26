import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { cfg, getCliOption, hasCliFlag } from "./src/config.js";
import { isNetworkOrCdpError } from "./src/utils.js";
import { createStagehandModelHandler } from "./src/llm.js";
import { runCommand, startInteractiveCli, printHelp } from "./src/cli.js";
import { startWebServer } from "./src/server.js";
import { setupRouteBlocking } from "./src/browser.js";

async function main() {

  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const isUiMode = hasCliFlag(["--ui", "--web"]);
  const uiPort = parseInt(getCliOption(["--port", "-p"]) || "7788", 10);
  const interactive = hasCliFlag(["-i", "--interactive"]);

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
      a === "--no-headless"
    ) {
      continue;
    }
    if (a === "-c" || a === "--config" || a === "-p" || a === "--port") {
      i++;
      continue;
    }
    if (a.startsWith("-c=") || a.startsWith("--config=") || a.startsWith("-p=") || a.startsWith("--port=")) {
      continue;
    }
    promptTokens.push(a);
  }

  const prompt = promptTokens.join(" ").trim();
  const oneShot = prompt && !interactive && !isUiMode;

  let browser: any;
  let sh: any;

  try {
    console.log("🚀 Launching browser...");
    browser = await localBrowser.launch({ headless: cfg.browser.headless });

    console.log(`🧠 LLM: ${cfg.llm.modelId} @ ${cfg.llm.baseURL}`);
    sh = await Stagehand.create({
      browser,
      model: createStagehandModelHandler(),
      logging: { level: "warn" },
    });
    await setupRouteBlocking(browser.context);
  } catch (err: any) {

    console.error("❌ Initialization error:", err?.message || err);
    process.exit(isNetworkOrCdpError(err) ? 2 : 1);
  }

  const pages = await browser.context.pages();
  const page = pages.length > 0 ? pages[0] : await browser.context.newPage();

  // Mode 1: Web UI Server
  if (isUiMode) {
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
      await sh.close().catch(() => {});
      await browser.close().catch(() => {});
      process.exit(exitCode);
    }
  }

  // Mode 3: Interactive CLI
  await startInteractiveCli(sh, page, prompt);
  await sh.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err?.message || err);
  process.exit(1);
});