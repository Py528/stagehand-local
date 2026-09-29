/**
 * webui.ts — Web UI HTML template
 *
 * Extracted from server.ts to keep that file focused on HTTP routing.
 * The HTML uses TypeScript template literal interpolation for cfg values.
 */

import type { Config } from "./types.js";

export function getWebUiHtml(cfg: Config): string {
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
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.2); }
    }
    main {
      flex: 1;
      padding: 1.5rem 2rem;
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 1.5rem;
      max-width: 1700px;
      margin: 0 auto;
      width: 100%;
    }
    @media (max-width: 1024px) {
      main { grid-template-columns: 1fr; }
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .tabs {
      display: flex;
      gap: 0.4rem;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 0.5rem;
      flex-wrap: wrap;
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-family: inherit;
      font-size: 0.88rem;
      font-weight: 500;
      padding: 0.45rem 0.85rem;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab-btn:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.04);
    }
    .tab-btn.active {
      color: white;
      background: rgba(59, 130, 246, 0.15);
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .tab-content { display: none; }
    .tab-content.active { display: flex; flex-direction: column; gap: 1rem; }

    /* Browser Mode Radio Card Toggle */
    .browser-mode-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 0.85rem 1rem;
      margin-bottom: 0.25rem;
    }
    .browser-mode-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.6rem;
    }
    .browser-mode-title {
      font-size: 0.82rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #93c5fd;
    }
    .detected-browser-pill {
      font-size: 0.72rem;
      padding: 0.2rem 0.6rem;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      font-family: 'JetBrains Mono', monospace;
    }
    .detected-browser-pill.warn {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.3);
    }
    .radio-card-group {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    @media (max-width: 600px) {
      .radio-card-group { grid-template-columns: 1fr; }
    }
    .radio-card {
      display: flex;
      align-items: flex-start;
      gap: 0.65rem;
      padding: 0.7rem 0.85rem;
      border-radius: 8px;
      border: 1px solid var(--card-border);
      background: rgba(0, 0, 0, 0.25);
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
    }
    .radio-card:hover {
      border-color: rgba(59, 130, 246, 0.4);
      background: rgba(59, 130, 246, 0.05);
    }
    .radio-card input[type="radio"] {
      margin-top: 0.2rem;
      accent-color: #3b82f6;
      cursor: pointer;
    }
    .radio-card.active {
      border-color: #3b82f6;
      background: rgba(59, 130, 246, 0.12);
      box-shadow: 0 0 12px rgba(59, 130, 246, 0.2);
    }
    .radio-card-content {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }
    .radio-title {
      font-size: 0.88rem;
      font-weight: 600;
      color: #f3f4f6;
    }
    .radio-desc {
      font-size: 0.75rem;
      color: var(--text-muted);
      line-height: 1.25;
    }

    /* Browser Info & Diagnostics */
    .browser-info-card {
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 1rem;
    }
    .quick-pick-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--text);
      padding: 0.35rem 0.75rem;
      border-radius: 8px;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .quick-pick-btn:hover {
      background: rgba(59, 130, 246, 0.2);
      border-color: #3b82f6;
    }
    .toggle-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    @media (max-width: 600px) {
      .toggle-grid { grid-template-columns: 1fr; }
    }
    .checkbox-card {
      display: flex;
      align-items: flex-start;
      gap: 0.65rem;
      padding: 0.75rem 0.9rem;
      border-radius: 10px;
      border: 1px solid var(--card-border);
      background: rgba(15, 23, 42, 0.5);
      cursor: pointer;
      user-select: none;
      transition: all 0.2s;
    }
    .checkbox-card:hover {
      background: rgba(59, 130, 246, 0.06);
      border-color: rgba(59, 130, 246, 0.3);
    }
    .checkbox-card input[type="checkbox"] {
      margin-top: 0.2rem;
      accent-color: #3b82f6;
      cursor: pointer;
    }
    .chk-title {
      font-size: 0.88rem;
      font-weight: 600;
      color: #f3f4f6;
    }
    .chk-desc {
      font-size: 0.72rem;
      color: var(--text-muted);
      line-height: 1.25;
    }
    .field-hint {
      font-size: 0.72rem;
      color: var(--text-muted);
      margin-top: 0.2rem;
    }
    .precheck-card {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 0.9rem;
    }
    .precheck-test-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.45rem 0.6rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-size: 0.8rem;
    }
    .precheck-test-item:last-child { border-bottom: none; }
    .status-badge {
      font-size: 0.7rem;
      font-family: 'JetBrains Mono', monospace;
      padding: 0.15rem 0.45rem;
      border-radius: 6px;
    }
    .status-badge.pass { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .status-badge.warn { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .status-badge.fail { background: rgba(239, 68, 68, 0.2); color: #f87171; }

    .input-group {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
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
        <button class="tab-btn" onclick="switchTab('browser')">🌐 Browser Settings</button>
        <button class="tab-btn" onclick="switchTab('settings')">⚙️ Agent Settings</button>
      </div>

      <!-- Agent Tab -->
      <div id="tab-agent" class="tab-content active">
        <!-- Browser Mode Radio Toggle -->
        <div class="browser-mode-card">
          <div class="browser-mode-header">
            <span class="browser-mode-title">🌐 Active Browser Mode</span>
            <span id="detected-browser-pill" class="detected-browser-pill">🔍 Detecting...</span>
          </div>
          <div class="radio-card-group">
            <label class="radio-card active" id="mode-clean-card" onclick="selectBrowserMode('clean')">
              <input type="radio" name="browser-mode" id="radio-mode-clean" value="clean" checked onchange="selectBrowserMode('clean')">
              <div class="radio-card-content">
                <div class="radio-title">🌐 Clean Browser</div>
                <div class="radio-desc">Fresh isolated Chromium instance (No accounts)</div>
              </div>
            </label>
            <label class="radio-card" id="mode-own-card" onclick="selectBrowserMode('own')">
              <input type="radio" name="browser-mode" id="radio-mode-own" value="own" onchange="selectBrowserMode('own')">
              <div class="radio-card-content">
                <div class="radio-title">👤 My Default Browser</div>
                <div class="radio-desc" id="own-browser-sublabel">Uses Arc with your existing Google logins & saved passwords</div>
              </div>
            </label>
          </div>
        </div>

        <div class="input-group">
          <label for="agent-prompt">Goal or Natural Language Instruction</label>
          <textarea id="agent-prompt" placeholder="e.g. go to youtube and play crown by txt and skip 1 min ahead of the video"></textarea>
        </div>
        <button id="run-btn" class="btn-primary" onclick="runAgentGoal()">
          <span>▶</span> Execute Agent Goal
        </button>
        <button id="clear-btn" onclick="clearMemory()" style="background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); color:#f87171; padding:0.6rem 1.2rem; border-radius:10px; font-size:0.88rem; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:0.4rem; transition:all 0.2s;" title="Clear session memory so the next task starts fresh">
          🧹 Clear Memory
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

      <!-- Browser Settings Tab (Browser-Use Style) -->
      <div id="tab-browser" class="tab-content">
        <!-- Top Banner: Detected Browser & Quick Selectors -->
        <div class="browser-info-card">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <h3 id="detected-browser-name" style="font-size:1.05rem; font-weight:600; color:#93c5fd;">🌐 Detected: Arc</h3>
              <p id="detected-browser-detail" style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">Primary desktop browser with logins & saved passwords</p>
            </div>
            <div id="cdp-status-pill" class="detected-browser-pill">Checking CDP...</div>
          </div>
          <div style="margin-top:0.75rem;">
            <label style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.04em;">Installed Browsers:</label>
            <div id="installed-browser-buttons" style="display:flex; gap:0.5rem; margin-top:0.35rem; flex-wrap:wrap;"></div>
          </div>
        </div>

        <!-- Primary Inputs: Binary & Profile -->
        <div class="input-group">
          <label for="cfg-browser-bin">Browser Binary Path</label>
          <input type="text" id="cfg-browser-bin" value="${cfg.browser.browserBinaryPath || ''}" placeholder="/Applications/Arc.app/Contents/MacOS/Arc">
          <span class="field-hint" id="hint-browser-bin">Auto-detected: Arc (/Applications/Arc.app/Contents/MacOS/Arc)</span>
        </div>

        <div class="input-group">
          <label for="cfg-browser-data">Browser User Data Dir</label>
          <input type="text" id="cfg-browser-data" value="${cfg.browser.browserUserDataDir || ''}" placeholder="/Users/pranavshinde/Library/Application Support/Arc/User Data">
          <span class="field-hint" id="hint-browser-data">Auto-detected profile: ~/Library/Application Support/Arc/User Data (Leave empty to auto-clone session)</span>
        </div>

        <!-- Checkboxes / Toggles Row -->
        <div class="toggle-grid">
          <label class="checkbox-card">
            <input type="checkbox" id="cfg-use-own" ${cfg.browser.useOwnBrowser ? 'checked' : ''}>
            <div>
              <div class="chk-title">Use Own Browser</div>
              <div class="chk-desc">Use your desktop browser with existing logins & sessions</div>
            </div>
          </label>
          <label class="checkbox-card">
            <input type="checkbox" id="cfg-keep-open" ${cfg.browser.keepBrowserOpen !== false ? 'checked' : ''}>
            <div>
              <div class="chk-title">Keep Browser Open</div>
              <div class="chk-desc">Keep browser open between tasks</div>
            </div>
          </label>
          <label class="checkbox-card">
            <input type="checkbox" id="cfg-headless" ${cfg.browser.headless ? 'checked' : ''}>
            <div>
              <div class="chk-title">Headless Mode</div>
              <div class="chk-desc">Run browser without GUI</div>
            </div>
          </label>
          <label class="checkbox-card">
            <input type="checkbox" id="cfg-disable-sec" ${cfg.browser.disableSecurity ? 'checked' : ''}>
            <div>
              <div class="chk-title">Disable Security</div>
              <div class="chk-desc">Disable web security & CORS checks</div>
            </div>
          </label>
        </div>

        <!-- Dimensions Row -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
          <div class="input-group">
            <label for="cfg-window-w">Window Width</label>
            <input type="number" id="cfg-window-w" value="${cfg.browser.windowWidth || 1280}" placeholder="1280">
          </div>
          <div class="input-group">
            <label for="cfg-window-h">Window Height</label>
            <input type="number" id="cfg-window-h" value="${cfg.browser.windowHeight || 1100}" placeholder="1100">
          </div>
        </div>

        <!-- Remote Debugging & CDP -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
          <div class="input-group">
            <label for="cfg-cdp-url">CDP URL</label>
            <input type="text" id="cfg-cdp-url" value="${cfg.browser.cdpUrl || ''}" placeholder="http://127.0.0.1:9222">
            <span class="field-hint">CDP URL for browser remote debugging</span>
          </div>
          <div class="input-group">
            <label for="cfg-wss-url">WSS URL</label>
            <input type="text" id="cfg-wss-url" value="${cfg.browser.wssUrl || ''}" placeholder="ws://127.0.0.1:9222/devtools/browser/...">
            <span class="field-hint">WSS URL for browser remote debugging</span>
          </div>
        </div>

        <!-- Pre-Check Diagnostic Box -->
        <div class="precheck-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
            <span style="font-size:0.9rem; font-weight:600; color:#f3f4f6;">🔍 Browser Pre-Check & Diagnostics</span>
            <button class="badge" onclick="runPrecheck()" style="cursor:pointer; background:rgba(59,130,246,0.25); border:1px solid rgba(59,130,246,0.4); color:#93c5fd; padding:0.3rem 0.8rem;">
              ⚡ Run Pre-Check
            </button>
          </div>
          <div id="precheck-results" class="precheck-results" style="font-size:0.8rem; color:var(--text-muted);">
            Click "Run Pre-Check" to test your browser executable, CDP connection, and password/login storage.
          </div>
          <div id="precheck-actions" style="margin-top:0.75rem; display:none; gap:0.5rem; flex-wrap:wrap;">
            <button id="btn-launch-debug" class="badge" onclick="launchArcDebug()" style="cursor:pointer; background:rgba(16,185,129,0.2); border:1px solid rgba(16,185,129,0.4); color:#34d399; padding:0.35rem 0.85rem;">
              🚀 Launch / Attach Arc on Port 9222
            </button>
          </div>
        </div>

        <!-- Storage Paths -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
          <div class="input-group">
            <label for="cfg-download-dir">Downloads Directory</label>
            <input type="text" id="cfg-download-dir" value="${cfg.browser.downloadPath || './tmp/downloads'}" placeholder="./tmp/downloads">
          </div>
          <div class="input-group">
            <label for="cfg-history-dir">Agent History Path</label>
            <input type="text" id="cfg-history-dir" value="${cfg.browser.agentHistoryPath || './tmp/agent_history'}" placeholder="./tmp/agent_history">
          </div>
        </div>

        <!-- Action Buttons -->
        <div style="display:flex; gap:0.75rem; margin-top:0.5rem;">
          <button class="btn-primary" onclick="saveBrowserSettings()" style="flex:1;">
            <span>💾</span> Save Browser Settings
          </button>
          <button class="btn-primary" onclick="applyAndTestBrowser()" style="background:rgba(59,130,246,0.2); border:1px solid rgba(59,130,246,0.4); color:#93c5fd; box-shadow:none;">
            <span>🔄</span> Apply & Reconnect
          </button>
        </div>
      </div>

      <!-- Agent Settings Tab -->
      <div id="tab-settings" class="tab-content">
        <div class="input-group">
          <label>LLM Base URL</label>
          <input type="text" id="cfg-llm-url" value="${cfg.llm.baseURL}">
        </div>
        <div class="input-group">
          <label>Model ID</label>
          <input type="text" id="cfg-llm-model" value="${cfg.llm.modelId}">
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem;">
          <div class="input-group">
            <label>Temperature</label>
            <input type="number" step="0.05" id="cfg-llm-temp" value="${cfg.llm.temperature}">
          </div>
          <div class="input-group">
            <label>Max Agent Steps</label>
            <input type="number" id="cfg-agent-steps" value="${cfg.agent.maxSteps}">
          </div>
        </div>
        <button class="btn-primary" onclick="saveAgentSettings()">
          <span>💾</span> Save Agent Settings
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

    async function loadBrowserStatus() {
      try {
        const res = await fetch('/api/browser/status');
        const data = await res.json();
        const pill = document.getElementById('detected-browser-pill');
        const cdpPill = document.getElementById('cdp-status-pill');
        const titleEl = document.getElementById('detected-browser-name');

        if (data.detected) {
          titleEl.innerText = '🌐 ' + data.detected.name + (data.detected.isDefault ? ' (Default)' : '');
          pill.innerText = '✨ ' + data.detected.name + (data.cdpRunning ? ' (CDP Active)' : '');
          pill.className = data.cdpRunning ? 'detected-browser-pill' : 'detected-browser-pill warn';
        }

        if (cdpPill) {
          if (data.cdpRunning) {
            cdpPill.innerText = '🟢 CDP Port 9222 Active';
            cdpPill.className = 'detected-browser-pill';
          } else {
            cdpPill.innerText = '⚪ CDP Inactive';
            cdpPill.className = 'detected-browser-pill warn';
          }
        }

        // Render installed browser buttons
        const btnContainer = document.getElementById('installed-browser-buttons');
        if (btnContainer && data.installed) {
          btnContainer.innerHTML = '';
          data.installed.forEach(b => {
            const btn = document.createElement('button');
            btn.className = 'quick-pick-btn';
            btn.innerText = b.name + (b.isDefault ? ' ★' : '');
            btn.title = b.binary;
            btn.onclick = () => selectInstalledBrowser(b);
            btnContainer.appendChild(btn);
          });
        }

        if (data.mode === 'own') {
          selectBrowserMode('own', false);
        } else {
          selectBrowserMode('clean', false);
        }
      } catch (e) {
        console.error('Failed to load browser status', e);
      }
    }

    function selectInstalledBrowser(b) {
      document.getElementById('cfg-browser-bin').value = b.binary;
      document.getElementById('cfg-browser-data').value = b.userDataDir;
      document.getElementById('hint-browser-bin').innerText = 'Selected: ' + b.name + ' (' + b.binary + ')';
      document.getElementById('hint-browser-data').innerText = 'Selected profile: ' + b.userDataDir;
      appendLog('Selected browser: ' + b.name);
    }

    async function selectBrowserMode(mode, triggerSwitch = true) {
      const cleanRadio = document.getElementById('radio-mode-clean');
      const ownRadio = document.getElementById('radio-mode-own');
      const cleanCard = document.getElementById('mode-clean-card');
      const ownCard = document.getElementById('mode-own-card');

      if (cleanRadio) cleanRadio.checked = (mode === 'clean');
      if (ownRadio) ownRadio.checked = (mode === 'own');
      if (cleanCard) cleanCard.classList.toggle('active', mode === 'clean');
      if (ownCard) ownCard.classList.toggle('active', mode === 'own');

      if (triggerSwitch) {
        appendLog('🔄 Switching browser to: ' + (mode === 'own' ? 'My Default Browser' : 'Clean Browser') + '...');
        document.getElementById('status-dot').className = 'status-dot busy';
        document.getElementById('status-text').innerText = 'Switching Browser...';
        try {
          const res = await fetch('/api/browser/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
          });
          const data = await res.json();
          appendLog('✅ Browser active: ' + data.browserName);
          document.getElementById('status-dot').className = 'status-dot';
          document.getElementById('status-text').innerText = 'Ready (' + (mode === 'own' ? 'My Browser' : 'Clean') + ')';
          refreshScreenshot();
        } catch (e) {
          appendLog('❌ Failed to switch browser: ' + e.message);
          document.getElementById('status-dot').className = 'status-dot';
          document.getElementById('status-text').innerText = 'Ready';
        }
      }
    }

    async function runPrecheck() {
      const resEl = document.getElementById('precheck-results');
      const actionsEl = document.getElementById('precheck-actions');
      resEl.innerHTML = '<div style="color:#93c5fd;">Running diagnostics on executable, CDP, and profile...</div>';
      try {
        const res = await fetch('/api/browser/precheck');
        const data = await res.json();
        let html = '';
        data.tests.forEach(t => {
          html += '<div class="precheck-test-item">' +
                    '<span>' + t.name + '</span>' +
                    '<span class="status-badge ' + t.status + '">' + t.status.toUpperCase() + '</span>' +
                  '</div>' +
                  '<div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:0.4rem; padding-left:0.6rem;">' +
                    t.message + (t.fixHint ? '<br><span style="color:#fbbf24;">💡 ' + t.fixHint + '</span>' : '') +
                  '</div>';
        });
        resEl.innerHTML = html;
        if (!data.cdpActive) {
          actionsEl.style.display = 'flex';
        } else {
          actionsEl.style.display = 'none';
        }
        appendLog('🔍 Browser pre-check complete. Status: ' + (data.ok ? 'PASS' : 'WARN'));
      } catch (e) {
        resEl.innerHTML = '<div style="color:#f87171;">Pre-check error: ' + e.message + '</div>';
      }
    }

    async function launchArcDebug() {
      appendLog('🚀 Launching Arc on port 9222...');
      try {
        const res = await fetch('/api/browser/launch-debug', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          appendLog('✅ ' + data.message);
          runPrecheck();
          loadBrowserStatus();
          refreshScreenshot();
        } else {
          appendLog('⚠️ ' + data.message);
        }
      } catch (e) {
        appendLog('❌ ' + e.message);
      }
    }

    async function saveBrowserSettings() {
      const payload = {
        browserBinaryPath: document.getElementById('cfg-browser-bin').value.trim() || undefined,
        browserUserDataDir: document.getElementById('cfg-browser-data').value.trim() || undefined,
        useOwnBrowser: document.getElementById('cfg-use-own').checked,
        keepBrowserOpen: document.getElementById('cfg-keep-open').checked,
        headless: document.getElementById('cfg-headless').checked,
        disableSecurity: document.getElementById('cfg-disable-sec').checked,
        windowWidth: parseInt(document.getElementById('cfg-window-w').value, 10) || 1280,
        windowHeight: parseInt(document.getElementById('cfg-window-h').value, 10) || 1100,
        cdpUrl: document.getElementById('cfg-cdp-url').value.trim() || undefined,
        wssUrl: document.getElementById('cfg-wss-url').value.trim() || undefined,
        downloadPath: document.getElementById('cfg-download-dir').value.trim() || undefined,
        agentHistoryPath: document.getElementById('cfg-history-dir').value.trim() || undefined,
      };
      await fetch('/api/browser/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      appendLog('💾 Browser settings saved successfully.');
      alert('Browser settings saved!');
      loadBrowserStatus();
    }

    async function applyAndTestBrowser() {
      await saveBrowserSettings();
      const mode = document.getElementById('cfg-use-own').checked ? 'own' : 'clean';
      await selectBrowserMode(mode, true);
      runPrecheck();
    }

    async function saveAgentSettings() {
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
      alert('Agent settings saved!');
    }

    async function clearMemory() {
      try {
        const res = await fetch('/api/clear', { method: 'POST' });
        const data = await res.json();
        appendLog('🧹 ' + data.message);
        document.getElementById('timeline').innerHTML =
          '<div class="step-item"><div class="step-header">Memory Cleared</div>' +
          '<div class="step-desc">Session context reset. Ready for new task.</div></div>';
      } catch (e) {
        appendLog('❌ Clear failed: ' + e.message);
      }
    }

    async function runAgentGoal() {
      const prompt = document.getElementById('agent-prompt').value.trim();
      if (!prompt) return;
      document.getElementById('run-btn').disabled = true;
      document.getElementById('status-dot').className = 'status-dot busy';
      document.getElementById('status-text').innerText = 'Running Agent...';

      const selectedMode = document.querySelector('input[name="browser-mode"]:checked')?.value || 'clean';

      const timeline = document.getElementById('timeline');
      timeline.innerHTML = '<div class="step-item"><div class="step-header">Started (' + (selectedMode === 'own' ? 'My Browser' : 'Clean') + ')</div><div class="step-desc">' + prompt + '</div></div>';

      await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, browserMode: selectedMode })
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
      appendLog('✅ Goal completed: ' + (data.result || '').slice(0, 120));
      if (data.screenshot) updateScreenshot(data.screenshot);
      // Show result in timeline
      const timeline = document.getElementById('timeline');
      if (data.result) {
        const doneDiv = document.createElement('div');
        doneDiv.className = 'step-item';
        doneDiv.style.borderColor = 'rgba(16,185,129,0.4)';
        doneDiv.innerHTML = '<div class="step-header" style="color:#34d399;">✅ Done</div>' +
                            '<div class="step-result" style="white-space:pre-wrap;">' + data.result + '</div>';
        timeline.appendChild(doneDiv);
        timeline.scrollTop = timeline.scrollHeight;
      }
    });

    evt.addEventListener('agent_error', (e) => {
      const data = JSON.parse(e.data);
      document.getElementById('run-btn').disabled = false;
      document.getElementById('status-dot').className = 'status-dot';
      document.getElementById('status-text').innerText = 'Error';
      appendLog('❌ Agent error: ' + data.error);
    });

    evt.addEventListener('session_cleared', () => {
      appendLog('🧹 Session memory cleared by server.');
    });

    evt.addEventListener('browser_switching', (e) => {
      const data = JSON.parse(e.data);
      appendLog('🔄 Switching browser to: ' + (data.mode === 'own' ? 'My Default Browser' : 'Clean Browser') + '...');
      document.getElementById('status-dot').className = 'status-dot busy';
      document.getElementById('status-text').innerText = 'Switching Browser...';
    });

    evt.addEventListener('browser_switched', (e) => {
      const data = JSON.parse(e.data);
      appendLog('✅ Active browser: ' + data.browserName);
      document.getElementById('status-dot').className = 'status-dot';
      document.getElementById('status-text').innerText = 'Ready (' + (data.mode === 'own' ? 'My Browser' : 'Clean') + ')';
      if (data.screenshot) updateScreenshot(data.screenshot);
      if (data.title) document.getElementById('page-title').innerText = data.title;
    });

    evt.addEventListener('extract_done', (e) => {
      const data = JSON.parse(e.data);
      document.getElementById('extract-btn').disabled = false;
      const resEl = document.getElementById('extract-result');
      resEl.style.display = 'block';
      resEl.innerText = data.answer || data.extraction || 'No data extracted';
      if (data.screenshot) updateScreenshot(data.screenshot);
    });

    loadBrowserStatus();
    refreshScreenshot();
  </script>
</body>
</html>`;
}
