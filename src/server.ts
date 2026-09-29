import http from "node:http";
import type { Stagehand } from "@browserbasehq/stagehand";
import { cfg, saveConfig, CONFIG_PATH } from "./config.js";
import {
  session,
  addToConversation,
  getConversationContext,
  validateAndResolveAttachments,
  isConversational,
  handleConversational,
  resetSession,
} from "./conversation.js";
import { localClient } from "./llm.js";
import { activePage, captureScreenshotBase64, isDashboardUrl } from "./browser.js";
import { runAgent, fastUrlQuestion } from "./planner.js";
import { runScan } from "./scan.js";
import { ts } from "./utils.js";
import {
  getOrSwitchBrowser,
  getCurrentBrowserMode,
  getActiveSessionState,
  type BrowserMode,
} from "./browser_manager.js";
import {
  detectDefaultBrowser,
  detectAllInstalledBrowsers,
  isCdpActive,
  runBrowserPrecheck,
  launchBrowserWithDebugPort,
} from "./browser_resolver.js";
import { getWebUiHtml } from "./webui.js";

export function startWebServer(sh: Stagehand, page: any, port = 7788): http.Server {
  const sseClients = new Set<http.ServerResponse>();

  let currentSh = sh;
  let currentPage = page;

  function broadcast(event: string, data: any) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {}
    }
  }

  let isAgentRunning = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE endpoint for live logs & screenshot streaming
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "connected", ts: ts() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // API: Browser Status & System Detection
    if (url.pathname === "/api/browser/status" && req.method === "GET") {
      const detected = detectDefaultBrowser();
      const installed = detectAllInstalledBrowsers();
      const cdpRunning = await isCdpActive("127.0.0.1", 9222);
      const mode = getCurrentBrowserMode();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          mode,
          detected,
          installed,
          cdpRunning,
          config: cfg.browser,
          browserName:
            getActiveSessionState()?.browserName ||
            (mode === "own" ? detected?.name || "Desktop Browser" : "Playwright Chromium"),
        })
      );
      return;
    }

    // API: Comprehensive Browser Pre-Check & Diagnostics
    if (url.pathname === "/api/browser/precheck" && req.method === "GET") {
      try {
        const diagnostics = await runBrowserPrecheck(cfg.browser);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(diagnostics));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e?.message || String(e) }));
      }
      return;
    }

    // API: Launch / Attach Arc on Debugging Port 9222
    if (url.pathname === "/api/browser/launch-debug" && req.method === "POST") {
      try {
        const launchRes = await launchBrowserWithDebugPort(cfg.browser.browserBinaryPath, 9222);
        if (launchRes.success) {
          cfg.browser.cdpUrl = launchRes.cdpUrl || "http://127.0.0.1:9222";
          cfg.browser.useOwnBrowser = true;
          saveConfig({ browser: cfg.browser });
          broadcast("browser_switching", { mode: "own", ts: ts() });
          const newSession = await getOrSwitchBrowser("own", { forceRestart: true });
          currentSh = newSession.sh;
          currentPage = newSession.page;
        }
        res.writeHead(launchRes.success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(launchRes));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e?.message || String(e) }));
      }
      return;
    }

    // API: Save Browser Configuration
    if (url.pathname === "/api/browser/settings" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const newBrowser = JSON.parse(body || "{}");
          const mergedBrowser = { ...cfg.browser, ...newBrowser };
          saveConfig({ browser: mergedBrowser });
          cfg.browser = mergedBrowser;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", config: cfg.browser }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Switch Browser Mode (Clean vs Own)
    if (url.pathname === "/api/browser/mode" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { mode } = JSON.parse(body || "{}");
          if (mode !== "clean" && mode !== "own") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid mode. Use 'clean' or 'own'." }));
            return;
          }
          broadcast("browser_switching", { mode, ts: ts() });
          const newSession = await getOrSwitchBrowser(mode as BrowserMode);
          currentSh = newSession.sh;
          currentPage = newSession.page;
          const activePg = await activePage(currentSh, currentPage);
          const screenshot = await captureScreenshotBase64(activePg);
          const currentTitle = await activePg.title().catch(() => "");
          broadcast("browser_switched", {
            mode,
            browserName: newSession.browserName,
            title: currentTitle,
            screenshot,
            ts: ts(),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "switched", mode, browserName: newSession.browserName }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e?.message || String(e) }));
        }
      });
      return;
    }

    // API: Current state
    if (url.pathname === "/api/status" && req.method === "GET") {
      const activePg = await activePage(currentSh, currentPage);
      const currentUrl = await activePg.url().catch(() => "about:blank");
      const currentTitle = await activePg.title().catch(() => "");
      const screenshot = await captureScreenshotBase64(activePg);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          running: isAgentRunning,
          page: { url: currentUrl, title: currentTitle, screenshot },
          config: cfg,
          browserMode: getCurrentBrowserMode(),
          history: session.history,
          conversation: session.conversation,
          attachedFiles: session.attachedFiles,
        })
      );
      return;
    }

    // API: Screenshot capture
    if (url.pathname === "/api/screenshot" && req.method === "GET") {
      const activePg = await activePage(currentSh, currentPage);
      const screenshot = await captureScreenshotBase64(activePg);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ screenshot }));
      return;
    }

    // API: Run Agent prompt
    if (url.pathname === "/api/run" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { prompt, mode, browserMode } = JSON.parse(body || "{}");
          if (!prompt) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing prompt" }));
            return;
          }

          // Precondition Validation: Verify any referenced attachments at parse time
          const attachCheck = await validateAndResolveAttachments(prompt);
          if (!attachCheck.ok) {
            const errorMsg = attachCheck.error || "Missing referenced attachment";
            broadcast("agent_error", { error: errorMsg, ts: ts() });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: errorMsg }));
            return;
          }
          const resolvedPrompt = attachCheck.resolvedInput;

          if (isAgentRunning) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "An agent task is already running" }));
            return;
          }

          // Switch browser if requested mode differs from active mode
          if (browserMode && (browserMode === "clean" || browserMode === "own") && browserMode !== getCurrentBrowserMode()) {
            broadcast("browser_switching", { mode: browserMode, ts: ts() });
            const newSession = await getOrSwitchBrowser(browserMode);
            currentSh = newSession.sh;
            currentPage = newSession.page;
          }

          isAgentRunning = true;
          broadcast("agent_start", { prompt: resolvedPrompt, mode, browserMode: getCurrentBrowserMode(), ts: ts() });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "started", prompt: resolvedPrompt }));

          // Execute agent asynchronously and stream steps
          (async () => {
            const activePg = await activePage(currentSh, currentPage);
            try {
              addToConversation({ role: "user", content: resolvedPrompt, label: "user_goal" });

              if (isConversational(resolvedPrompt)) {
                await handleConversational(
                  resolvedPrompt.replace(/^(think|ask)\s+/i, ""),
                  localClient
                );
                const finalScreenshot = await captureScreenshotBase64(activePg);
                broadcast("agent_done", {
                  prompt: resolvedPrompt,
                  result: session.lastAnswer || "Done",
                  screenshot: finalScreenshot,
                  ts: ts(),
                });
                return;
              }

              const result = await runAgent(resolvedPrompt, currentSh, activePg, (stepInfo) => {
                broadcast("agent_step", { ...stepInfo, ts: ts() });
              });

              const finalScreenshot = await captureScreenshotBase64(activePg);
              broadcast("agent_done", { prompt: resolvedPrompt, result: result || "Done", screenshot: finalScreenshot, ts: ts() });
            } catch (err: any) {
              broadcast("agent_error", { error: err?.message || String(err), ts: ts() });
            } finally {
              isAgentRunning = false;
            }
          })();
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Fast URL extraction
    if (url.pathname === "/api/extract" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { url: targetUrl, query } = JSON.parse(body || "{}");
          const activePg = await activePage(currentSh, currentPage);
          broadcast("extract_start", { url: targetUrl, query });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "extracting" }));

          (async () => {
            try {
              await fastUrlQuestion(targetUrl, query, currentSh, activePg, (info) => {
                broadcast("agent_step", { ...info, maxSteps: 3, plan: { action: "extract", instruction: query } });
              });
              const screenshot = await captureScreenshotBase64(activePg);
              broadcast("extract_done", {
                answer: session.lastAnswer,
                extraction: session.lastExtraction,
                screenshot,
              });
            } catch (e: any) {
              broadcast("agent_error", { error: e.message });
            }
          })();
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Save LLM & Agent config
    if (url.pathname === "/api/config" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const newCfg = JSON.parse(body || "{}");
          saveConfig(newCfg);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", config: cfg }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Clear session memory (conversation, history, extraction)
    if (url.pathname === "/api/clear" && req.method === "POST") {
      resetSession();
      broadcast("session_cleared", { ts: new Date().toISOString() });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "cleared", message: "Session memory cleared. Attached files kept." }));
      return;
    }

    // Serve HTML Web UI
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getWebUiHtml(cfg));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`\n🌐 Stagehand Web UI active at \x1b[4mhttp://127.0.0.1:${port}\x1b[0m`);
    console.log(`   Press Ctrl+C to stop | Close terminal = session keeps running`);
    console.log(`   Reconnect anytime: npx tsx index.ts --reconnect\n`);
  });

  return server;
}
