/**
 * webui.ts — Web UI HTML template
 *
 * Chat-first redesign: conversation history on the left, live browser preview + activity on the right.
 */

import type { Config } from "./types.js";

export function getWebUiHtml(cfg: Config): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stagehand Local</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:          #0d1117;
      --sidebar-bg:  #161b22;
      --panel-bg:    #1c2128;
      --border:      #30363d;
      --border-soft: #21262d;
      --accent:      #4493f8;
      --accent-dim:  rgba(68,147,248,0.15);
      --accent-glow: rgba(68,147,248,0.3);
      --success:     #3fb950;
      --success-dim: rgba(63,185,80,0.12);
      --warning:     #d29922;
      --danger:      #f85149;
      --danger-dim:  rgba(248,81,73,0.12);
      --text:        #e6edf3;
      --text-muted:  #7d8590;
      --text-dim:    #484f58;
      --user-bubble: #1f4b8e;
      --agent-bubble:#161b22;
      --radius:      12px;
      --radius-sm:   8px;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: grid;
      grid-template-columns: 340px 1fr;
      grid-template-rows: 48px 1fr;
      overflow: hidden;
    }

    /* ── Top bar ── */
    #topbar {
      grid-column: 1 / -1;
      background: var(--sidebar-bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 16px;
      font-size: 13px;
    }
    #topbar .logo { font-weight: 700; font-size: 14px; color: var(--text); letter-spacing: -0.02em; }
    #topbar .logo span { color: var(--accent); }
    .status-pill {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: rgba(63,185,80,0.1); border: 1px solid rgba(63,185,80,0.25);
      color: var(--success); font-size: 11px; font-weight: 500;
    }
    .status-pill.busy { background: rgba(210,153,34,0.1); border-color: rgba(210,153,34,0.25); color: var(--warning); }
    .status-pill.error { background: var(--danger-dim); border-color: rgba(248,81,73,0.25); color: var(--danger); }
    .status-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
    .status-dot.pulse { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(1.3)} }

    .topbar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .icon-btn {
      background: none; border: 1px solid var(--border); color: var(--text-muted);
      padding: 4px 10px; border-radius: var(--radius-sm); font-size: 11px;
      cursor: pointer; transition: all .15s; white-space: nowrap;
    }
    .icon-btn:hover { border-color: var(--accent); color: var(--accent); }
    .icon-btn.danger:hover { border-color: var(--danger); color: var(--danger); }

    /* ── Left: chat sidebar ── */
    #sidebar {
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* mode selector */
    #mode-bar {
      padding: 10px 12px 0;
      display: flex; gap: 4px;
    }
    .mode-chip {
      flex: 1; text-align: center; padding: 5px 0; border-radius: var(--radius-sm);
      font-size: 11px; font-weight: 500; cursor: pointer;
      background: none; border: 1px solid var(--border); color: var(--text-muted);
      transition: all .15s;
    }
    .mode-chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }

    /* browser toggle */
    #browser-row {
      padding: 8px 12px;
      display: flex; gap: 6px; align-items: center;
    }
    #browser-row label { font-size: 11px; color: var(--text-muted); margin-right: 2px; }
    .br-btn {
      flex:1; padding: 5px 4px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 500;
      cursor: pointer; background: none; border: 1px solid var(--border); color: var(--text-muted);
      transition: all .15s; text-align: center;
    }
    .br-btn.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }

    /* chat messages */
    #chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scroll-behavior: smooth;
    }
    #chat-messages::-webkit-scrollbar { width: 4px; }
    #chat-messages::-webkit-scrollbar-track { background: transparent; }
    #chat-messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    .msg { display: flex; flex-direction: column; gap: 3px; max-width: 92%; }
    .msg.user { align-self: flex-end; align-items: flex-end; }
    .msg.agent { align-self: flex-start; align-items: flex-start; }

    .msg-label { font-size: 10px; color: var(--text-muted); font-weight: 500; padding: 0 4px; }

    .bubble {
      padding: 9px 13px; border-radius: var(--radius);
      font-size: 13px; line-height: 1.55; word-break: break-word;
    }
    .msg.user .bubble {
      background: var(--user-bubble);
      border-bottom-right-radius: 4px;
      color: #cce0ff;
    }
    .msg.agent .bubble {
      background: var(--agent-bubble);
      border: 1px solid var(--border-soft);
      border-bottom-left-radius: 4px;
      color: var(--text);
    }
    .msg.agent .bubble.thinking {
      color: var(--text-muted);
      font-style: italic;
      font-size: 12px;
      display: flex; align-items: center; gap: 6px;
    }
    .typing-dots span {
      display: inline-block; width: 4px; height: 4px; border-radius: 50%;
      background: var(--text-muted); animation: blink 1.2s infinite;
    }
    .typing-dots span:nth-child(2) { animation-delay: .2s; }
    .typing-dots span:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 0%,80%,100%{opacity:.2} 40%{opacity:1} }

    .bubble strong { color: #79c0ff; }
    .bubble code { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; background: rgba(255,255,255,.05); padding: 1px 4px; border-radius: 3px; }

    /* ── Answer bubble (rich output) ── */
    .answer-bubble {
      position: relative;
      background: var(--agent-bubble);
      border: 1px solid var(--border-soft);
      border-left: 3px solid var(--accent);
      border-bottom-left-radius: 4px;
      border-radius: var(--radius);
      padding: 11px 36px 11px 14px;
      font-size: 13px; line-height: 1.65; word-break: break-word;
      color: var(--text);
      max-width: 100%;
    }
    .answer-body { min-width: 0; }
    .answer-body strong { color: #79c0ff; }
    .answer-body em { color: var(--text-muted); font-style: italic; }
    .answer-body code { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 3px; }
    .answer-body pre.code-block {
      background: #0d1117; border: 1px solid var(--border); border-radius: 6px;
      padding: 10px 12px; margin: 8px 0; overflow-x: auto;
    }
    .answer-body pre.code-block code { background: none; padding: 0; font-size: 11px; }
    .answer-body .ans-h2 { font-size: 13px; font-weight: 700; color: var(--text); margin: 8px 0 4px; }
    .answer-body .ans-h3 { font-size: 12px; font-weight: 600; color: #79c0ff; margin: 6px 0 3px; }
    .answer-body .ans-ul, .answer-body .ans-ol { padding-left: 18px; margin: 4px 0; }
    .answer-body .ans-ul li, .answer-body .ans-ol li { margin: 2px 0; }

    /* copy button */
    .copy-btn {
      position: absolute; top: 8px; right: 8px;
      background: none; border: 1px solid var(--border-soft); color: var(--text-dim);
      border-radius: 4px; padding: 1px 5px; font-size: 11px; cursor: pointer;
      transition: all .15s; opacity: 0;
    }
    .answer-bubble:hover .copy-btn { opacity: 1; }
    .copy-btn:hover { border-color: var(--accent); color: var(--accent); }

    /* source row */
    .source-row {
      display: flex; align-items: center; gap: 8px;
      margin-top: 4px; padding-left: 2px;
    }
    .source-badge {
      font-size: 10px; padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--border-soft); color: var(--text-dim);
      background: rgba(255,255,255,.03);
    }
    .source-badge.src-unverified { border-color: rgba(210,153,34,.3); color: var(--warning); background: rgba(210,153,34,.07); }
    .source-badge.src-verified   { border-color: rgba(63,185,80,.3);  color: var(--success); background: rgba(63,185,80,.07);  }
    .source-badge.src-api        { border-color: rgba(68,147,248,.3); color: var(--accent);  background: var(--accent-dim);    }
    .source-badge.src-replay     { border-color: rgba(163,113,247,.3); color: #a78bfa;        background: rgba(163,113,247,.07); }
    .source-badge.src-memory     { border-color: rgba(255,255,255,.1); color: var(--text-muted); }

    /* verify button */
    .verify-btn {
      font-size: 10px; padding: 2px 8px; border-radius: 999px;
      border: 1px solid rgba(210,153,34,.4); color: var(--warning);
      background: rgba(210,153,34,.1); cursor: pointer; transition: all .15s;
    }
    .verify-btn:hover { background: rgba(210,153,34,.2); border-color: var(--warning); }

    /* step pills in chat */
    .step-pill {
      font-size: 11px; padding: 4px 10px; border-radius: 999px;
      background: rgba(255,255,255,.04); border: 1px solid var(--border-soft);
      color: var(--text-muted); display: flex; align-items: center; gap: 5px;
      align-self: flex-start;
    }
    .step-pill .sp-icon { font-size: 12px; }
    .step-pill.nav  { border-color: rgba(68,147,248,.25); color: #79c0ff; }
    .step-pill.act  { border-color: rgba(63,185,80,.25);  color: #7ee787; }
    .step-pill.done { border-color: rgba(63,185,80,.4);   color: var(--success); background: var(--success-dim); }
    .step-pill.err  { border-color: rgba(248,81,73,.3);   color: var(--danger); }

    /* input area */
    #input-area {
      padding: 10px 12px 12px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #prompt-wrap {
      display: flex; gap: 6px; align-items: flex-end;
    }
    #agent-prompt {
      flex: 1;
      background: var(--panel-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      padding: 9px 12px;
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      resize: none;
      min-height: 40px;
      max-height: 120px;
      overflow-y: auto;
      line-height: 1.4;
      outline: none;
      transition: border-color .15s;
    }
    #agent-prompt:focus { border-color: var(--accent); }
    #agent-prompt::placeholder { color: var(--text-dim); }

    #send-btn {
      width: 36px; height: 36px; border-radius: var(--radius-sm);
      background: var(--accent); border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; transition: all .15s; flex-shrink: 0;
      color: #fff;
    }
    #send-btn:hover { background: #58a6ff; }
    #send-btn:disabled { background: var(--border); cursor: not-allowed; opacity: .5; }

    /* ── Right: browser + activity ── */
    #main-right {
      display: grid;
      grid-template-rows: 1fr 200px;
      overflow: hidden;
      background: var(--bg);
    }

    /* browser preview */
    #browser-panel {
      display: flex; flex-direction: column; overflow: hidden;
      border-bottom: 1px solid var(--border);
    }
    #browser-chrome {
      background: var(--sidebar-bg);
      border-bottom: 1px solid var(--border);
      padding: 6px 12px;
      display: flex; align-items: center; gap: 8px;
      min-height: 36px;
    }
    #page-title {
      font-size: 11px; color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1;
    }
    #preview-wrap {
      flex: 1; position: relative; overflow: hidden; background: #111318;
    }
    #preview-image {
      width: 100%; height: 100%; object-fit: contain; display: none;
    }
    #preview-placeholder {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 10px; color: var(--text-dim); font-size: 13px;
    }
    #preview-placeholder .ph-icon { font-size: 36px; opacity: .3; }

    /* activity log */
    #activity-panel {
      display: flex; flex-direction: column; overflow: hidden;
    }
    #activity-header {
      background: var(--sidebar-bg); border-bottom: 1px solid var(--border);
      padding: 6px 14px; font-size: 11px; font-weight: 600;
      color: var(--text-muted); letter-spacing: .05em; text-transform: uppercase;
      display: flex; align-items: center; justify-content: space-between;
    }
    #activity-log {
      flex: 1; overflow-y: auto; padding: 8px 12px;
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      color: var(--text-muted); display: flex; flex-direction: column; gap: 2px;
    }
    #activity-log::-webkit-scrollbar { width: 4px; }
    #activity-log::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    .log-line { line-height: 1.5; }
    .log-line.nav   { color: #79c0ff; }
    .log-line.act   { color: #7ee787; }
    .log-line.warn  { color: var(--warning); }
    .log-line.done  { color: var(--success); font-weight: 600; }
    .log-line.err   { color: var(--danger); }
    .log-ts { color: var(--text-dim); margin-right: 6px; }

    /* settings overlay panels (shown in right pane) */
    #settings-overlay {
      display: none;
      position: absolute; inset: 0;
      background: var(--bg);
      z-index: 50;
      padding: 24px;
      overflow-y: auto;
      grid-column: 2;
    }
    #settings-overlay.visible { display: block; }
    .setting-group { margin-bottom: 20px; }
    .setting-group label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .05em; }
    .setting-group input, .setting-group select {
      width: 100%; background: var(--panel-bg); border: 1px solid var(--border);
      border-radius: var(--radius-sm); color: var(--text); padding: 8px 12px;
      font-family: 'JetBrains Mono', monospace; font-size: 12px; outline: none;
    }
    .setting-group input:focus, .setting-group select:focus { border-color: var(--accent); }
    .setting-group .hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
    .save-btn {
      background: var(--accent); color: #fff; border: none; cursor: pointer;
      padding: 8px 20px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600;
      transition: background .15s;
    }
    .save-btn:hover { background: #58a6ff; }

    /* stats row in topbar */
    .stat-badge {
      font-size: 10px; padding: 2px 8px; border-radius: 999px;
      background: rgba(255,255,255,.04); border: 1px solid var(--border-soft);
      color: var(--text-muted); white-space: nowrap;
    }
    .stat-badge span { color: var(--text); font-weight: 600; }

    /* scrollbar global */
    * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }

  </style>
