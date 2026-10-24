/* OPC 控制台前端：无框架，事件驱动 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = {
  bootstrap: null,
  pipelines: [],
  active: null,
  current: null,        // { runId, pipeline, steps: Map, status }
  follow: true,
  timer: null,
  opts: { themesPath: '', themeId: '', publish: false },
  themes: [],
};

/* ------------------------------------------------------------ 格式化 */
const fmtBytes = (n) => (n == null ? '-' : n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB');
const fmtDur = (s) => (s == null ? '-' : `${Number(s).toFixed(1)}s`);
const fmtTok = (n) => (n == null ? '-' : Number(n).toLocaleString());
const fmtStamp = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const mediaUrl = (p, dl) => `/media?p=${encodeURIComponent(p)}${dl ? '&dl=1' : ''}`;

function toast(msg, isBad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isBad ? ' bad' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 4000);
}

/* ------------------------------------------------------------ markdown（够用即可） */
function md(src) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0, ul = false, ol = false;
  const closeLists = () => {
    if (ul) { out.push('</ul>'); ul = false; }
    if (ol) { out.push('</ol>'); ol = false; }
  };
  const isBlock = (l) => /^(#{1,4}\s|```|>|\||---+\s*$)/.test(l) || /^\s*([-*]|\d+\.)\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; closeLists();
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { closeLists(); i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeLists(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^---+\s*$/.test(line)) { closeLists(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      closeLists(); out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`); continue;
    }
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      closeLists();
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (!ul) { closeLists(); out.push('<ul>'); ul = true; } out.push(`<li>${inline(li[1])}</li>`); i++; continue; }
    const oi = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (oi) { if (!ol) { closeLists(); out.push('<ol>'); ol = true; } out.push(`<li>${inline(oi[1])}</li>`); i++; continue; }
    closeLists();
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  closeLists();
  return out.join('\n');
}

/* ------------------------------------------------------------ 启动 */
async function boot() {
  try {
    const b = await (await fetch('/api/bootstrap')).json();
    state.bootstrap = b;
    state.pipelines = b.pipelines;
    renderPipelines();
    renderRuns(b.runs);
    if (b.themeSources.length) {
      state.opts.themesPath = b.themeSources[0].path;
      await loadThemes(state.opts.themesPath);
    }
    setGlobal(b.active);
    if (b.active) showRunPanel(b.active.pipeline, b.active.runId, b.active.startedAt);
  } catch (e) {
    toast('连接服务器失败：' + e.message, true);
  }
  openStream();
}

function setGlobal(active) {
  state.active = active || null;
  const g = $('#globalStatus');
  const dot = $('#healthDot');
  if (active) {
    g.innerHTML = `运行中 · <span class="mono">${esc(active.pipeline)}</span>`;
    dot.className = 'dot busy';
  } else {
    g.textContent = '空闲';
    dot.className = 'dot on';
  }
}

/* ------------------------------------------------------------ pipeline 卡片 */
function renderPipelines() {
  const box = $('#pipelines');
  box.innerHTML = '';
  for (const p of state.pipelines) {
    const card = document.createElement('div');
    card.className = `pipe ${p.accent}`;
    const cmd = p.id === 'create-video'
      ? (state.opts.publish ? 'OPC_PUBLISH_ENABLED=1 ' : '') + (p.configFile !== 'config/pipeline.yaml' ? 'node bin/opc run create-video --pipeline-config ' + p.configFile : 'node bin/opc run create-video')
      : p.configFile !== 'config/pipeline.yaml'
        ? `node bin/opc run ${p.id} --pipeline-config ${p.configFile}`
        : `node bin/opc run ${p.id}`;
    card.innerHTML = `
      <div class="pipe-head">
        <div class="pipe-icon">${p.icon}</div>
        <div>
          <div class="pipe-title">${esc(p.title)}</div>
          <div class="pipe-desc">${esc(p.description || p.desc || '')}</div>
        </div>
      </div>
      <div class="pipe-steps">${p.steps.map((s) => `<span class="chip">${esc(s.id)}</span>`).join('')}</div>
      ${p.options.themes ? `
      <div class="opts" id="opts-${p.id}">
        <div class="field"><label>选题来源</label><select id="src-${p.id}"></select></div>
        <div class="field"><label>主题（默认按置信度自动选）</label><select id="theme-${p.id}"></select></div>
        <label class="check strong"><input type="checkbox" id="pub-${p.id}"> 真实投稿到 B 站（默认只预检，不上传）</label>
      </div>` : ''}
      <div class="pipe-actions">
        <button class="btn primary" data-run="${p.id}">${runLabel(p)}</button>
        ${p.options.themes ? `<button class="btn ghost small" data-opts="${p.id}">选项</button>` : ''}
        <button class="btn ghost small" data-copy="${p.id}">复制命令</button>
      </div>
      <div class="pipe-cmd">${esc(cmd)}</div>`;
    box.appendChild(card);
  }

  $$('[data-run]').forEach((b) => b.addEventListener('click', () => onRunClick(b.dataset.run)));
  $$('[data-opts]').forEach((b) => b.addEventListener('click', () => {
    const el = $('#opts-' + b.dataset.opts);
    el.classList.toggle('open');
    if (el.classList.contains('open')) fillSourceSelect(b.dataset.opts);
  }));
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    const p = state.pipelines.find((x) => x.id === b.dataset.copy);
    const cmd = p.configFile !== 'config/pipeline.yaml'
      ? `node bin/opc run ${p.id} --pipeline-config ${p.configFile} --launcher spawn`
      : `node bin/opc run ${p.id} --launcher spawn`;
    navigator.clipboard?.writeText(cmd).then(() => toast('已复制：' + cmd)).catch(() => toast(cmd));
  }));

  fillSourceSelect('create-video');
  const chk = $('#pub-create-video');
  if (chk) chk.addEventListener('change', () => {
    state.opts.publish = chk.checked;
    renderPipelines();
    $('#opts-create-video')?.classList.add('open');
  });
}

const runLabel = (p) => (p.options.publish && state.opts.publish ? '运行并投稿' : '运行');

function fillSourceSelect(pid) {
  const sel = $('#src-' + pid);
  if (!sel) return;
  sel.innerHTML = state.bootstrap.themeSources
    .map((s) => `<option value="${esc(s.path)}"${s.path === state.opts.themesPath ? ' selected' : ''}>${esc(s.label)} · ${s.count} 条 · ${esc(s.top.slice(0, 18))}</option>`)
    .join('');
  sel.onchange = async () => {
    state.opts.themesPath = sel.value;
    state.opts.themeId = '';
    await loadThemes(sel.value);
  };
  renderThemeSelect(pid);
}

function renderThemeSelect(pid) {
  const sel = $('#theme-' + pid);
  if (!sel) return;
  const opts = [`<option value="">自动（置信度最高）</option>`].concat(
    state.themes.map((t) => `<option value="${esc(t.id)}"${t.id === state.opts.themeId ? ' selected' : ''}>${t.confidence != null ? t.confidence.toFixed(2) : '--'} · ${t.durationSec ?? '?'}s · ${esc(t.title)}</option>`)
  );
  sel.innerHTML = opts.join('');
  sel.onchange = () => { state.opts.themeId = sel.value; };
}

async function loadThemes(path) {
  try {
    const r = await fetch('/api/themes?path=' + encodeURIComponent(path));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '加载失败');
    state.themes = d.themes || [];
    renderThemeSelect('create-video');
  } catch (e) {
    state.themes = [];
    toast('选题文件读取失败：' + e.message, true);
  }
}

/* ------------------------------------------------------------ 运行 */
async function onRunClick(pid) {
  const p = state.pipelines.find((x) => x.id === pid);
  const options = p.options.themes
    ? { themesPath: state.opts.themesPath, themeId: state.opts.themeId || undefined, publish: !!state.opts.publish }
    : {};
  if (options.publish) {
    const ok = await confirmPublish();
    if (!ok) return;
  }
  try {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipeline: pid, options }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '启动失败');
    showRunPanel(pid, d.runId, Date.now());
    setGlobal({ pipeline: pid, runId: d.runId, startedAt: Date.now() });
    toast(`已启动 ${pid} · ${d.runId}`);
  } catch (e) {
    toast(e.message, true);
  }
}

function confirmPublish() {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modalTitle').textContent = '确认真实投稿到 B 站';
    $('#modalBody').innerHTML = `
      <p>这会打开浏览器，用本机已登录的 B 站账号 <b>真实上传并提交</b> 视频。提交后需要在 B 站侧删除，自动化不会撤回。</p>
      <p class="muted small">如果只是想验证全链路，取消即可 —— 默认流程只做 7 项预检，不上传。</p>
      <div class="field"><label>输入「投稿」以确认</label><input type="text" id="modalConfirmText" placeholder="投稿"></div>`;
    const ok = $('#modalOk');
    const input = $('#modalConfirmText');
    ok.disabled = true;
    ok.textContent = '确认投稿';
    input.oninput = () => { ok.disabled = input.value.trim() !== '投稿'; };
    m.classList.remove('hidden');
    input.focus();
    const close = (v) => { m.classList.add('hidden'); ok.onclick = null; $('#modalCancel').onclick = null; resolve(v); };
    ok.onclick = () => close(true);
    $('#modalCancel').onclick = () => close(false);
    input.onkeydown = (e) => { if (e.key === 'Enter' && !ok.disabled) close(true); };
  });
}

/* ------------------------------------------------------------ 运行面板 */
function showRunPanel(pipelineId, runId, startedAt) {
  const p = state.pipelines.find((x) => x.id === pipelineId) || { id: pipelineId, title: pipelineId, icon: '⚙️', steps: [] };
  state.current = { runId, pipeline: pipelineId, steps: new Map(), status: 'running' };
  state.follow = true;
  const panel = $('#runPanel');
  panel.innerHTML = `
    <div class="run-head">
      <span class="run-title">${p.icon} ${esc(p.title)}</span>
      <span class="run-sub">${esc(p.id)} · ${esc(runId)}</span>
      <span class="badge running" id="runBadge">运行中</span>
      <span class="spacer"></span>
      <span class="elapsed" id="elapsed">00:00</span>
      <button class="btn small ghost" id="stopBtn">停止</button>
    </div>
    <div class="steps" id="stepRow">
      ${(p.steps || []).map((s) => `<div class="step" id="step-${esc(s.id)}"><span class="nm">${esc(s.id)}</span><span class="st">等待</span></div>`).join('')}
    </div>
    <div class="split">
      <div style="display:flex;flex-direction:column;min-height:0;border-bottom:1px solid var(--line)">
        <div class="logbar">
          <label><input type="checkbox" id="followChk" checked> 自动滚动</label>
          <span id="logCount">0 行</span>
          <span style="flex:1"></span>
          <a class="link" id="logDl" href="/api/log?id=${encodeURIComponent(runId)}" target="_blank">原始日志</a>
        </div>
        <pre class="log" id="log"></pre>
      </div>
      <div class="result" id="result"></div>
    </div>`;
  panel.classList.remove('empty');

  $('#followChk').onchange = (e) => { state.follow = e.target.checked; };
  $('#stopBtn').onclick = () => stopRun(runId);

  const t0 = startedAt || Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const e = $('#elapsed');
    if (!e) return clearInterval(state.timer);
    if (state.current && state.current.runId === runId && state.current.status === 'running') e.textContent = mmss(Date.now() - t0);
  }, 500);
  $('#elapsed').textContent = mmss(Date.now() - t0);
}

function stepEl(id) { return document.getElementById('step-' + id); }

function setStep(id, status, tokens) {
  const el = stepEl(id);
  if (!el) return;
  el.className = 'step ' + (status === 'success' ? 'ok' : status === 'failed' ? 'bad' : status === 'running' ? 'run' : '');
  const label = { running: '运行中', success: '完成', failed: '失败' }[status] || status;
  el.querySelector('.st').textContent = label;
  let tk = el.querySelector('.tk');
  if (tokens != null) {
    if (!tk) { tk = document.createElement('span'); tk.className = 'tk'; el.appendChild(tk); }
    tk.textContent = `${fmtTok(tokens)} tok`;
  }
}

function appendLog(stream, line) {
  const log = $('#log');
  if (!log) return;
  const span = document.createElement('span');
  const isEvent = /^\[run\]/.test(line);
  span.className = isEvent ? 'ev' : stream === 'stderr' ? 'e' : 'o';
  span.textContent = (isEvent ? '▸ ' : '') + line + '\n';
  log.appendChild(span);
  while (log.childNodes.length > 3000) log.removeChild(log.firstChild);
  $('#logCount').textContent = log.childNodes.length + ' 行';
  if (state.follow) log.scrollTop = log.scrollHeight;
}

function onDone(ev) {
  if (!state.current || state.current.runId !== ev.runId) return;
  state.current.status = ev.run ? ev.run.status : ev.code === 0 ? 'success' : 'failed';
  const badge = $('#runBadge');
  if (badge) {
    badge.className = 'badge ' + (state.current.status === 'success' ? 'success' : 'failed');
    badge.textContent = state.current.status === 'success' ? '完成' : '失败';
  }
  const stop = $('#stopBtn');
  if (stop) stop.remove();
  clearInterval(state.timer);
  loadRun(ev.runId, true);
  refreshRuns();
}

function openStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'hello') {
      if (ev.active && (!state.current || state.current.runId !== ev.active.runId)) {
        showRunPanel(ev.active.pipeline, ev.active.runId, ev.active.startedAt);
      }
      return;
    }
    if (ev.type === 'started') {
      setGlobal({ pipeline: ev.pipeline, runId: ev.runId, startedAt: ev.startedAt });
      if (!state.current || state.current.runId !== ev.runId) showRunPanel(ev.pipeline, ev.runId, ev.startedAt);
      return;
    }
    if (ev.type === 'log') {
      if (state.current && state.current.runId === ev.runId) appendLog(ev.stream, ev.line);
      return;
    }
    if (ev.type === 'event') {
      if (!state.current || state.current.runId !== ev.runId) return;
      if (ev.name === 'step_start') setStep(ev.stepId, 'running');
      if (ev.name === 'step_end') setStep(ev.stepId, ev.status);
      return;
    }
    if (ev.type === 'stopping') {
      toast('正在停止…');
      return;
    }
    if (ev.type === 'done') {
      setGlobal(null);
      onDone(ev);
    }
  };
  es.onerror = () => { /* EventSource 会自动重连 */ };
}

async function stopRun(runId) {
  try {
    const r = await fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '停止失败');
    toast('已发送停止信号');
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------------ 历史 / 结果 */
async function refreshRuns() {
  try {
    const d = await (await fetch('/api/runs')).json();
    renderRuns(d.runs);
  } catch {}
}

function renderRuns(runs) {
  const box = $('#runs');
  if (!runs || !runs.length) { box.innerHTML = '<div class="empty small" style="padding:20px">还没有历史运行</div>'; return; }
  box.innerHTML = runs.map((r) => `
    <div class="run-row" data-load="${esc(r.runId)}">
      <span class="run-id">${esc(r.runId)}</span>
      <span class="badge ${esc(r.status)}">${r.status === 'success' ? '完成' : r.status === 'failed' ? '失败' : esc(r.status)}</span>
      <span class="run-meta"><span>${esc(r.pipelineId || '')}</span><span>${fmtStamp(r.startedAt)}</span><span>${fmtTok(r.tokens)} tok</span></span>
    </div>`).join('');
  $$('[data-load]', box).forEach((el) => el.onclick = () => loadRun(el.dataset.load, false));
}

async function loadRun(runId, fromLive) {
  let view;
  try {
    const r = await fetch('/api/run?id=' + encodeURIComponent(runId));
    view = await r.json();
    if (!r.ok) throw new Error(view.error || '读取失败');
  } catch (e) { toast(e.message, true); return; }

  const fresh = !state.current || state.current.runId !== runId;
  if (fresh) showRunPanel(view.run.pipelineId, runId, new Date(view.run.startedAt).getTime());
  state.current.status = view.run.status;

  // 回看历史：把落盘的 console.log 铺回日志区（实时运行时不重复铺）
  if (fresh && view.log) {
    $('#log').innerHTML = '';
    for (const line of view.log.split('\n')) if (line.trim()) appendLog(/^\[run\]/.test(line) ? 'event' : 'stdout', line);
  } else if (fresh) {
    $('#log').innerHTML = '<span class="o">（这次运行没有网页日志，可能是在命令行里跑的）</span>\n';
    $('#logCount').textContent = '—';
  }

  // 结束态一律收尾：徽标、计时器、停止按钮
  if (view.run.status !== 'running') {
    const badge = $('#runBadge');
    if (badge) {
      badge.className = 'badge ' + view.run.status;
      badge.textContent = view.run.status === 'success' ? '完成' : view.run.status === 'failed' ? '失败' : view.run.status;
    }
    $('#stopBtn')?.remove();
    clearInterval(state.timer);
    if (view.run.startedAt && view.run.finishedAt) {
      $('#elapsed').textContent = mmss(new Date(view.run.finishedAt) - new Date(view.run.startedAt));
    }
  }

  for (const s of view.steps || []) {
    setStep(s.id, s.status, s.tokens);
    if (s.status === 'success') setStep(s.id, 'success', s.tokens);
    else if (s.status === 'failed') setStep(s.id, 'failed', s.tokens);
  }
  renderResult(view);
}

function renderResult(view) {
  const box = $('#result');
  const art = view.artifacts || {};
  const steps = view.steps || [];
  const totalTok = steps.reduce((a, s) => a + (s.tokens || 0), 0);
  const run = view.run || {};
  const html = [];

  const title = art.theme?.title || art.production?.metadataDraft?.title;
  if (title) {
    html.push(`<div class="card"><div class="card-b">
      <div class="hero-title">${esc(title)}</div>
      ${art.theme ? `<div class="muted small" style="margin-top:6px">主题 ${esc(art.theme.id)} · 置信度 ${art.theme.confidence ?? '-'} · 目标时长 ${art.theme.durationSec ?? '-'}s</div>` : ''}
      <div class="meta-grid">
        ${art.video ? `<div class="meta"><b>成片时长</b><span>${fmtDur(art.video.durationSec)}</span></div>
        <div class="meta"><b>分辨率</b><span>${art.video.width}×${art.video.height}</span></div>
        <div class="meta"><b>大小</b><span>${fmtBytes(art.video.sizeBytes)}</span></div>` : ''}
        <div class="meta"><b>总 token</b><span>${fmtTok(totalTok)}</span></div>
        <div class="meta"><b>耗时</b><span>${run.startedAt && run.finishedAt ? mmss(new Date(run.finishedAt) - new Date(run.startedAt)) : '-'}</span></div>
      </div>
    </div></div>`);
  }

  if (art.video) {
    html.push(`<div class="card">
      <div class="card-h"><span>成片</span><a href="${mediaUrl(art.video.path, true)}">下载 mp4</a></div>
      <div class="card-b">
        <video controls preload="metadata" poster="${art.cover ? mediaUrl(art.cover.path) : ''}" src="${mediaUrl(art.video.path)}"></video>
        <div class="note mono">${esc(art.video.path)}</div>
      </div></div>`);
  }

  if (art.publish) {
    const p = art.publish;
    const st = p.status;
    const cls = st === 'published' || st === 'submitted' ? 'ok' : st === 'precheck_failed' || st === 'failed' ? 'bad' : 'warn';
    const label = { published: '已公开', submitted: '已提交待审核', precheck_failed: '预检未过（未上传）', login_required: '等待扫码', manual_fallback: '未投稿（只预检）', failed: '失败' }[st] || st;
    const checks = (p.precheck?.checks || []).map((c) => `<span class="pill ${c.passed ? 'ok' : 'bad'}">${c.passed ? '✓' : '✕'} ${esc(c.name)}${c.detail ? ' ' + esc(c.detail) : ''}</span>`).join('');
    html.push(`<div class="card">
      <div class="card-h"><span>发布记录</span><span class="mono small">${esc(p.publishId || '')}</span></div>
      <div class="card-b">
        <span class="pill ${cls}">${esc(label)}</span>
        ${p.platformVideoId ? `<a style="margin-left:10px" href="${esc(p.url || '#')}" target="_blank">${esc(p.platformVideoId)}</a>` : ''}
        ${p.error ? `<div class="note warn">${esc(p.error.code)} · ${esc(p.error.message)}</div>` : ''}
        ${p.error?.screenshot ? `<div class="note"><a href="${mediaUrl(p.error.screenshot)}" target="_blank">查看失败截图</a></div>` : ''}
        <div class="checks">${checks}</div>
        ${st === 'manual_fallback' && p.error?.code === 'PUBLISH_DISABLED' ? `<div class="note">预检全部通过，只是没有开启真实投稿。要真发：回到左侧勾选「真实投稿」再跑一次（会弹窗二次确认）。</div>` : ''}
      </div></div>`);
  }

  if (art.scriptMd) {
    html.push(`<div class="card">
      <div class="card-h"><span>口播稿</span><span class="mono small">${esc(art.script || '')}</span></div>
      <div class="card-b markdown" style="max-height:420px;overflow:auto">${md(art.scriptMd)}</div></div>`);
  }

  const sb = art.storyboard;
  if (sb?.scenes?.length) {
    const rows = sb.scenes.map((s, i) => `<tr>
      <td>${i + 1}</td><td>${esc(s.durationSec)}s</td><td>${esc(s.kind || '')}</td>
      <td>${esc(s.heading || '')}</td><td class="muted">${esc(s.onScreenText || s.text || '')}</td>
      <td class="muted">${esc(s.voiceover || s.narration || '')}</td></tr>`).join('');
    html.push(`<div class="card">
      <div class="card-h"><span>分镜（${sb.scenes.length} 个场景 · ${sb.scenes.reduce((a, b) => a + (b.durationSec || 0), 0)}s）</span><span class="mono small">${esc(art.production?.script?.storyboardPath || '')}</span></div>
      <div class="card-b tight"><div class="tbl-wrap"><table><thead><tr><th>#</th><th>时长</th><th>类型</th><th>标题</th><th>屏幕文字</th><th>口播</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`);
  }

  const themesOut = steps.map((s) => s.output).find((o) => o && Array.isArray(o.themes));
  if (themesOut) {
    const rows = themesOut.themes.map((t) => `<tr>
      <td class="mono">${esc(t.id)}</td><td>${esc(t.title)}</td><td>${t.confidence ?? '-'}</td>
      <td>${esc(t.brief?.durationSec ?? '-')}s</td><td class="muted">${esc((t.brief?.angle || t.angle || '').slice(0, 60))}</td></tr>`).join('');
    html.push(`<div class="card">
      <div class="card-h"><span>候选主题（${themesOut.themes.length}）</span><span class="small muted">已写入 data/themes/latest.json 可直接出片</span></div>
      <div class="card-b tight"><div class="tbl-wrap"><table><thead><tr><th>ID</th><th>标题</th><th>置信度</th><th>时长</th><th>角度</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`);
  }

  html.push(`<div class="card">
    <div class="card-h"><span>步骤</span><span class="mono small">${esc(run.runId || '')}</span></div>
    <div class="card-b tight"><table><thead><tr><th>步骤</th><th>skill</th><th>状态</th><th>尝试</th><th>token</th><th>产物</th></tr></thead><tbody>
      ${steps.map((s) => `<tr>
        <td class="mono">${esc(s.id)}</td><td>${esc(s.skill)}</td>
        <td><span class="pill ${s.status === 'success' ? 'ok' : 'bad'}">${esc(s.status)}</span></td>
        <td>${s.attempt ?? '-'}</td><td class="mono">${fmtTok(s.tokens)}</td>
        <td class="mono small">${esc(s.output ? Object.keys(s.output).slice(0, 6).join(', ') : (s.errorDetail?.code || ''))}</td>
      </tr>`).join('')}
    </tbody></table></div></div>`);

  const details = steps.filter((s) => s.output).map((s) => `<details><summary>${esc(s.id)} 的 output.json</summary><pre>${esc(JSON.stringify(s.output, null, 2))}</pre></details>`).join('');
  if (details) html.push(`<div class="card"><div class="card-h"><span>原始产物</span></div><div class="card-b" style="display:flex;flex-direction:column;gap:8px">${details}</div></div>`);

  if (!html.length) html.push('<div class="empty">这次运行没有可展示的产物</div>');
  box.innerHTML = html.join('');
  box.scrollTop = 0;
  requestAnimationFrame(() => { box.scrollTop = 0; });
}

/* ------------------------------------------------------------ 视图切换 / 文档 */
function switchView(name, updateHash = true) {
  if (!['console', 'tutorial', 'about'].includes(name)) name = 'console';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  for (const v of ['console', 'tutorial', 'about']) $('#view-' + v).classList.toggle('hidden', v !== name);
  if (updateHash && location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  if (name === 'tutorial') loadDoc('tutorial');
  if (name === 'about') loadDoc('about');
}

window.addEventListener('hashchange', () => switchView(location.hash.slice(1) || 'console', false));

let docLoaded = false;
async function loadDoc(which) {
  if (which === 'tutorial') {
    if (!docLoaded) {
      try {
        const text = await (await fetch('/api/tutorial')).text();
        $('#tutorialBody').innerHTML = md(text);
        docLoaded = true;
      } catch { $('#tutorialBody').innerHTML = '<p>教程加载失败</p>'; }
    }
    return;
  }
  $('#aboutBody').innerHTML = md(aboutMd);
}

const aboutMd = `
# 架构与等价命令

这个控制台只是把下面这些命令做成了按钮，**没有改调度器一行代码**。

## 三个角色

| 角色 | 目录 | 干什么 |
|---|---|---|
| A-core | \`bin/\` \`scheduler/\` \`config/\` | 调度、隔离、重试、token 账本、task_status |
| B-data | \`plugins/data-sources/\` \`skills/fetch-*\` \`skills/build-dashboard\` \`skills/recommend-themes\` | 抓 B 站/自有数据、看板、选题 |
| C-media | \`skills/generate-script\` \`skills/render-remotion\` \`skills/publish-*\` \`plugins/publishers/\` \`templates/remotion/\` | 写稿、渲染、发布 |

## 按钮 ↔ 命令

| 按钮 | 等价命令 |
|---|---|
| 抓数据 + 选题 | \`node bin/opc run trends-analysis --launcher spawn\` |
| 一键出片（只预检） | \`./plugins/publishers/pipelines/run-create-video.sh\` |
| 一键出片（真投稿） | \`OPC_PUBLISH_ENABLED=1 ./plugins/publishers/pipelines/run-create-video.sh\` |
| 冒烟 | \`node bin/opc run echo-smoke --launcher spawn\` |
| 看某个 run | \`node bin/opc attempts <runId>\` |

## 这个 UI 做了什么

- \`POST /api/run\` → 用 \`--launcher spawn\` 起 \`bin/opc run\`，把 \`OPC_THEME_ID\` / \`OPC_PUBLISH_ENABLED\` 注入子进程
- \`GET /api/stream\` → SSE 推 \`[run] step_start/step_end\`，进度条就是解析这些行
- \`/media?p=...\` → 只放行 \`data/productions\`、\`data/scripts\`、\`logs\`、\`dashboard\`、\`workspace\`，**不放** \`data/browser-profiles\`（那是登录 cookie）
- 每次运行的完整控制台输出会落到 \`workspace/<runId>/console.log\`

## 安全边界

- 只监听 \`127.0.0.1\`，没有账号体系；同一时间只允许一个任务
- 投稿必须在弹窗里输入「投稿」二次确认
- 停止按钮发 \`SIGTERM\` 给整个进程组（含 pi 子进程）
`;

/* ------------------------------------------------------------ 事件绑定 */
$$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
$('#refreshRuns').addEventListener('click', refreshRuns);
const initialView = location.hash.slice(1);
if (initialView === 'tutorial' || initialView === 'about') switchView(initialView);
boot();
