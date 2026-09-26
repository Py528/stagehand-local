import http from "node:http";
import type { Stagehand } from "@browserbasehq/stagehand";
import { cfg, saveConfig, CONFIG_PATH } from "./config.js";
import { session, addToConversation, getConversationContext } from "./conversation.js";
import { activePage, captureScreenshotBase64 } from "./browser.js";
import { runAgent, fastUrlQuestion } from "./planner.js";
import { runScan } from "./scan.js";
import { ts } from "./utils.js";

export function startWebServer(sh: Stagehand, page: any, port = 7788): http.Server {
  const sseClients = new Set<http.ServerResponse>();

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

    // API: Current state
    if (url.pathname === "/api/status" && req.method === "GET") {
      const activePg = await activePage(sh, page);
      const currentUrl = await activePg.url().catch(() => "about:blank");
      const currentTitle = await activePg.title().catch(() => "");
      const screenshot = await captureScreenshotBase64(activePg);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          running: isAgentRunning,
          page: { url: currentUrl, title: currentTitle, screenshot },
          config: cfg,
          history: session.history,
          conversation: session.conversation,
          attachedFiles: session.attachedFiles,
        })
      );
      return;
    }

    // API: Screenshot capture
    if (url.pathname === "/api/screenshot" && req.method === "GET") {
      const activePg = await activePage(sh, page);
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
          const { prompt, mode } = JSON.parse(body || "{}");
          if (!prompt) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing prompt" }));
            return;
          }

          if (isAgentRunning) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "An agent task is already running" }));
            return;
          }

          isAgentRunning = true;
          broadcast("agent_start", { prompt, mode, ts: ts() });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "started", prompt }));

          // Execute agent asynchronously and stream steps
          (async () => {
            const activePg = await activePage(sh, page);
            try {
              addToConversation({ role: "user", content: prompt, label: "user_goal" });
              const result = await runAgent(prompt, sh, activePg, (stepInfo) => {
                broadcast("agent_step", { ...stepInfo, ts: ts() });
              });

              const finalScreenshot = await captureScreenshotBase64(activePg);
              broadcast("agent_done", { prompt, result: result || "Done", screenshot: finalScreenshot, ts: ts() });
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
          const activePg = await activePage(sh, page);
          broadcast("extract_start", { url: targetUrl, query });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "extracting" }));

          (async () => {
            try {
              await fastUrlQuestion(targetUrl, query, sh, activePg, (info) => {
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

    // API: Save config
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

    // Serve HTML Web UI
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getWebUiHtml());
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`\n🌐 Stagehand Web UI active at http://127.0.0.1:${port}`);
  });

  return server;
}

function getWebUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stagehand Local — Web Agent Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(22, 30, 49, 0.7);
      --card-border: rgba(255, 255, 255, 0.08);
      --accent: #3b82f6;
      --accent-glow: rgba(59, 130, 246, 0.35);
      --accent-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --input-bg: rgba(15, 23, 42, 0.8);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Outfit', sans-serif;
      background: radial-gradient(circle at 10% 20%, rgba(37, 99, 235, 0.12) 0%, transparent 40%),
                  radial-gradient(circle at 90% 80%, rgba(139, 92, 246, 0.12) 0%, transparent 40%),
                  var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      backdrop-filter: blur(12px);
      background: rgba(11, 15, 25, 0.8);
      border-bottom: 1px solid var(--card-border);
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 700;
      font-size: 1.25rem;
      letter-spacing: -0.02em;
    }
    .badge {
      font-size: 0.75rem;
      padding: 0.2rem 0.6rem;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }
    .status-dot.busy {
      background: var(--warning);
      box-shadow: 0 0 8px var(--warning);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    main {
      flex: 1;
      padding: 1.5rem 2rem;
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 1.5rem;
      max-width: 1700px;
      margin: 0 auto;
      width: 100%;
    }
    .tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 0.5rem;
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-family: inherit;
      font-size: 0.95rem;
      font-weight: 500;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab-btn:hover { color: var(--text); background: rgba(255, 255, 255, 0.05); }
    .tab-btn.active {
      color: white;
      background: var(--accent);
      box-shadow: 0 0 15px var(--accent-glow);
    }
    .panel {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    }
    .tab-content { display: none; flex-direction: column; gap: 1.25rem; }
    .tab-content.active { display: flex; }
    .input-group {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    label {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-muted);
    }
    input, textarea, select {
      background: var(--input-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      font-family: inherit;
      padding: 0.75rem 1rem;
      border-radius: 10px;
      font-size: 0.95rem;
      outline: none;
      transition: all 0.2s;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    textarea { resize: vertical; min-height: 90px; }
    .btn-primary {
      background: var(--accent);
      color: white;
      border: none;
      padding: 0.8rem 1.5rem;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: all 0.2s;
      box-shadow: 0 4px 14px var(--accent-glow);
    }
    .btn-primary:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-height: 480px;
      overflow-y: auto;
      padding-right: 0.5rem;
    }
    .step-item {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 0.8rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    .step-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
      font-weight: 600;
      color: #60a5fa;
    }
    .step-desc { font-size: 0.9rem; }
    .step-result {
      font-size: 0.85rem;
      color: var(--text-muted);
      background: rgba(0, 0, 0, 0.2);
      padding: 0.4rem 0.6rem;
      border-radius: 6px;
      font-family: 'JetBrains Mono', monospace;
    }
    .preview-card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .preview-header {
      padding: 0.75rem 1.25rem;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(15, 23, 42, 0.4);
    }
    .preview-title {
      font-size: 0.9rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 80%;
    }
    .preview-body {
      flex: 1;
      min-height: 400px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
      position: relative;
    }
    .preview-img {
      max-width: 100%;
      max-height: 520px;
      object-fit: contain;
    }
    .console-logs {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      background: rgba(0, 0, 0, 0.4);
      padding: 0.75rem;
      border-radius: 8px;
      max-height: 160px;
      overflow-y: auto;
      color: #93c5fd;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>🚀 Stagehand</span>
      <span class="badge">Local Web Agent</span>
    </div>
    <div class="status-indicator">
      <div id="status-dot" class="status-dot"></div>
      <span id="status-text">Ready</span>
    </div>
  </header>

  <main>
    <div class="panel">
      <div class="tabs">
        <button class="tab-btn active" onclick="switchTab('agent')">🤖 Agent Goal</button>
        <button class="tab-btn" onclick="switchTab('extract')">🔍 Quick Extract</button>
        <button class="tab-btn" onclick="switchTab('scan')">📋 Batch Scan</button>
        <button class="tab-btn" onclick="switchTab('settings')">⚙️ Settings</button>
      </div>

      <!-- Agent Tab -->
      <div id="tab-agent" class="tab-content active">
        <div class="input-group">
          <label for="agent-prompt">Goal or Natural Language Instruction</label>
          <textarea id="agent-prompt" placeholder="e.g. go to youtube and play crown by txt and skip 1 min ahead of the video"></textarea>
        </div>
        <button id="run-btn" class="btn-primary" onclick="runAgentGoal()">
          <span>▶</span> Execute Agent Goal
        </button>

        <label>Live Execution Steps</label>
        <div id="timeline" class="timeline">
          <div class="step-item">
            <div class="step-header">Ready</div>
            <div class="step-desc">Enter a goal above and click Execute.</div>
          </div>
        </div>
      </div>

      <!-- Extract Tab -->
      <div id="tab-extract" class="tab-content">
        <div class="input-group">
          <label for="extract-url">Target URL</label>
          <input type="text" id="extract-url" placeholder="https://news.ycombinator.com">
        </div>
        <div class="input-group">
          <label for="extract-query">What to extract?</label>
          <input type="text" id="extract-query" placeholder="Top 5 story titles and links">
        </div>
        <button id="extract-btn" class="btn-primary" onclick="runExtract()">
          <span>🔍</span> Extract & Synthesize
        </button>
        <div id="extract-result" class="step-result" style="display:none; white-space: pre-wrap; margin-top: 1rem;"></div>
      </div>

      <!-- Batch Scan Tab -->
      <div id="tab-scan" class="tab-content">
        <div class="input-group">
          <label>CSV Input File Path</label>
          <input type="text" id="scan-csv" placeholder="companies.csv">
        </div>
        <div class="input-group">
          <label>URL Column Name</label>
          <input type="text" id="scan-col" placeholder="website">
        </div>
        <div class="input-group">
          <label>Extraction Instruction</label>
          <input type="text" id="scan-instr" placeholder="extract company mission and pricing">
        </div>
        <div class="input-group">
          <label>Output CSV Path</label>
          <input type="text" id="scan-out" placeholder="results.csv">
        </div>
        <button class="btn-primary" onclick="alert('Run from CLI: scan <csv> <col> <instr>')">
          <span>📋</span> Start Batch Scan
        </button>
      </div>

      <!-- Settings Tab -->
      <div id="tab-settings" class="tab-content">
        <div class="input-group">
          <label>LLM Base URL</label>
          <input type="text" id="cfg-llm-url" value="${cfg.llm.baseURL}">
        </div>
        <div class="input-group">
          <label>Model ID</label>
          <input type="text" id="cfg-llm-model" value="${cfg.llm.modelId}">
        </div>
        <div class="input-group">
          <label>Temperature</label>
          <input type="number" step="0.05" id="cfg-llm-temp" value="${cfg.llm.temperature}">
        </div>
        <div class="input-group">
          <label>Max Agent Steps</label>
          <input type="number" id="cfg-agent-steps" value="${cfg.agent.maxSteps}">
        </div>
        <button class="btn-primary" onclick="saveSettings()">
          <span>💾</span> Save Settings
        </button>
      </div>
    </div>

    <!-- Right Side: Live Browser Preview & Logs -->
    <div class="preview-card">
      <div class="preview-header">
        <div class="preview-title" id="page-title">Browser View (Waiting)</div>
        <button class="badge" onclick="refreshScreenshot()" style="cursor:pointer; background:rgba(255,255,255,0.1); border:none; color:white;">🔄 Refresh</button>
      </div>
      <div class="preview-body">
        <img id="preview-image" class="preview-img" src="" alt="Browser screenshot" style="display:none;">
        <div id="preview-placeholder" style="color:var(--text-muted); font-size:0.9rem;">No screenshot available yet</div>
      </div>
      <div style="padding: 1rem;">
        <label style="margin-bottom:0.4rem; display:block;">Agent Console</label>
        <div id="console-logs" class="console-logs">System initialized. Connected to local LLM.</div>
      </div>
    </div>
  </main>

  <script>
    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('tab-' + name).classList.add('active');
    }

    function appendLog(msg) {
      const el = document.getElementById('console-logs');
      el.innerText += '\\n' + msg;
      el.scrollTop = el.scrollHeight;
    }

    function updateScreenshot(base64) {
      if (!base64) return;
      const img = document.getElementById('preview-image');
      const ph = document.getElementById('preview-placeholder');
      img.src = 'data:image/jpeg;base64,' + base64;
      img.style.display = 'block';
      ph.style.display = 'none';
    }

    async function refreshScreenshot() {
      try {
        const res = await fetch('/api/screenshot');
        const data = await res.json();
        if (data.screenshot) updateScreenshot(data.screenshot);
      } catch {}
    }

    async function runAgentGoal() {
      const prompt = document.getElementById('agent-prompt').value.trim();
      if (!prompt) return;
      document.getElementById('run-btn').disabled = true;
      document.getElementById('status-dot').className = 'status-dot busy';
      document.getElementById('status-text').innerText = 'Running Agent...';

      const timeline = document.getElementById('timeline');
      timeline.innerHTML = '<div class="step-item"><div class="step-header">Started</div><div class="step-desc">' + prompt + '</div></div>';

      await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
    }

    async function runExtract() {
      const url = document.getElementById('extract-url').value.trim();
      const query = document.getElementById('extract-query').value.trim();
      if (!url || !query) return;
      document.getElementById('extract-btn').disabled = true;
      appendLog('Extracting: ' + query + ' from ' + url);

      await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, query })
      });
    }

    async function saveSettings() {
      const payload = {
        llm: {
          baseURL: document.getElementById('cfg-llm-url').value.trim(),
          modelId: document.getElementById('cfg-llm-model').value.trim(),
          temperature: parseFloat(document.getElementById('cfg-llm-temp').value) || 0.1
        },
        agent: {
          maxSteps: parseInt(document.getElementById('cfg-agent-steps').value, 10) || 10
        }
      };
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      alert('Settings saved!');
    }

    // SSE Stream setup
    const evt = new EventSource('/api/events');
    evt.addEventListener('agent_step', (e) => {
      const data = JSON.parse(e.data);
      const timeline = document.getElementById('timeline');
      const div = document.createElement('div');
      div.className = 'step-item';
      div.innerHTML = '<div class="step-header">Step ' + data.step + '/' + data.maxSteps + ' • ' + (data.plan.action || 'act') + '</div>' +
                      '<div class="step-desc">' + (data.plan.instruction || data.plan.url || data.title) + '</div>' +
                      (data.result ? '<div class="step-result">' + data.result + '</div>' : '');
      timeline.appendChild(div);
      timeline.scrollTop = timeline.scrollHeight;
      appendLog('[' + data.step + '] ' + (data.plan.instruction || data.plan.action));
      if (data.screenshot) updateScreenshot(data.screenshot);
      if (data.title) document.getElementById('page-title').innerText = data.title;
    });

    evt.addEventListener('agent_done', (e) => {
      const data = JSON.parse(e.data);
      document.getElementById('run-btn').disabled = false;
      document.getElementById('status-dot').className = 'status-dot';
      document.getElementById('status-text').innerText = 'Ready';
      appendLog('Goal completed: ' + data.result);
      if (data.screenshot) updateScreenshot(data.screenshot);
    });

    evt.addEventListener('extract_done', (e) => {
      const data = JSON.parse(e.data);
      document.getElementById('extract-btn').disabled = false;
      const resEl = document.getElementById('extract-result');
      resEl.style.display = 'block';
      resEl.innerText = data.answer || data.extraction || 'No data extracted';
      if (data.screenshot) updateScreenshot(data.screenshot);
    });

    refreshScreenshot();
  </script>
</body>
</html>`;
}