</head>
<body>

  <!-- TOP BAR -->
  <div id="topbar">
    <div class="logo">⚡ Stage<span>hand</span></div>
    <div id="status-pill" class="status-pill">
      <div id="status-dot" class="status-dot"></div>
      <span id="status-text">Ready</span>
    </div>
    <div id="stat-tier0"  class="stat-badge" style="display:none">T0 <span id="s-t0">0</span></div>
    <div id="stat-tier2"  class="stat-badge" style="display:none">LLM <span id="s-t2">0</span></div>
    <div id="stat-saved"  class="stat-badge" style="display:none">Saved <span id="s-sv">0</span> calls</div>
    <div class="topbar-right">
      <button class="icon-btn" onclick="toggleSettings()">⚙ Settings</button>
      <button class="icon-btn danger" onclick="clearMemory()" title="Clear session context">🧹 Clear</button>
    </div>
  </div>

  <!-- LEFT SIDEBAR: CHAT -->
  <div id="sidebar">
    <div id="mode-bar">
      <button class="mode-chip active" id="chip-agent"   onclick="setMode('agent')">🤖 Agent</button>
      <button class="mode-chip"        id="chip-extract" onclick="setMode('extract')">🔍 Extract</button>
      <button class="mode-chip"        id="chip-scan"    onclick="setMode('scan')">📋 Batch</button>
    </div>

    <div id="browser-row">
      <label>Browser:</label>
      <button class="br-btn active" id="br-clean" onclick="selectBrowserMode('clean')">🌐 Clean</button>
      <button class="br-btn"        id="br-own"   onclick="selectBrowserMode('own')">👤 My Browser</button>
    </div>

    <div id="chat-messages">
      <div class="msg agent">
        <div class="msg-label">Stagehand</div>
        <div class="bubble">
          Hi! I'm your local web agent. Type a goal below — I'll navigate, click, and extract for you.<br><br>
          <strong>Examples:</strong><br>
          • play crown by txt on youtube<br>
          • what are banh house's hours?<br>
          • what's the weather in Pune today?
        </div>
      </div>
    </div>

    <!-- extract mode form (hidden by default) -->
    <div id="extract-form" style="display:none; padding: 10px 12px; border-top: 1px solid var(--border); gap: 6px; flex-direction: column;">
      <input type="text" id="extract-url" placeholder="URL to extract from…" style="background:var(--panel-bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:7px 10px;font-size:12px;outline:none;width:100%;">
      <input type="text" id="extract-query" placeholder="What to extract?" style="background:var(--panel-bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:7px 10px;font-size:12px;outline:none;width:100%;">
    </div>

    <!-- scan mode form (hidden by default) -->
    <div id="scan-form" style="display:none; padding: 10px 12px; border-top: 1px solid var(--border); gap: 6px; flex-direction: column;">
      <input type="text" id="scan-csv" placeholder="CSV file path…" style="background:var(--panel-bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:7px 10px;font-size:12px;outline:none;width:100%;">
      <input type="text" id="scan-column" placeholder="Column name (e.g. company)" style="background:var(--panel-bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:7px 10px;font-size:12px;outline:none;width:100%;">
    </div>

    <div id="input-area">
      <div id="prompt-wrap">
        <textarea id="agent-prompt" rows="1" placeholder="Ask me anything or give me a goal…"></textarea>
        <button id="send-btn" onclick="submitPrompt()" title="Send (Enter)">▲</button>
      </div>
      <div style="display:flex; gap:6px; font-size:10px; color: var(--text-dim);">
        <span>Enter to send</span>
        <span style="margin-left:auto; cursor:pointer; color: var(--text-muted);" onclick="clearMemory()">clear context</span>
      </div>
    </div>
  </div>

  <!-- RIGHT PANE: BROWSER + ACTIVITY -->
  <div id="main-right" style="position:relative;">
    <!-- Browser preview -->
    <div id="browser-panel">
      <div id="browser-chrome">
        <span style="color:var(--text-dim); font-size:11px;">🌐</span>
        <span id="page-title" style="font-size:11px; color:var(--text-muted);">No page loaded</span>
        <button class="icon-btn" onclick="refreshScreenshot()" style="margin-left:auto; font-size:10px; padding:2px 8px;">↻ refresh</button>
      </div>
      <div id="preview-wrap">
        <img id="preview-image" alt="browser preview">
        <div id="preview-placeholder">
          <div class="ph-icon">🖥</div>
          <div>Browser preview will appear here</div>
          <div style="font-size:11px; color: var(--text-dim);">Agent starts a task to see the browser</div>
        </div>
      </div>
    </div>

    <!-- Activity log -->
    <div id="activity-panel">
      <div id="activity-header">
        <span>Activity Log</span>
        <span id="step-counter" style="font-size:10px; color:var(--text-dim);"></span>
      </div>
      <div id="activity-log">
        <div class="log-line">Waiting for agent…</div>
      </div>
    </div>

    <!-- Settings overlay (slides in over right pane) -->
    <div id="settings-overlay">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px;">
        <h2 style="font-size:16px;">Settings</h2>
        <button class="icon-btn" onclick="toggleSettings()">✕ Close</button>
      </div>
      <div class="setting-group">
        <label>LLM Base URL</label>
        <input type="text" id="cfg-llm-url" value="${cfg.llm.baseURL}">
        <div class="hint">OpenAI-compatible endpoint (e.g. http://localhost:11434/v1)</div>
      </div>
      <div class="setting-group">
        <label>Model ID</label>
        <input type="text" id="cfg-llm-model" value="${cfg.llm.modelId}">
      </div>
      <div class="setting-group">
        <label>Max Steps per Task</label>
        <input type="number" id="cfg-max-steps" value="${cfg.agent.maxSteps}" min="3" max="30">
      </div>
      <div class="setting-group">
        <label>Browser Binary Path</label>
        <input type="text" id="cfg-browser-bin" value="${cfg.browser.browserBinaryPath ?? ""}">
        <div class="hint">Leave blank to use bundled Chromium</div>
      </div>
      <div class="setting-group">
        <label>Browser User Data Dir</label>
        <input type="text" id="cfg-browser-data" value="${cfg.browser.browserUserDataDir ?? ""}">
      </div>
      <button class="save-btn" onclick="saveSettings()">Save & Apply</button>
    </div>
  </div>

  <script>
    // ── State ────────────────────────────────────────────────────────────────
    let mode = 'agent';
    let agentBusy = false;

    // ── Mode switching ────────────────────────────────────────────────────────
    function setMode(m) {
      mode = m;
      ['agent','extract','scan'].forEach(id => {
        document.getElementById('chip-' + id).classList.toggle('active', id === m);
      });
      document.getElementById('extract-form').style.display = (m === 'extract') ? 'flex' : 'none';
      document.getElementById('scan-form').style.display    = (m === 'scan')    ? 'flex' : 'none';
      const ph = { agent: 'Ask me anything or give me a goal…', extract: 'Run extract on the URL above…', scan: 'Start batch scan on CSV above…' };
      document.getElementById('agent-prompt').placeholder = ph[m];
    }

    // ── Submit ────────────────────────────────────────────────────────────────
    function submitPrompt() {
      if (agentBusy) return;
      const ta = document.getElementById('agent-prompt');
      const prompt = ta.value.trim();
      if (!prompt) return;
      ta.value = '';
      autoResizeTA(ta);

      if (mode === 'agent') {
        runAgentGoal(prompt);
      } else if (mode === 'extract') {
        runExtract(prompt);
      } else if (mode === 'scan') {
        runScan(prompt);
      }
    }

    // Enter to send, Shift+Enter for newline
    document.getElementById('agent-prompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt(); }
    });
    document.getElementById('agent-prompt').addEventListener('input', (e) => autoResizeTA(e.target));
    function autoResizeTA(ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }

    // ── Chat message helpers ──────────────────────────────────────────────────
    function addMsg(role, content, cls = '') {
      const chat = document.getElementById('chat-messages');
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      const label = role === 'user' ? 'You' : 'Stagehand';
      div.innerHTML = \`<div class="msg-label">\${label}</div><div class="bubble \${cls}">\${escHtml(content)}</div>\`;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      return div;
    }

    function addThinkingMsg() {
      const chat = document.getElementById('chat-messages');
      const div = document.createElement('div');
      div.className = 'msg agent';
      div.id = 'thinking-msg';
      div.innerHTML = \`<div class="msg-label">Stagehand</div><div class="bubble thinking"><div class="typing-dots"><span></span><span></span><span></span></div>Working…</div>\`;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      return div;
    }

    function removeThinkingMsg() {
      const t = document.getElementById('thinking-msg');
      if (t) t.remove();
    }

    function addStepPill(icon, text, cls = '') {
      const chat = document.getElementById('chat-messages');
      const div = document.createElement('div');
      div.className = 'msg agent';
      div.innerHTML = \`<div class="step-pill \${cls}"><span class="sp-icon">\${icon}</span><span>\${escHtml(text)}</span></div>\`;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    function updateThinkingText(text) {
      const t = document.getElementById('thinking-msg');
      if (t) {
        const b = t.querySelector('.bubble');
        if (b) b.innerHTML = \`<div class="typing-dots"><span></span><span></span><span></span></div>\${escHtml(text)}\`;
      }
    }

    function formatAnswer(text) {
      // Full markdown rendering: headings, bold, italic, bullet lists, code, links, newlines
      return text
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        // code blocks (triple-backtick fences)
        .replace(/CODEBLOCK_START[\s\S]*?CODEBLOCK_END/g, m => m) // placeholder — real handling below
        // inline code
        .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
        // bold
        .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
        // italic
        .replace(/\*(.+?)\*/g,'<em>$1</em>')
        // headings
        .replace(/^### (.+)$/gm,'<div class="ans-h3">$1</div>')
        .replace(/^## (.+)$/gm,'<div class="ans-h2">$1</div>')
        // bullet lists: consecutive lines starting with "- " or "• "
        .replace(/((?:^[-•] .+\n?)+)/gm, block => {
          const items = block.trim().split('\n').map(l => \`<li>\${escHtml(l.replace(/^[-•] /,''))}</li>\`).join('');
          return \`<ul class="ans-ul">\${items}</ul>\`;
        })
        // numbered lists
        .replace(/((?:^\d+\. .+\n?)+)/gm, block => {
          const items = block.trim().split('\n').map(l => \`<li>\${escHtml(l.replace(/^\d+\. /,''))}</li>\`).join('');
          return \`<ol class="ans-ol">\${items}</ol>\`;
        })
        // newlines → <br>
        .replace(/\\n/g,'<br>');
    }

    function sourceBadgeHtml(source, goal) {
      if (!source || source === 'generic') return '';
      const labels = {
        google_serp:    { icon: '🔍', text: 'From Google (unverified)', cls: 'src-unverified' },
        direct_site:    { icon: '✅', text: 'Verified from source',     cls: 'src-verified'   },
        playbook_api:   { icon: '⚡', text: 'From ATS API',             cls: 'src-api'        },
        pattern_replay: { icon: '🧩', text: 'Pattern replay',           cls: 'src-replay'     },
        trace_replay:   { icon: '🧠', text: 'Trace replay',             cls: 'src-replay'     },
        heuristic:      { icon: '⚡', text: 'Fast-path heuristic',      cls: 'src-replay'     },
        conversational: { icon: '💬', text: 'From session memory',      cls: 'src-memory'     },
      };
      const badge = labels[source] || { icon: '•', text: source, cls: '' };
      const verifyBtn = (source === 'google_serp')
        ? \`<button class="verify-btn" onclick="verifyAtSource(\\'\${escAttr(goal)}\\')">Verify at source →</button>\`
        : '';
      return \`<div class="source-row"><span class="source-badge \${badge.cls}">\${badge.icon} \${badge.text}</span>\${verifyBtn}</div>\`;
    }

    function addAnswerMsg(text, source, goal) {
      const chat = document.getElementById('chat-messages');
      const div = document.createElement('div');
      div.className = 'msg agent answer-msg';
      div.innerHTML = \`
        <div class="msg-label">Stagehand</div>
        <div class="answer-bubble">
          <div class="answer-body">\${formatAnswer(text)}</div>
          <button class="copy-btn" onclick="copyAnswer(this)" title="Copy answer">⎘</button>
        </div>
        \${sourceBadgeHtml(source, goal)}
      \`;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    async function verifyAtSource(originalGoal) {
      const followUp = \`go to the actual source page and verify: \${originalGoal}\`;
      const ta = document.getElementById('agent-prompt');
      ta.value = followUp;
      submitPrompt();
    }

    function copyAnswer(btn) {
      const body = btn.closest('.answer-bubble').querySelector('.answer-body');
      navigator.clipboard.writeText(body.innerText).then(() => {
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = '⎘', 1500);
      });
    }

    function escAttr(s) {
      return String(s).replace(/'/g, '&apos;').replace(/"/g, '&quot;');
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── Activity log ──────────────────────────────────────────────────────────
    function appendLog(text, cls = '') {
      const log = document.getElementById('activity-log');
      const ts = new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});
      const div = document.createElement('div');
      div.className = 'log-line ' + cls;
      div.innerHTML = \`<span class="log-ts">\${ts}</span>\${escHtml(text)}\`;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      // keep max 200 log lines
      while (log.children.length > 200) log.removeChild(log.firstChild);
    }

    function setStatus(state, text) {
      const dot = document.getElementById('status-dot');
      const pill = document.getElementById('status-pill');
      const stxt = document.getElementById('status-text');
      stxt.innerText = text;
      dot.className = 'status-dot' + (state === 'busy' ? ' pulse' : '');
      pill.className = 'status-pill' + (state === 'error' ? ' error' : state === 'busy' ? ' busy' : '');
    }

    // ── Agent run ─────────────────────────────────────────────────────────────
    let currentStepCount = 0;

    async function runAgentGoal(prompt) {
      agentBusy = true;
      currentStepCount = 0;
      document.getElementById('send-btn').disabled = true;
      setStatus('busy', 'Running…');

      // Show user message in chat
      addMsg('user', prompt);
      // Show thinking indicator
      addThinkingMsg();
      appendLog('▶ ' + prompt);

      try {
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, mode: 'agent' })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
      } catch (e) {
        removeThinkingMsg();
        addMsg('agent', '❌ Failed to start: ' + e.message);
        setStatus('error', 'Error');
        agentBusy = false;
        document.getElementById('send-btn').disabled = false;
      }
    }

    async function runExtract(query) {
      const url   = document.getElementById('extract-url').value.trim();
      const exQ   = document.getElementById('extract-query').value.trim() || query;
      if (!url) { addMsg('agent', 'Please enter a URL first.'); return; }
      agentBusy = true;
      document.getElementById('send-btn').disabled = true;
      setStatus('busy', 'Extracting…');
      addMsg('user', 'Extract from ' + url + ': ' + exQ);
      addThinkingMsg();
      appendLog('🔍 extract: ' + url);
      try {
        await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, query: exQ })
        });
      } catch (e) {
        removeThinkingMsg();
        addMsg('agent', '❌ ' + e.message);
        setStatus('error', 'Error');
        agentBusy = false;
        document.getElementById('send-btn').disabled = false;
      }
    }

    async function runScan(goal) {
      const csv = document.getElementById('scan-csv').value.trim();
      const col = document.getElementById('scan-column').value.trim();
      if (!csv) { addMsg('agent', 'Please enter a CSV file path first.'); return; }
      agentBusy = true;
      document.getElementById('send-btn').disabled = true;
      setStatus('busy', 'Scanning…');
      addMsg('user', goal || 'Batch scan: ' + csv);
      addThinkingMsg();
      appendLog('📋 scan: ' + csv);
      try {
        await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csvPath: csv, columnName: col, goal })
        });
      } catch (e) {
        removeThinkingMsg();
        addMsg('agent', '❌ ' + e.message);
        setStatus('error', 'Error');
        agentBusy = false;
        document.getElementById('send-btn').disabled = false;
      }
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    function toggleSettings() {
      document.getElementById('settings-overlay').classList.toggle('visible');
    }

    async function saveSettings() {
      const payload = {
        llm: {
          baseUrl:  document.getElementById('cfg-llm-url').value.trim(),
          modelId:  document.getElementById('cfg-llm-model').value.trim(),
        },
        agent: {
          maxSteps: parseInt(document.getElementById('cfg-max-steps').value, 10),
        },
        browser: {
          executablePath: document.getElementById('cfg-browser-bin').value.trim() || null,
          userDataDir:    document.getElementById('cfg-browser-data').value.trim() || null,
        }
      };
      try {
        const res = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await res.json();
        appendLog('✅ Settings saved', 'done');
        toggleSettings();
      } catch (e) { appendLog('❌ Save failed: ' + e.message, 'err'); }
    }

    // ── Clear memory ──────────────────────────────────────────────────────────
    async function clearMemory() {
      await fetch('/api/clear', { method: 'POST' });
      appendLog('🧹 Context cleared', 'warn');
      addMsg('agent', '🧹 Session context cleared. Starting fresh.');
    }

    // ── Screenshot ────────────────────────────────────────────────────────────
    function updateScreenshot(base64) {
      if (!base64) return;
      const img = document.getElementById('preview-image');
      const ph  = document.getElementById('preview-placeholder');
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

    // ── Browser mode ──────────────────────────────────────────────────────────
    async function selectBrowserMode(mode, triggerSwitch = true) {
      document.getElementById('br-clean').classList.toggle('active', mode === 'clean');
      document.getElementById('br-own').classList.toggle('active', mode === 'own');
      if (!triggerSwitch) return;
      appendLog('🔄 Switching to ' + (mode === 'own' ? 'My Browser' : 'Clean Browser') + '…', 'warn');
      setStatus('busy', 'Switching…');
      try {
        const res = await fetch('/api/browser/mode', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({mode}) });
        const data = await res.json();
        appendLog('✅ Browser: ' + data.browserName, 'done');
        setStatus('ready', 'Ready');
      } catch (e) { appendLog('❌ ' + e.message, 'err'); setStatus('error', 'Error'); }
    }

    async function loadBrowserStatus() {
      try {
        const res = await fetch('/api/browser/status');
        const data = await res.json();
        if (data.mode === 'own') selectBrowserMode('own', false);
        else selectBrowserMode('clean', false);
        if (data.detected) appendLog('🌐 Browser: ' + data.detected.name);
      } catch {}
    }

    // ── SSE Event stream ──────────────────────────────────────────────────────
    let sseReconnectTimer = null;

    function connectSSE() {
      if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
      const evt = new EventSource('/api/events');

      evt.onerror = () => {
        // Connection dropped (server restart, network blip).
        // Reset agentBusy so the UI isn't stuck — the server-side flag resets on restart anyway.
        agentBusy = false;
        document.getElementById('send-btn').disabled = false;
        setStatus('error', 'Reconnecting…');
        removeThinkingMsg();
        evt.close();
        sseReconnectTimer = setTimeout(connectSSE, 2000);
      };

      evt.addEventListener('open', () => {
        setStatus('ready', 'Ready');
      });

    evt.addEventListener('agent_step', (e) => {
      const d = JSON.parse(e.data);
      currentStepCount = d.step;
      document.getElementById('step-counter').innerText = 'Step ' + d.step + '/' + d.maxSteps;

      const action = d.plan?.action || 'act';
      const detail = d.plan?.instruction || d.plan?.url || d.title || '';

      // Update thinking message
      updateThinkingText('Step ' + d.step + ' — ' + (action === 'navigate' ? 'Navigating…' : action === 'act' ? 'Clicking…' : action === 'extract' ? 'Extracting…' : 'Working…'));

      // Log to activity
      const logCls = action === 'navigate' ? 'nav' : action === 'act' ? 'act' : '';
      appendLog('[' + d.step + '] ' + action + ': ' + detail.slice(0, 80), logCls);

      if (d.screenshot) updateScreenshot(d.screenshot);
      if (d.title) document.getElementById('page-title').innerText = d.title;
    });

    evt.addEventListener('agent_done', (e) => {
      const d = JSON.parse(e.data);
      agentBusy = false;
      document.getElementById('send-btn').disabled = false;
      document.getElementById('step-counter').innerText = '';
      setStatus('ready', 'Ready');

      removeThinkingMsg();

      const result = d.result && d.result !== 'Done' ? d.result : null;
      if (result) {
        addAnswerMsg(result, d.source || 'generic', d.prompt || '');
        appendLog('✅ Done: ' + result.slice(0, 100), 'done');
      } else if (d.result === 'Done') {
        // fallback: agent said "Done" with no real answer — show nothing, it was a media task etc.
        appendLog('✅ Task complete', 'done');
      }
      if (d.screenshot) updateScreenshot(d.screenshot);
      if (d.title) document.getElementById('page-title').innerText = d.title;
    });

    evt.addEventListener('agent_error', (e) => {
      const d = JSON.parse(e.data);
      agentBusy = false;
      document.getElementById('send-btn').disabled = false;
      removeThinkingMsg();
      setStatus('error', 'Error');
      addMsg('agent', '❌ ' + d.error);
      appendLog('❌ Error: ' + d.error, 'err');
    });

    evt.addEventListener('agent_start', (e) => {
      const d = JSON.parse(e.data);
      appendLog('▶ Starting: ' + d.prompt?.slice(0,60));
    });

    evt.addEventListener('session_cleared', () => {
      appendLog('🧹 Context cleared', 'warn');
    });

    evt.addEventListener('browser_switching', (e) => {
      setStatus('busy', 'Switching…');
    });

    evt.addEventListener('browser_switched', (e) => {
      const d = JSON.parse(e.data);
      setStatus('ready', 'Ready');
      appendLog('✅ Browser: ' + d.browserName, 'done');
      if (d.screenshot) updateScreenshot(d.screenshot);
      if (d.title) document.getElementById('page-title').innerText = d.title;
    });

    evt.addEventListener('extract_done', (e) => {
      const d = JSON.parse(e.data);
      agentBusy = false;
      document.getElementById('send-btn').disabled = false;
      setStatus('ready', 'Ready');
      removeThinkingMsg();
      if (d.answer || d.extraction) addAnswerMsg(d.answer || d.extraction);
      if (d.screenshot) updateScreenshot(d.screenshot);
    });

    evt.addEventListener('tier_stats', (e) => {
      const d = JSON.parse(e.data);
      const s0 = document.getElementById('stat-tier0');
      const s2 = document.getElementById('stat-tier2');
      const sv = document.getElementById('stat-saved');
      if (d.tier0 > 0) { s0.style.display = ''; document.getElementById('s-t0').innerText = d.tier0; }
      if (d.tier2 > 0) { s2.style.display = ''; document.getElementById('s-t2').innerText = d.tier2; }
      if (d.tokensSaved > 0) { sv.style.display = ''; document.getElementById('s-sv').innerText = d.tokensSaved; }
    });

    } // end connectSSE()

    // ── Init ──────────────────────────────────────────────────────────────────
    // Check if server is already busy before connecting SSE (prevents stuck button on page reload)
    fetch('/api/status').then(r => r.json()).then(d => {
      if (!d.running) {
        agentBusy = false;
        document.getElementById('send-btn').disabled = false;
      }
      if (d.page?.screenshot) updateScreenshot(d.page.screenshot);
      if (d.page?.title) document.getElementById('page-title').innerText = d.page.title;
    }).catch(() => {});
    connectSSE();
    loadBrowserStatus();
    refreshScreenshot();
  </script>
</body>
</html>`;
}
