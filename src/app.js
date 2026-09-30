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
  div.innerHTML = `<div class="msg-label">${label}</div><div class="bubble ${cls}">${escHtml(content)}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addThinkingMsg() {
  const chat = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.id = 'thinking-msg';
  div.innerHTML = `<div class="msg-label">Stagehand</div><div class="bubble thinking"><div class="typing-dots"><span></span><span></span><span></span></div>Working…</div>`;
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
  div.innerHTML = `<div class="step-pill ${cls}"><span class="sp-icon">${icon}</span><span>${escHtml(text)}</span></div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function updateThinkingText(text) {
  const t = document.getElementById('thinking-msg');
  if (t) {
    const b = t.querySelector('.bubble');
    if (b) b.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>${escHtml(text)}`;
  }
}

function formatAnswer(text) {
  // Full markdown rendering: headings, bold, italic, bullet lists, code, links, newlines
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    // code blocks (triple-backtick fences)
    .replace(/CODEBLOCK_START[\s\S]*?CODEBLOCK_END/g, m => m) // placeholder — real handling below
    // inline code
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    // bold
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    // italic
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    // headings
    .replace(/^### (.+)$/gm,'<div class="ans-h3">$1</div>')
    .replace(/^## (.+)$/gm,'<div class="ans-h2">$1</div>')
    // bullet lists: consecutive lines starting with "- " or "• "
    .replace(/((?:^[-•] .+\n?)+)/gm, block => {
      const items = block.trim().split('\n').map(l => `<li>${escHtml(l.replace(/^[-•] /,''))}</li>`).join('');
      return `<ul class="ans-ul">${items}</ul>`;
    })
    // numbered lists
    .replace(/((?:^\d+\. .+\n?)+)/gm, block => {
      const items = block.trim().split('\n').map(l => `<li>${escHtml(l.replace(/^\d+\. /,''))}</li>`).join('');
      return `<ol class="ans-ol">${items}</ol>`;
    })
    // newlines → <br>
    .replace(/\n/g,'<br>');
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
    ? `<button class="verify-btn" onclick="verifyAtSource(\\'${escAttr(goal)}\\')">Verify at source →</button>`
    : '';
  return `<div class="source-row"><span class="source-badge ${badge.cls}">${badge.icon} ${badge.text}</span>${verifyBtn}</div>`;
}

function addAnswerMsg(text, source, goal) {
  const chat = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg agent answer-msg';
  div.innerHTML = `
    <div class="msg-label">Stagehand</div>
    <div class="answer-bubble">
      <div class="answer-body">${formatAnswer(text)}</div>
      <button class="copy-btn" onclick="copyAnswer(this)" title="Copy answer">⎘</button>
    </div>
    ${sourceBadgeHtml(source, goal)}
  `;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

async function verifyAtSource(originalGoal) {
  const followUp = `go to the actual source page and verify: ${originalGoal}`;
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
  div.innerHTML = `<span class="log-ts">${ts}</span>${escHtml(text)}`;
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
