// OPC 制作台前端：五个视图（数据接口 / 数据看板 / 选题引擎 / 创作引擎 / 发布引擎）
// 无框架、无构建步骤。所有数据来自 webui/server.mjs 的 /api/*。

const STATIC = typeof window !== 'undefined' && !!window.OPC_STATIC; // 静态演示站（gh-pages / Vercel）：只读快照
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nf = (n) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN'));
const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const kfmt = (n) => {
  if (n == null) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return nf(n);
};
const fmtBytes = (n) => (n == null ? '—' : n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB');
const mmss = (ms) => {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const stamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const media = (p, dl) => (STATIC
  ? `media/${p}${dl ? '?dl=1' : ''}`
  : `/media?p=${encodeURIComponent(p)}${dl ? '&dl=1' : ''}`);
const stText = (s) => ({
  published: '已发布', submitted: '已提交', manual_fallback: '仅预检',
  precheck_failed: '预检未通过', login_required: '待扫码', failed: '失败',
}[s] || s || '未发布');

// ---------- 极简 markdown（教程 / 口播稿） ----------
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let inCode = false, inList = false;
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }
    const t = line.trim();
    if (!t) { if (inList) { out.push('</ul>'); inList = false; } continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      if (inList) { out.push('</ul>'); inList = false; }
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(t);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(`<p>${inline(t)}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

// ---------- 全局状态 ----------
const state = {
  view: 'sources',
  data: null,
  topics: null,
  productions: [],
  pipelines: [],
  running: null,
  create: { stage: 'idle', themeId: '', themesPath: 'data/themes/latest.json', runId: null, draft: null, production: null },
  publish: { runId: null, record: null, busy: false },
  schedule: null,
  knowledge: { tid: 36, limit: 20, enrich: true, keywords: '', running: false, result: null, newTime: '' },
  hot: { running: false, result: null },
};

let cdTimer = null;
let cdLeft = 0;

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3000);
}

const SNAPSHOT = {
  '/api/data': 'static-data/data.json',
  '/api/topics': 'static-data/topics.json',
  '/api/productions': 'static-data/productions.json',
  '/api/bootstrap': 'static-data/bootstrap.json',
  '/api/schedule': 'static-data/schedule.json',
};

async function api(p, opts = {}) {
  if (STATIC) {
    if ((opts.method || 'GET').toUpperCase() !== 'GET') {
      throw new Error('静态演示站是只读快照，要跑流水线请本地 ./webui/start.sh');
    }
    const snap = SNAPSHOT[p.split('?')[0]];
    if (!snap) throw new Error(`静态演示站没有接口 ${p}`);
    const rs = await fetch(snap);
    if (!rs.ok) throw new Error(`快照缺失：${snap}`);
    return rs.json();
  }
  const r = await fetch(p, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!r.ok) throw Object.assign(new Error(body?.error || `HTTP ${r.status}`), { body });
  return body;
}

function dialog({ title, bodyHtml, okText = '确认', requireText = null }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg');
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = bodyHtml + (requireText
      ? `<div class="field mt"><label>请输入「${esc(requireText)}」确认</label><input type="text" id="dlgInput" placeholder="${esc(requireText)}" /></div>`
      : '');
    dlg.showModal();
    const close = (ok) => { dlg.close(); resolve(ok); };
    $('#dlgOk').onclick = () => {
      if (requireText) {
        const v = $('#dlgInput')?.value.trim();
        if (v !== requireText) { toast(`输入不匹配，需要输入「${requireText}」`, true); return; }
      }
      close(true);
    };
    $('#dlgCancel').onclick = () => close(false);
    dlg.oncancel = (e) => { e.preventDefault(); close(false); };
  });
}

// ---------- 数据加载 ----------
async function loadAll({ quiet = false } = {}) {
  const [data, topics, prods, boot, sched] = await Promise.all([
    api('/api/data').catch(() => null),
    api('/api/topics').catch(() => null),
    api('/api/productions').catch(() => ({ productions: [] })),
    api('/api/bootstrap').catch(() => ({ pipelines: [] })),
    api('/api/schedule').catch(() => null),
  ]);
  state.data = data;
  state.topics = topics;
  state.productions = prods.productions || [];
  state.pipelines = boot.pipelines || [];
  state.running = boot.active || null;
  if (sched) state.schedule = sched;
  if (!quiet) render();
}

// ---------- 通用小片段 ----------
const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;
const emptyBox = (html) => `<div class="empty">${html}</div>`;
const bar = (v, max, cls = '') => `<div class="bar"><i class="${cls}" style="width:${Math.max(2, Math.min(100, (v / (max || 1)) * 100))}%"></i></div>`;

function head(title, sub, actions = '') {
  return `<div class="page-head"><h1>${esc(title)}</h1><div class="sub">${sub}</div><div class="actions">${actions}</div></div>`;
}

function freshLine() {
  const g = state.data?.dashboard?.generatedAt;
  return g ? `看板生成于 ${stamp(g)}` : '还没有看板数据';
}

// ================================================================ 数据接口
function renderSources() {
  const s = state.data?.sources;
  const el = $('#view-sources');
  if (!s) { el.innerHTML = head('数据接口', '加载中…'); return; }

  const cov = s.coverage || { platforms: [], gaps: [] };
  const platformChips = ['bilibili', 'douyin', 'youtube']
    .map((p) => pill(p, cov.platforms.includes(p) ? 'ok' : 'bad'))
    .join(' ');
  const srcCards = s.sources.map((src) => {
    const isInternal = /internal/.test(src.dataSource) || src.kind === 'internal-metrics';
    const isKnowledge = /knowledge/.test(src.dataSource);
    const label = isInternal ? '🪞 内部数据' : isKnowledge ? '📚 知识区最新' : '🌐 外部热门';
    const rows = src.items.map((i) => `
      <tr>
        <td class="wrap"><a href="${esc(i.url || '#')}" target="_blank" rel="noreferrer">${esc(i.title)}</a>
          <div class="tiny muted">${esc(i.id)}${i.publishDate ? ` · ${esc(i.publishDate)}` : ''}${i.durationSec ? ` · ${Math.round(i.durationSec / 60 * 10) / 10} 分钟` : ''}</div></td>
        <td>${esc(i.channel || '—')}</td>
        <td class="num">${kfmt(i.views)}</td>
        <td class="num">${kfmt(i.likes)}</td>
        <td class="num">${pct(i.engagement, 2)}</td>
        <td class="num">${i.viewsPerHour == null ? '—' : kfmt(Math.round(i.viewsPerHour))}</td>
        <td>${pill(i.velocity || 'unknown', i.velocity === 'rising' ? 'ok' : '')}</td>
        <td>${(i.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
      </tr>`).join('');
    return `
      <div class="card src-card">
        <div class="src-head">
          <span class="name">${label}</span>
          ${pill(src.dataSource, isInternal ? 'blue' : '')}
          ${pill(`${src.count} 条样本`)}
          <span class="meta">抓取 ${stamp(src.timestamp)} · ${esc(src.file)}</span>
          <span class="spacer"></span>
          ${isInternal ? `<a class="btn small" href="#publish">看发布记录</a>` : ''}
        </div>
        <div class="fields">${src.fields.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>
        <table>
          <thead><tr><th>标题</th><th>博主 / 频道</th><th class="num">播放</th><th class="num">点赞</th><th class="num">互动率</th><th class="num">播放/小时</th><th>趋势</th><th>标签</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="8" class="muted">没有样本</td></tr>`}</tbody>
        </table>
      </div>`;
  }).join('');

  el.innerHTML = `
    ${head('数据接口', `外部热门 + 内部表现 + 知识区最新，每条记录都能溯源到原始文件（${freshLine()}）`,
      `<button data-act="fetch-hot"${state.hot.running ? ' disabled' : ''}>${state.hot.running ? '抓取中…' : '抓取 B 站热门'}</button><button class="ghost" data-act="refresh">刷新</button>`)}
    <div class="notice ai-free"><b>本区域不使用 AI。</b>抓取只跑确定性脚本（<code>node skills/*/scripts/run.mjs</code>），不经过 pi / 大模型、不消耗 token；B 站 Cookie 只能由人手动粘贴。需要「抓数据 → 建看板 → AI 推荐选题」的完整流水线，请到「数据看板 / 选题引擎」。</div>
    <div class="grid two" style="margin-bottom:14px">${cookieCard()}${knowledgeCard()}</div>
    <div class="card" style="margin-bottom:14px">
      <div class="card-h">覆盖情况<span class="hint">platform / 样本量 / 维度</span></div>
      ${hotResultLine()}
      <div class="row" style="margin-bottom:8px">${platformChips} ${pill(`样本 ${s.sources.reduce((a, x) => a + x.count, 0)} 条`)} ${pill(cov.hasCreatorMetrics ? '含博主维度' : '缺博主维度', cov.hasCreatorMetrics ? 'ok' : 'bad')}</div>
      <ul class="gap-list">${(cov.gaps || []).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
      <div class="tiny muted mt">热门 / 内部数据来自 B-data 的 fetch-* skill；知识区最新由「数据接口 → 立即抓取」或「定时定点」写入 <code>data/sources/</code>。网页只写 <code>data/sources/</code> 与 <code>data/schedule/</code>，不改流水线产物。要补抖音 / 同赛道博主接口，在 HANDOFF.md 里提需求。</div>
    </div>
    <div class="grid">${srcCards || emptyBox('还没有任何数据：先点右上角「抓取最新数据」')}</div>`;
}

// ================================================================ 数据看板
function renderDashboard() {
  const d = state.data?.dashboard;
  const el = $('#view-dashboard');
  if (!d) { el.innerHTML = head('数据看板', '加载中…'); return; }
  if (!d.external) {
    el.innerHTML = head('数据看板', '还没有看板数据') + emptyBox('先跑一次「抓数据 + 选题」，看板会自动生成。');
    return;
  }

  const ext = d.external, inter = d.internal || {}, tok = d.tokens || {}, task = d.tasks || {};
  const extViews = (ext.topItems || []).reduce((a, x) => a + (x.views || 0), 0);
  const extAvg = ext.topItems?.length ? ext.topItems.reduce((a, x) => a + (x.engagement || 0), 0) / ext.topItems.length : null;
  const maxHeat = Math.max(...(ext.topTopics || []).map((t) => t.heat || 0), 1);
  const maxViews = Math.max(...(ext.topItems || []).map((t) => t.views || 0), 1);
  const maxTok = Math.max(...(tok.byStep || []).map((t) => t.tokens || 0), 1);

  const kpis = [
    ['外部样本播放', kfmt(extViews), `${ext.topItems?.length || 0} 条热门样本`],
    ['外部平均互动率', pct(extAvg, 2), (ext.topItems || []).map((x) => `${x.velocity || ''}`).filter(Boolean).join(' / ') || '—'],
    ['内部期数', nf(inter.episodes?.length || 0), `平均互动 ${pct(inter.avgEngagement?.value, 2)}`],
    ['内部播放', kfmt((inter.episodes || []).reduce((a, x) => a + (x.views || 0), 0)), '累计（窗口 latest）'],
    ['今日 token', kfmt(tok.today), `预算 ${kfmt(tok.budget)} · 利用率 ${tok.utilizationRate == null ? '—' : (tok.utilizationRate * 100).toFixed(0) + '%'}`],
    ['任务', `${task.summary?.success ?? 0}/${(task.summary?.success ?? 0) + (task.summary?.failed ?? 0)}`, `失败 ${task.summary?.failed ?? 0} · 运行 ${task.summary?.running ?? 0}`],
  ].map(([k, v, sub]) => `<div class="card kpi-card"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${sub}</div></div>`).join('');

  const topicBars = (ext.topTopics || []).map((t) => `
    <div class="bar-row"><span class="label" title="${esc(t.topic)}">${esc(t.topic)}</span>${bar(t.heat, maxHeat, 'pink')}<span class="val">${t.heat}</span></div>`).join('');

  const itemBars = (ext.topItems || []).map((t) => `
    <div class="bar-row"><span class="label" title="${esc(t.title)}">${esc(t.title.slice(0, 10))}</span>${bar(t.views, maxViews)}<span class="val">${kfmt(t.views)}</span></div>`).join('');

  const flow = Object.entries(ext.flowDirection || {}).map(([k, v]) => `${pill(k)} ${pill(`流量指数 ${v.value}`)}`).join(' ');

  const interRows = (inter.episodes || []).map((e) => `
    <tr><td class="wrap">${esc(e.title)}<div class="tiny muted">${esc(e.id)} · ${esc(e.themeId || '')}</div></td>
    <td class="num">${kfmt(e.views)}</td><td class="num">${kfmt(e.likes)}</td><td class="num">${kfmt(e.comments)}</td>
    <td class="num">${pct(e.engagement, 2)}</td><td class="num">${e.tokensSpent ?? '—'}</td></tr>`).join('');

  const tokenBars = (tok.byStep || []).map((t) => `
    <div class="bar-row"><span class="label" title="${esc(t.stepId)}">${esc(t.stepId)}</span>${bar(t.tokens, maxTok, 'mint')}<span class="val">${kfmt(t.tokens)}</span></div>`).join('');

  const schedules = (state.data?.schedule || []).map((s) => `
    <tr><td>${esc(s.name)}</td><td><code>${esc(s.cron)}</code></td><td>${esc(s.pipeline)}</td>
    <td>${pill(s.enabled ? '已启用' : '未启用', s.enabled ? 'ok' : '')}${s.manualApproval ? ' ' + pill('需人工确认', 'warn') : ''}</td></tr>`).join('');

  const fresh = (d.files || []).map((f) => `<div class="row tiny"><span class="muted" style="min-width:220px">${esc(f.file)}</span>${pill(stamp(f.mtime))}</div>`).join('');

  const creators = (state.data?.sources?.creators || []).filter((c) => !c.internal);
  const creatorRows = creators.map((c) => `
    <tr><td>${esc(c.name)}</td><td class="num">${c.items}</td><td class="num">${kfmt(c.views)}</td><td class="num">${kfmt(c.likes)}</td>
      <td class="num">${pct(c.avgEngagement, 2)}</td><td>${c.rising ? pill('rising', 'ok') : '<span class="muted tiny">—</span>'}</td>
      <td>${(c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
      <td class="tiny">${c.ids.map((id) => `<a href="https://www.bilibili.com/video/${esc(id)}" target="_blank" rel="noreferrer">${esc(id)}</a>`).join(' ')}</td></tr>`).join('');

  el.innerHTML = `
    ${head('数据看板', `关键运营指标 · ${freshLine()}`, `<button data-act="fetch-data">抓取最新数据</button><button class="ghost" data-act="refresh">刷新</button>`)}
    <div class="grid kpi" style="margin-bottom:14px">${kpis}</div>

    <div class="grid two">
      <div class="card">
        <div class="card-h">外部：流量流向哪里<span class="hint">热度 / 播放</span></div>
        <div class="card-sub">${flow}</div>
        <div class="bars" style="margin-bottom:14px">${topicBars || '<span class="muted">无</span>'}</div>
        <div class="bars">${itemBars || ''}</div>
        <table class="mt"><thead><tr><th>热门样本</th><th class="num">播放</th><th class="num">互动</th><th>趋势</th></tr></thead><tbody>
          ${(ext.topItems || []).map((t) => `<tr><td class="wrap"><a href="https://www.bilibili.com/video/${esc(t.id)}" target="_blank" rel="noreferrer">${esc(t.title)}</a></td>
            <td class="num">${kfmt(t.views)}</td><td class="num">${pct(t.engagement, 2)}</td><td>${pill(t.velocity || '')}</td></tr>`).join('')}
        </tbody></table>
      </div>

      <div class="card">
        <div class="card-h">内部：我自己几期的表现<span class="hint">${inter.episodes?.length || 0} 期</span></div>
        <table><thead><tr><th>期数</th><th class="num">播放</th><th class="num">点赞</th><th class="num">评论</th><th class="num">互动率</th><th class="num">token</th></tr></thead>
        <tbody>${interRows || '<tr><td colspan="6" class="muted">还没有内部数据</td></tr>'}</tbody></table>
        <div class="tiny muted mt">最高表现：${(inter.topPerformers || []).join('、') || '—'}</div>

        <div class="card-h" style="margin-top:18px">Token 消耗（按步骤）<span class="hint">今日 ${kfmt(tok.today)} / 预算 ${kfmt(tok.budget)}</span></div>
        <div class="bars">${tokenBars || '<span class="muted">无</span>'}</div>
        <div class="tiny muted mt">成本换算：$${(tok.costToday ?? 0).toFixed(3)}（今日）· 来源 token-ledger</div>
      </div>
    </div>

    <div class="card mt">
      <div class="card-h">同领域优秀博主<span class="hint">按样本播放排序 · 来自外部数据接口（当前只有 B 站）</span></div>
      <table><thead><tr><th>博主</th><th class="num">样本</th><th class="num">播放</th><th class="num">点赞</th><th class="num">平均互动</th><th>趋势</th><th>标签</th><th>代表作</th></tr></thead>
      <tbody>${creatorRows || '<tr><td colspan="8" class="muted">没有博主样本</td></tr>'}</tbody></table>
    </div>

    <div class="grid two mt">
      <div class="card">
        <div class="card-h">自动计划<span class="hint">config/schedule.yaml（A-core 维护）</span></div>
        <table><thead><tr><th>任务</th><th>cron</th><th>pipeline</th><th>状态</th></tr></thead>
        <tbody>${schedules || '<tr><td colspan="4" class="muted">没有定时任务</td></tr>'}</tbody></table>
        <div class="tiny muted mt">全部 enabled: false —— 目前都是手动触发。要日更得让 A 打开。</div>
      </div>
      <div class="card">
        <div class="card-h">数据新鲜度<span class="hint">看板文件 mtime</span></div>
        ${fresh}
        <div class="tiny muted mt">看板由 B-data 的 build-dashboard 生成，带 sourceRef 溯源；C 侧只读。</div>
      </div>
    </div>`;
}

// ================================================================ 选题引擎
function topicCard(t, kind) {
  const ev = (t.evidence || []).slice(0, 3).map((e) => `<div class="t-evidence">· ${esc(e.note || e.pointer)}</div>`).join('');
  const kw = (t.brief?.keywords || []).slice(0, 5).map((k) => `<span class="tag">${esc(k)}</span>`).join('');
  const plan = (t.creationPlan?.steps || []).map((s) => `${s.step}(${s.tool})`).join(' → ');
  const used = t.usage?.productions ? pill(`已成片 ${t.usage.productions}`, 'ok') : pill('未创作');
  const pub = t.usage?.published ? ' ' + pill('已发布', 'blue') : '';
  return `
    <div class="card hover topic-card">
      <div class="t-top">${pill(kind === 'external' ? '外部' : '内部', kind === 'external' ? '' : 'blue')}
        <span class="conf">置信 ${t.confidence ?? '—'}<span class="bar"><i style="width:${Math.round((t.confidence || 0) * 100)}%;background:linear-gradient(90deg,#8f6bff,#ff4d6d)"></i></span></span>
        <span class="spacer"></span>${used}${pub}</div>
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-reason">${esc(t.reason || '')}</div>
      ${ev}
      <div>${kw}</div>
      <div class="tiny muted">${esc(t.brief?.angle || '')}</div>
      <div class="tiny muted">目标时长 ${t.brief?.durationSec ?? '—'}s · 成本 ≈ ${nf(t.estimatedCost?.tokens)} token / ${esc(t.estimatedCost?.time || '—')} · ${esc(plan)}</div>
      <div class="t-foot">
        <button class="small primary" data-act="use-theme" data-theme="${esc(t.id)}" data-path="${esc(t.themesFile)}">用这个主题创作</button>
        ${t.usage?.last ? `<button class="small ghost" data-act="open-run" data-run="${esc(t.usage.last.runId)}">看成片</button>` : ''}
        <span class="spacer"></span><span class="tiny muted">${esc(t.id)}</span>
      </div>
    </div>`;
}

function renderTopics() {
  const t = state.topics;
  const el = $('#view-topics');
  if (!t) { el.innerHTML = head('选题引擎', '加载中…'); return; }
  const rec = t.recommendations || { external: [], internal: [] };

  const libRows = t.themes.map((x) => `
    <tr><td class="wrap">${esc(x.title)}<div class="tiny muted">${esc(x.id)}</div></td>
      <td>${pill(x.source === 'external' ? '外部' : '内部', x.source === 'external' ? '' : 'blue')}</td>
      <td class="num">${x.confidence ?? '—'}</td>
      <td>${x.usage?.productions ? pill(`已成片 ${x.usage.productions}`, 'ok') : '<span class="muted">未创作</span>'}${x.usage?.published ? ' ' + pill('已发布', 'blue') : ''}</td>
      <td class="num"><button class="small" data-act="use-theme" data-theme="${esc(x.id)}" data-path="${esc(x.themesFile)}">创作</button></td></tr>`).join('');

  el.innerHTML = `
    ${head('选题引擎', `AI 读数据 → 外部 3 个 + 内部 3 个候选 · 共 ${t.counts.total} 个主题（外部 ${t.counts.external} / 内部 ${t.counts.internal}，已发布 ${t.counts.published}）`,
      `<button data-act="regen-topics">重新生成选题</button><button class="ghost" data-act="refresh">刷新</button>`)}
    <div class="grid two">
      <div>
        <div class="card-h" style="padding:2px 4px 10px">外部数据推荐 <span class="hint">同赛道热点 / 流量缺口</span></div>
        <div class="grid">${rec.external.map((x) => topicCard(x, 'external')).join('') || emptyBox('还没有外部推荐')}</div>
      </div>
      <div>
        <div class="card-h" style="padding:2px 4px 10px">内部数据推荐 <span class="hint">自己的爆款/翻车复盘</span></div>
        <div class="grid">${rec.internal.map((x) => topicCard(x, 'internal')).join('') || emptyBox('还没有内部推荐')}</div>
      </div>
    </div>

    <div class="card mt">
      <div class="card-h">主题库与创作计划<span class="hint">共 ${t.counts.total} 条 · 来源文件 ${t.files.length} 个</span></div>
      <table><thead><tr><th>主题</th><th>来源</th><th class="num">置信</th><th>状态</th><th class="num">操作</th></tr></thead>
      <tbody>${libRows}</tbody></table>
      <div class="tiny muted mt">「重新生成选题」= 抓 B 站热门 + 内部数据 → 重建看板 → pi 推荐 6 条（约 18 万 token）。</div>
    </div>`;
}

// ================================================================ 创作引擎
function themeOptions(selected) {
  const groups = { external: [], internal: [] };
  for (const t of state.topics?.themes || []) (groups[t.source] || groups.external).push(t);
  const opt = (t) => `<option value="${esc(t.id)}" data-path="${esc(t.themesFile)}" ${t.id === selected ? 'selected' : ''}>${esc(t.title)}（${t.confidence ?? '—'}）</option>`;
  return `<optgroup label="外部推荐">${groups.external.map(opt).join('')}</optgroup>
          <optgroup label="内部推荐">${groups.internal.map(opt).join('')}</optgroup>`;
}


function latestProductionCard() {
  const p = state.productions.find((x) => x.videoExists);
  if (!p) return '';
  const st = p.publish?.status;
  return `<div class="card mt">
    <div class="card-h">最近一条成片<span class="hint">${esc(p.productionId)}</span></div>
    <div class="row">
      ${p.cover ? `<img src="${media(p.cover.path)}" alt="" style="width:132px;border-radius:8px;border:1px solid var(--line)" />` : ''}
      <div>
        <div>${esc(p.metadataDraft?.title || '')}</div>
        <div class="tiny muted mt">${p.video.durationSec}s · ${p.video.width}×${p.video.height} · ${fmtBytes(p.video.sizeBytes)} · ${esc(stText(st))}</div>
        <div class="row mt"><button class="small primary" data-act="go-publish" data-run="${esc(p.runId)}">去发布 / 回看</button>
          <a class="btn small" href="${media(p.video.path, true)}">下载 mp4</a></div>
      </div>
    </div>
  </div>`;
}

function renderCreate() {
  const c = state.create;
  const el = $('#view-create');
  const theme = (state.topics?.themes || []).find((x) => x.id === c.themeId);
  const flow = (stage) => {
    const step = ({ writing: 1, review: 1, rendering: 2, done: 3 })[stage] || 1;
    const cls = (n) => (n < step ? 'done' : n === step ? 'on' : '');
    return `<div class="flow">
      <span class="node ${cls(1)}">① 写稿 / 人工确认</span><span class="sep">→</span>
      <span class="node ${cls(2)}">② 渲染成片</span><span class="sep">→</span>
      <span class="node ${cls(3)}">③ 去发布</span>
    </div>`;
  };

  let body = '';
  if (c.stage === 'idle') {
    body = `
      <div class="card">
        <div class="card-h">开始一条新片子<span class="hint">第 1 步：选主题 → 写稿</span></div>
        <div class="field"><label>主题（来自选题引擎）</label>
          <select id="c-theme">${themeOptions(c.themeId) || '<option value="">（还没有主题，先去选题引擎生成）</option>'}</select>
        </div>
        <div class="field"><label>基于哪份选题文件</label>
          <select id="c-file">${(state.topics?.files || []).map((f) => `<option value="${esc(f.path)}" ${f.path === c.themesPath ? 'selected' : ''}>${esc(f.label)} · ${esc(f.path)}</option>`).join('')}</select>
        </div>
        <div class="row"><button class="primary" data-act="start-script">开始写稿</button>
          <span class="tiny muted">写稿约 20–40 秒、3 万 token；写完先给你看，5 秒不动就自动渲染。</span></div>
      </div>
      <div class="card mt">
        <div class="card-h">规则<span class="hint">创作引擎（C-media）</span></div>
        <ul class="gap-list">
          <li>文稿 = 口播稿 + 分镜（画面标题/说明/时长），生成后进入人工确认</li>
          <li>确认后由 Remotion 模板渲染 mp4，并同时产出横版 16:9 与竖版 9:16 封面</li>
          <li>标题 / 简介 / 标签随成片一起产出；其余字段留空，发布时默认公开</li>
        </ul>
      </div>
      ${latestProductionCard()}`;
  } else if (c.stage === 'review' && c.draft) {
    const d = c.draft;
    const sceneRows = d.scenes.map((s, i) => `
      <div class="scene-row" data-i="${i}">
        <span class="idx">${i + 1} ${s.kind}</span>
        <input type="text" data-f="heading" value="${esc(s.heading)}" maxlength="24" placeholder="画面标题" />
        <input type="text" data-f="body" value="${esc(s.body || '')}" maxlength="60" placeholder="画面说明（可空）" />
        <input type="number" data-f="durationSec" value="${s.durationSec}" min="2" max="20" step="1" />
        <span class="tiny muted">秒</span>
      </div>`).join('');

    body = `
      ${flow('review')}
      <div class="grid two">
        <div class="card">
          <div class="card-h">口播稿<span class="hint">${esc(c.runId)} · 总时长 ${d.totalSec}s</span></div>
          <div class="markdown">${md(d.scriptMarkdown || '')}</div>
          <details class="mt"><summary class="tiny muted">编辑口播稿</summary>
            <textarea id="e-md" style="min-height:200px">${esc(d.scriptMarkdown || '')}</textarea></details>
        </div>
        <div class="card">
          <div class="card-h">发布信息 & 分镜<span class="hint">可直接改，改了会写进成片清单</span></div>
          <div class="field"><label>标题（≤80）</label><input type="text" id="e-title" maxlength="80" value="${esc(d.title)}" /></div>
          <div class="field"><label>简介（≤2000，留空也行）</label><textarea id="e-desc" maxlength="2000">${esc(d.description)}</textarea></div>
          <div class="field"><label>标签（逗号分隔，≤10）</label><input type="text" id="e-tags" value="${esc((d.tags || []).join(','))}" /></div>
          <div class="field"><label>分镜（标题 / 说明 / 时长）</label>${sceneRows}</div>
        </div>
      </div>
      <div class="approve">
        <div><div class="count" id="cdNum">5</div><div class="txt">秒后自动渲染</div></div>
        <div class="txt">要改就现在改；点「暂停」会停在这里，改完点「立即渲染」。</div>
        <span class="spacer"></span>
        <button class="ghost" data-act="pause">暂停</button>
        <button class="ghost" data-act="rewrite">重新写稿</button>
        <button class="primary" data-act="render-now">立即渲染</button>
      </div>`;
  } else if (c.stage === 'writing') {
    body = `${flow('writing')}<div class="card"><div class="card-h">写稿中…<span class="hint">pi 读主题 → 口播稿 + 分镜，约 20–40 秒</span></div>
      <div class="tiny muted">进度在底部「运行日志」里；写完会停在人工确认，5 秒不动就自动渲染。</div></div>`;
  } else if (c.stage === 'rendering') {
    body = `${flow('rendering')}<div class="card"><div class="card-h">渲染中…<span class="hint">Remotion 渲染 + ffprobe + 双封面，约 40–90 秒</span></div>
      <div class="tiny muted">进度在底部「运行日志」里；渲染完成会自动显示成片。</div></div>`;
  } else if (c.stage === 'done' && c.production) {
    const p = c.production;
    body = `
      ${flow('done')}
      <div class="card">
        <div class="card-h">成片 ready<span class="hint">${esc(p.productionId)}</span></div>
        <div class="media-row">
          <video src="${media(p.video.path)}" controls playsinline poster="${p.cover?.path ? media(p.cover.path) : ''}"></video>
          <div>${p.cover ? `<img class="cover-thumb" src="${media(p.cover.path)}" alt="横版封面" /><div class="cover-cap">横版 16:9 · ${p.cover.width}×${p.cover.height}</div>` : ''}</div>
          <div>${p.coverPortrait ? `<img class="cover-thumb" src="${media(p.coverPortrait.path)}" alt="竖版封面" /><div class="cover-cap">竖版 9:16 · ${p.coverPortrait.width}×${p.coverPortrait.height}</div>` : '<div class="tiny muted">没有竖版封面</div>'}</div>
        </div>
        <div class="grid three mt">
          <div><div class="tiny muted">标题</div><div>${esc(p.metadataDraft?.title)}</div></div>
          <div><div class="tiny muted">标签</div><div>${(p.metadataDraft?.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>
          <div><div class="tiny muted">规格</div><div class="tiny">${p.video.durationSec}s · ${p.video.width}×${p.video.height} · ${fmtBytes(p.video.sizeBytes)}</div></div>
        </div>
        <div class="row mt">
          <button class="primary" data-act="go-publish" data-run="${esc(c.runId)}">去发布</button>
          <button class="ghost" data-act="reset-create">再来一条</button>
          <button class="ghost" data-act="rewrite">换一版稿子</button>
          <span class="spacer"></span>
          <a class="btn small" href="${media(p.video.path, true)}">下载 mp4</a>
          ${p.coverPortrait ? `<a class="btn small" href="${media(p.coverPortrait.path, true)}">下载竖版封面</a>` : ''}
        </div>
      </div>`;
  } else {
    body = emptyBox('状态异常，点「再来一条」重开。');
  }

  el.innerHTML = `
    ${head('创作引擎', theme ? `当前主题：${esc(theme.title)}` : '选一个主题，先写稿再渲染', `<button class="ghost" data-act="refresh">刷新</button>`)}
    ${body}`;
}

// ================================================================ 发布引擎
function publishOf(runId) {
  return state.productions.find((x) => x.runId === runId)?.publish || null;
}

function renderPublish() {
  const el = $('#view-publish');
  const list = state.productions.filter((p) => p.videoExists);
  if (!state.publish.runId && list.length) state.publish.runId = list[0].runId;
  const cur = list.find((p) => p.runId === state.publish.runId) || null;

  const items = list.slice(0, 30).map((p) => {
    const st = p.publish?.status;
    const badge = pill(stText(st), !st ? '' : ['published', 'submitted'].includes(st) ? 'ok' : st === 'manual_fallback' ? 'warn' : 'bad');
    return `<div class="prod-item ${p.runId === state.publish.runId ? 'active' : ''}" data-act="select-prod" data-run="${esc(p.runId)}">
      <div class="t">${esc(p.metadataDraft?.title || p.productionId)}</div>
      <div class="m">${esc(p.themeId)} · ${p.video.durationSec}s · ${stamp(p.createdAt)} ${badge}</div></div>`;
  }).join('');

  let detail;
  if (!cur) {
    detail = emptyBox('还没有成片：去「创作引擎」出一条。');
  } else {
    const rec = state.publish.record;
    const pre = rec?.precheck || cur.publish?.precheck;
    const checkName = { duration: '时长', fileSize: '文件大小', resolution: '分辨率', titleLength: '标题长度', tagCount: '标签数量', sensitiveWords: '敏感词', coverExists: '封面存在' };
    const checks = pre?.checks?.map((c) => `${pill(`${checkName[c.name] || c.name} ${c.detail || ''}`, c.passed ? 'ok' : 'bad')}`).join(' ') || '<span class="muted tiny">还没预检</span>';
    const st = rec?.status || cur.publish?.status;
    const stPill = pill(`${stText(st)}${st === 'manual_fallback' ? ' · 未上传' : ''}`, ['published', 'submitted'].includes(st) ? 'ok' : ['manual_fallback'].includes(st) ? 'warn' : st ? 'bad' : '');
    const err = rec?.error || cur.publish?.error;
    detail = `
      <div class="card">
        <div class="card-h">${esc(cur.metadataDraft?.title || '')} ${stPill}<span class="hint">${esc(cur.productionId)} · run ${esc(cur.runId)}</span></div>
        <div class="media-row" style="grid-template-columns: 1fr 220px 150px">
          <video src="${media(cur.video.path)}" controls playsinline poster="${cur.cover?.path ? media(cur.cover.path) : ''}"></video>
          <div>${cur.cover ? `<img class="cover-thumb" src="${media(cur.cover.path)}" /><div class="cover-cap">横版 16:9</div>` : ''}</div>
          <div>${cur.coverPortrait ? `<img class="cover-thumb" src="${media(cur.coverPortrait.path)}" /><div class="cover-cap">竖版 9:16</div>` : '<div class="tiny muted">无竖版封面</div>'}</div>
        </div>
        <div class="card-h mt">投稿信息<span class="hint">默认公开；其他字段留空</span></div>
        <div class="field"><label>标题</label><input type="text" id="p-title" maxlength="80" value="${esc(rec?.metadata?.title || cur.metadataDraft?.title || '')}" /></div>
        <div class="field"><label>简介</label><textarea id="p-desc" maxlength="2000">${esc(rec?.metadata?.description || cur.metadataDraft?.description || '')}</textarea></div>
        <div class="field"><label>标签</label><input type="text" id="p-tags" value="${esc((rec?.metadata?.tags || cur.metadataDraft?.tags || []).join(','))}" /></div>
        <div class="card-h mt">7 项预检<span class="hint">${pre ? (pre.passed ? '全部通过' : '有未通过项') : '未运行'}</span></div>
        <div class="row">${checks}</div>
        ${err ? `<div class="tiny" style="color:#ffb3ae;margin-top:8px">${esc(err.code)} · ${esc(err.message)}</div>` : ''}
        <div class="row mt">
          <button data-act="precheck">只跑预检</button>
          <button class="primary" data-act="publish-real">真实投稿</button>
          <span class="spacer"></span>
          ${rec?.url || cur.publish?.url ? `<a class="btn small" href="${esc(rec?.url || cur.publish.url)}" target="_blank" rel="noreferrer">打开稿件</a>` : ''}
          <a class="btn small" href="${media(cur.video.path, true)}">下载 mp4</a>
        </div>
        <div class="tiny muted mt">真实投稿会打开浏览器、可能要求扫码；提交前要输入「投稿」二次确认。未开启时只会预检并记录 manual_fallback。</div>
      </div>`;

    // 发布历史
    const history = state.productions.filter((p) => p.publish).map((p) => `
      <tr><td class="wrap">${esc(p.metadataDraft?.title)}</td><td>${pill(stText(p.publish.status), ['published', 'submitted'].includes(p.publish.status) ? 'ok' : p.publish.status === 'manual_fallback' ? 'warn' : 'bad')}</td>
        <td class="num">${esc(p.publish.platformVideoId || '—')}</td><td>${p.publish.url ? `<a href="${esc(p.publish.url)}" target="_blank" rel="noreferrer">链接</a>` : '—'}</td>
        <td class="tiny muted">${esc(p.publish.error?.code || '')}</td><td>${stamp(p.createdAt)}</td></tr>`).join('');
    detail += `<div class="card mt"><div class="card-h">发布历史<span class="hint">${state.productions.filter((p) => p.publish).length} 条</span></div>
      <table><thead><tr><th>标题</th><th>状态</th><th class="num">BV</th><th>链接</th><th>错误码</th><th>时间</th></tr></thead><tbody>${history || '<tr><td colspan="6" class="muted">还没有发布记录</td></tr>'}</tbody></table></div>`;
  }

  el.innerHTML = `
    ${head('发布引擎', '选成片 → 预检 → 真实投稿（浏览器扫码）', `<button class="ghost" data-act="refresh">刷新</button>`)}
    <div class="split">
      <div class="card"><div class="card-h">成片<span class="hint">${list.length} 条</span></div>${items || emptyBox('没有成片')}</div>
      <div>${detail}</div>
    </div>`;
}

// ================================================================ 定时定点
const zonesOf = () => state.data?.zones || state.schedule?.zones || [{ tid: 36, name: '知识（全部）' }];

function cookieCard() {
  const c = state.data?.cookie || state.schedule?.cookie || { configured: false };
  return `
  <div class="card ai-card">
    <div class="card-h">Cookie（手动填写）<span class="hint">禁止 AI · 只存本机</span></div>
    <div class="row" style="margin-bottom:8px">
      ${pill(c.configured ? '已配置' : '未配置', c.configured ? 'ok' : 'bad')}
      ${c.configured ? pill(`${c.bytes} 字符`) : ''}
      ${c.configured && c.hasSessdata ? pill('含 SESSDATA', 'ok') : ''}
      ${c.savedAt ? `<span class="tiny muted">保存于 ${stamp(c.savedAt)}</span>` : ''}
      <span class="spacer"></span>
      <span class="tiny muted"><code>${esc(c.file || 'data/secrets/bilibili-cookie.txt')}</code></span>
    </div>
    <div class="field">
      <label>粘贴 bilibili.com 的 Cookie（至少包含 SESSDATA）</label>
      <textarea id="cookie-input" rows="3" placeholder="SESSDATA=xxxx%2Cxxxx; bili_jct=yyyy; buvid3=zzzz"></textarea>
    </div>
    <div class="row">
      <button data-act="save-cookie">保存到本机</button>
      <button class="ghost" data-act="clear-cookie">清除</button>
      <span class="spacer"></span>
      <span class="tiny muted">不写日志、不进 output.json、不发给任何模型。</span>
    </div>
  </div>`;
}

function knowledgeCard() {
  const k = state.knowledge;
  const r = k.result;
  const preview = r?.ok && r.preview?.length
    ? `<ul class="gap-list">${r.preview.map((i) => `<li><a href="${esc(i.url || '#')}" target="_blank" rel="noreferrer">${esc(i.title)}</a>
        <span class="tiny muted">${esc(i.channel || '')} · ${stamp(i.publishedAt)}</span></li>`).join('')}</ul>`
    : '';
  const result = !r ? '' : (r.ok
    ? `<div class="row tiny" style="margin-top:8px">${pill(`${r.count} 条`, 'ok')}${pill(`抓取自 ${stamp(r.timestamp)}`)}${pill(r.cache?.hit ? '缓存命中' : '实时抓取')}${r.warnings?.length ? pill(`${r.warnings.length} 条告警`, 'warn') : ''}</div>${preview}`
    : `<div class="notice err tiny" style="margin-top:8px"><b>${esc(r.error?.code || 'FETCH_FAILED')}</b> ${esc(r.error?.message || '')}</div>`);
  return `
  <div class="card ai-card">
    <div class="card-h">知识区最新视频<span class="hint">确定性脚本 · 不经过 AI</span></div>
    <div class="row" style="flex-wrap:wrap;gap:10px">
      <select id="k-tid">${zonesOf().map((z) => `<option value="${z.tid}"${Number(k.tid) === z.tid ? ' selected' : ''}>${esc(z.name)}（${z.tid}）</option>`).join('')}</select>
      <label class="tiny muted">条数 <input id="k-limit" type="number" min="1" max="50" value="${Number(k.limit) || 20}" style="width:74px" /></label>
      <label class="tiny muted"><input type="checkbox" id="k-enrich"${k.enrich !== false ? ' checked' : ''} /> 补抓播放/点赞</label>
      <span class="spacer"></span>
      <button data-act="fetch-knowledge"${k.running ? ' disabled' : ''}>${k.running ? '抓取中…' : '立即抓取'}</button>
    </div>
    <div class="row" style="margin-top:8px">
      <input id="k-keywords" type="text" placeholder="关键词筛选（可选，逗号分隔）：AI, 大模型, 机器学习" value="${esc(k.keywords || '')}" />
    </div>
    <div class="tiny muted mt">调用 <code>node skills/fetch-bilibili-knowledge/scripts/run.mjs</code>，按发布时间倒序取知识区最新视频；遇 -352 风控先手动配置 Cookie。</div>
    ${result}
  </div>`;
}

function renderSchedule() {
  const el = $('#view-schedule');
  const sc = state.schedule;
  if (!sc?.job) { el.innerHTML = head('定时定点', '加载中…'); return; }
  const job = sc.job;
  const st = sc.state || {};
  const srv = sc.server || {};
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const times = (job.times || []).map((t) => `<span class="chip">${esc(t)}<button class="chip-x" data-act="rm-time" data-time="${esc(t)}" title="删除">×</button></span>`).join('');
  const days = dayNames.map((n, i) => `<label class="tiny"><input type="checkbox" data-day="${i}"${(job.days || []).includes(i) ? ' checked' : ''}/> 周${n}</label>`).join('');
  const runRows = (sc.runs || []).map((r) => `<tr>
    <td class="tiny">${stamp(r.at)}</td>
    <td>${pill(r.trigger === 'schedule' ? '定时' : '手动')}</td>
    <td>${r.status === 'success' ? pill('成功', 'ok') : pill('失败', 'bad')}</td>
    <td class="num">${r.count ?? '—'}</td>
    <td class="num">${r.durationMs == null ? '—' : `${(Math.round(r.durationMs / 100) / 10).toFixed(1)}s`}</td>
    <td class="tiny">${r.error ? `<b>${esc(r.error)}</b> ${esc(r.message || '')}` : (r.cache ? '缓存命中' : '实时抓取')}</td>
    <td class="tiny">${esc(r.runId || '')}</td></tr>`).join('');
  const cookie = sc.cookie || {};

  el.innerHTML = `
    ${head('定时定点', `到点自动获取知识区最新视频 · 只用确定性脚本，不经过 AI · 时区 ${esc(srv.timezone || 'local')}`,
      `<button data-act="run-schedule"${state.knowledge.running ? ' disabled' : ''}>立即执行一次</button><button class="ghost" data-act="refresh">刷新</button>`)}
    <div class="notice ai-free"><b>本页不使用 AI。</b>定时任务直接执行 <code>${esc(sc.script || 'skills/fetch-bilibili-knowledge/scripts/run.mjs')}</code>，没有 pi、没有 prompt、没有 token 消耗；服务由 <code>./webui/start.sh</code> 常驻，关掉服务定时也会停。</div>
    <div class="grid two">
      <div class="card">
        <div class="card-h">定点设置<span class="hint">每 ${srv.intervalSec || 20}s 检查一次</span></div>
        <div class="row" style="margin-bottom:10px">
          <label class="tiny"><input type="checkbox" id="s-enabled"${job.enabled ? ' checked' : ''}/> 启用定时</label>
          <span class="spacer"></span>
          ${job.enabled ? pill(job.nextRunAt ? `下次 ${stamp(job.nextRunAt)}` : '未安排', job.nextRunAt ? 'ok' : 'warn') : pill('已停用')}
        </div>
        <div class="field"><label>分区</label>
          <select id="s-tid">${(sc.zones || zonesOf()).map((z) => `<option value="${z.tid}"${Number(job.params?.tid) === z.tid ? ' selected' : ''}>${esc(z.name)}（${z.tid}）</option>`).join('')}</select>
        </div>
        <div class="row" style="gap:14px;align-items:flex-end">
          <div class="field" style="margin:0"><label>条数</label><input id="s-limit" type="number" min="1" max="50" value="${Number(job.params?.limit) || 20}" style="width:86px" /></div>
          <label class="tiny muted" style="padding-bottom:6px"><input type="checkbox" id="s-enrich"${job.params?.enrich !== false ? ' checked' : ''}/> 补抓播放/点赞</label>
        </div>
        <div class="field"><label>关键词筛选（可选，逗号分隔）</label>
          <input id="s-keywords" type="text" placeholder="AI,大模型,机器学习" value="${esc((job.params?.keywords || []).join(', '))}" />
          <div class="tiny muted">纯字符串匹配，不做语义判断（依然不使用 AI）。</div>
        </div>
        <div class="field mt"><label>定点时间（HH:MM，可多个）</label>
          <div class="row" style="gap:8px;flex-wrap:wrap">${times || '<span class="muted tiny">还没有时间点，先添加一个</span>'}</div>
          <div class="row" style="margin-top:8px"><input id="s-new-time" type="time" step="60" value="${esc(state.knowledge.newTime || '')}" /><button class="ghost small" data-act="add-time">添加时间点</button></div>
        </div>
        <div class="field"><label>星期</label><div class="row" style="gap:10px;flex-wrap:wrap">${days}</div></div>
        <div class="row"><button data-act="save-schedule">保存设置</button><button class="ghost" data-act="run-schedule"${state.knowledge.running ? ' disabled' : ''}>立即执行一次</button></div>
      </div>
      <div class="card">
        <div class="card-h">运行状态</div>
        <table><tbody>
          <tr><td class="muted">下次执行</td><td>${job.enabled && job.nextRunAt ? stamp(job.nextRunAt) : '<span class="muted">未安排</span>'}</td></tr>
          <tr><td class="muted">上次执行</td><td>${st.lastRunAt ? stamp(st.lastRunAt) : '<span class="muted">还没有跑过</span>'}</td></tr>
          <tr><td class="muted">上次结果</td><td>${st.lastStatus ? (st.lastStatus === 'success' ? pill('成功', 'ok') : pill(`失败 ${esc(st.lastError || '')}`, 'bad')) : '—'} ${st.lastCount != null ? `<span class="tiny muted">${st.lastCount} 条</span>` : ''}</td></tr>
          <tr><td class="muted">调度器</td><td>${pill(srv.schedulerActive ? `运行中 · 每 ${srv.intervalSec}s` : '未启动', srv.schedulerActive ? 'ok' : 'bad')} ${pill('不使用 AI', 'blue')}</td></tr>
          <tr><td class="muted">Cookie</td><td>${cookie.configured ? pill('已手动配置', 'ok') : pill('未配置', 'warn')} <a class="tiny" href="#sources" data-act="go-sources">去数据接口填 →</a></td></tr>
          <tr><td class="muted">产物</td><td class="tiny"><code>data/sources/bilibili-knowledge.json</code></td></tr>
        </tbody></table>
        <div class="tiny muted mt">定时到点后自动抓取并写回「数据接口」；失败会按同一时间点重试 1 次（下一个检查周期），并记在下方运行记录里。</div>
      </div>
    </div>
    <div class="card">
      <div class="card-h">最近运行<span class="hint">${(sc.runs || []).length} 条</span></div>
      <table><thead><tr><th>时间</th><th>触发</th><th>结果</th><th class="num">条数</th><th class="num">耗时</th><th>错误 / 缓存</th><th>run</th></tr></thead>
        <tbody>${runRows || '<tr><td colspan="7" class="muted">还没有运行记录</td></tr>'}</tbody></table>
    </div>`;
}

// ================================================================ 视图切换
const VIEWS = ['sources', 'dashboard', 'topics', 'create', 'publish', 'schedule'];
function switchView(name, updateHash = true) {
  if (!VIEWS.includes(name)) name = 'sources';
  state.view = name;
  for (const v of VIEWS) {
    const el = $('#view-' + v);
    if (el) el.classList.toggle('active', v === name);
  }
  for (const t of $$('#tabs .tab')) t.classList.toggle('active', t.dataset.view === name);
  if (updateHash) history.replaceState(null, '', '#' + name);
  render();
}

function render() {
  if (state.view === 'sources') renderSources();
  else if (state.view === 'dashboard') renderDashboard();
  else if (state.view === 'topics') renderTopics();
  else if (state.view === 'create') renderCreate();
  else if (state.view === 'publish') renderPublish();
  else if (state.view === 'schedule') renderSchedule();
}

// ================================================================ 创作流程
function setGlobal(status) {
  const el = $('#globalStatus');
  if (!el) return;
  el.className = 'pill' + (status ? ' warn' : '');
  el.textContent = status || '空闲';
  $('#stopBtn').style.display = status ? '' : 'none';
}

function clearCountdown() {
  if (cdTimer) clearInterval(cdTimer);
  cdTimer = null;
  cdLeft = 0;
}

function startCountdown(sec = 5) {
  clearCountdown();
  const deadline = Date.now() + sec * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    cdLeft = left;
    const n = $('#cdNum');
    if (n) n.textContent = String(left);
    if (Date.now() >= deadline) { clearCountdown(); doRender(); }
  };
  tick();
  cdTimer = setInterval(tick, 200); // 用截止时间算，标签页节流也不影响真实 5 秒
}

function pauseCountdown() {
  clearCountdown();
  const n = $('#cdNum');
  if (n) n.textContent = '⏸';
}

async function startScript() {
  const themeId = $('#c-theme')?.value || state.create.themeId;
  const themesPath = $('#c-file')?.value || state.create.themesPath;
  if (!themeId) { toast('先选一个主题', true); return; }
  state.create = { ...state.create, themeId, themesPath, stage: 'writing', draft: null, production: null, runId: null };
  render();
  setGlobal('写稿中');
  try {
    const r = await api('/api/create/script', { method: 'POST', body: JSON.stringify({ themeId, themesPath }) });
    if (!r.ok) {
      setGlobal(null);
      state.create.stage = 'idle'; render();
      toast(`写稿失败：${r.error?.code || 'UNKNOWN'} ${r.error?.message || ''}`, true);
      return;
    }
    state.create = { ...state.create, stage: 'review', runId: r.runId, draft: r.draft };
    setGlobal(null);
    render();
    startCountdown(5);
    $$('#view-create input, #view-create textarea').forEach((el) => {
      el.addEventListener('focus', pauseCountdown, { once: true });
      el.addEventListener('input', pauseCountdown, { once: true });
    });
  } catch (e) {
    setGlobal(null);
    state.create.stage = 'idle'; render();
    toast(e.message, true);
  }
}

function collectPatch() {
  const draft = state.create.draft;
  if (!draft) return {};
  const patch = {};
  const title = $('#e-title')?.value;
  const desc = $('#e-desc')?.value;
  const tags = $('#e-tags')?.value;
  if (title != null) patch.title = title;
  if (desc != null) patch.description = desc;
  if (tags != null) patch.tags = tags.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const mdText = $('#e-md')?.value;
  if (mdText != null && mdText !== draft.scriptMarkdown) patch.scriptMarkdown = mdText;
  const scenes = $$('#view-create .scene-row').map((row) => ({
    kind: draft.scenes[Number(row.dataset.i)]?.kind || 'point',
    heading: row.querySelector('[data-f=heading]').value,
    body: row.querySelector('[data-f=body]').value,
    durationSec: Number(row.querySelector('[data-f=durationSec]').value),
  }));
  if (scenes.length) patch.scenes = scenes;
  return patch;
}

async function doRender() {
  if (!state.create.runId) return;
  clearCountdown();
  const patch = collectPatch();
  state.create.stage = 'rendering';
  render();
  setGlobal('渲染中');
  try {
    const r = await api('/api/create/render', { method: 'POST', body: JSON.stringify({ runId: state.create.runId, patch }) });
    setGlobal(null);
    if (!r.ok) {
      state.create.stage = 'review'; render();
      toast(`渲染失败：${r.error?.code || 'UNKNOWN'} ${r.error?.message || ''}`, true);
      return;
    }
    state.create.stage = 'done';
    state.create.production = r.production;
    render();
    await loadAll({ quiet: true });
    toast('成片已生成');
  } catch (e) {
    setGlobal(null);
    state.create.stage = 'review'; render();
    toast(e.message, true);
  }
}

async function doPublish(real) {
  const runId = state.publish.runId;
  if (!runId) return;
  if (real) {
    const ok = await dialog({
      title: '真实投稿到 B 站',
      bodyHtml: `<p class="muted">会打开浏览器自动上传并提交，默认公开。提交前请确认标题/简介/标签/封面无误。</p>
        <p class="muted">提交后无法撤回修改，只能人工去 B 站改。</p>`,
      okText: '继续',
      requireText: '投稿',
    });
    if (!ok) return;
  }
  const metadata = {
    title: $('#p-title')?.value,
    description: $('#p-desc')?.value,
    tags: ($('#p-tags')?.value || '').split(/[,，\s]+/).filter(Boolean),
  };
  state.publish.busy = true;
  setGlobal(real ? '投稿中' : '预检中');
  try {
    const r = await api('/api/publish', { method: 'POST', body: JSON.stringify({ runId, publish: real, metadata }) });
    state.publish.record = r.record;
    setGlobal(null);
    await loadAll({ quiet: true });
    renderPublish();
    const st = r.record?.status || 'unknown';
    if (st === 'manual_fallback') toast('预检通过，未开启真实投稿（只记录，不上传）');
    else if (st === 'published' || st === 'submitted') toast(`已提交：${r.record.platformVideoId || r.record.url || ''}`);
    else toast(`发布未完成：${r.record?.error?.code || st}`, true);
  } catch (e) {
    setGlobal(null);
    toast(e.message, true);
  } finally {
    state.publish.busy = false;
  }
}

// ================================================================ 运行 / 日志
const logLines = [];
function appendLog(stream, line) {
  logLines.push({ stream, line });
  if (logLines.length > 3000) logLines.splice(0, 1000);
  const box = $('#log');
  if (!box) return;
  const nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const cls = /^\[run\]/.test(line) ? 'event' : /error|FAILED|失败|Error/i.test(line) ? 'err' : '';
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = line;
  box.appendChild(div);
  if ($('#autoscroll').checked && nearBottom) box.scrollTop = box.scrollHeight;
  $('#logCount').textContent = `${logLines.length} 行`;
  $('#logHint').textContent = line.slice(0, 90);
}

function openStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'hello' && ev.active) {
      setGlobal(`运行中 · ${ev.active.pipeline}`);
      $('#log').innerHTML = '';
    } else if (ev.type === 'started') {
      setGlobal(`运行中 · ${ev.pipeline}`);
      $('#stopBtn').dataset.run = ev.runId;
    } else if (ev.type === 'log') {
      appendLog(ev.stream, ev.line);
    } else if (ev.type === 'event') {
      appendLog('event', `[run] ${ev.name} ${ev.stepId || ''} ${ev.status || ''}`);
    } else if (ev.type === 'done') {
      setGlobal(null);
      if (!ev.adhoc) loadAll({ quiet: true }).then(render);
    }
  };
  es.onerror = () => { /* EventSource 会自动重连 */ };
}

async function stopRun() {
  const runId = $('#stopBtn').dataset.run || state.running?.runId;
  if (!runId) return;
  try { await api('/api/stop', { method: 'POST', body: JSON.stringify({ runId }) }); toast('已发送停止信号'); }
  catch (e) { toast(e.message, true); }
}

// ================================================================ 数据采集（禁止 AI）/ 定时定点
function syncKnowledgeForm() {
  const tid = Number($('#k-tid')?.value);
  if (tid) state.knowledge.tid = tid;
  const limit = Number($('#k-limit')?.value);
  if (limit) state.knowledge.limit = limit;
  const en = $('#k-enrich');
  if (en) state.knowledge.enrich = en.checked;
  const kw = $('#k-keywords');
  if (kw) state.knowledge.keywords = kw.value;
}

function currentScheduleJob() {
  const src = state.schedule?.job || {};
  const job = { ...src, params: { ...(src.params || {}) }, times: [...(src.times || [])], days: [...(src.days || [])] };
  const en = $('#s-enabled');
  if (en) job.enabled = en.checked;
  const tid = Number($('#s-tid')?.value);
  if (tid) job.params.tid = tid;
  const limit = Number($('#s-limit')?.value);
  if (limit) job.params.limit = limit;
  const enr = $('#s-enrich');
  if (enr) job.params.enrich = enr.checked;
  const kw = $('#s-keywords');
  if (kw) job.params.keywords = kw.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  if ($('#view-schedule')) {
    job.days = $$('#view-schedule [data-day]').filter((x) => x.checked).map((x) => Number(x.dataset.day));
  }
  return job;
}

function hotResultLine() {
  const r = state.hot.result;
  if (!r) return '';
  return `<div class="row tiny" style="margin-bottom:8px">
    ${pill('B 站热门（不使用 AI）', 'blue')}
    ${pill(r.ok ? `${r.count} 条` : '失败', r.ok ? 'ok' : 'bad')}
    ${r.timestamp ? pill(`抓取自 ${stamp(r.timestamp)}`) : ''}
    ${r.cache ? pill(r.cache.hit ? '缓存命中' : '实时抓取') : ''}
    ${r.error ? `<span class="tiny" style="color:var(--red)">${esc(r.error.code)} ${esc(r.error.message || '')}</span>` : ''}
  </div>`;
}

async function fetchHot() {
  if (state.hot.running) return;
  state.hot.running = true;
  render();
  setGlobal('抓取热门');
  try {
    const r = await api('/api/fetch/hot', { method: 'POST', body: JSON.stringify({ limit: 50 }) });
    state.hot.result = r;
    toast(r.ok ? `抓到 ${r.count} 条热门样本（不使用 AI）` : `抓取失败：${r.error?.code || 'UNKNOWN'} ${r.error?.message || ''}`, !r.ok);
    await loadAll({ quiet: true });
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.hot.running = false;
    setGlobal(null);
    render();
  }
}

async function saveCookie() {
  const raw = $('#cookie-input')?.value || '';
  if (!raw.trim()) { toast('先粘贴 B 站 Cookie', true); return; }
  try {
    const r = await api('/api/cookie', { method: 'POST', body: JSON.stringify({ cookie: raw }) });
    if (state.data) state.data.cookie = r;
    if (state.schedule) state.schedule.cookie = r;
    const box = $('#cookie-input');
    if (box) box.value = '';
    render();
    toast('Cookie 已保存到本机（0600），不会进入日志/产物');
  } catch (e) { toast(e.message, true); }
}

async function removeCookie() {
  const ok = await dialog({
    title: '清除 Cookie',
    bodyHtml: '<p class="muted">会删除 <code>data/secrets/bilibili-cookie.txt</code>。下次遇到 B 站风控（-352）时需要重新手动粘贴。</p>',
    okText: '清除',
  });
  if (!ok) return;
  try {
    const r = await api('/api/cookie', { method: 'DELETE' });
    if (state.data) state.data.cookie = r;
    if (state.schedule) state.schedule.cookie = r;
    render();
    toast('Cookie 已清除');
  } catch (e) { toast(e.message, true); }
}

async function fetchKnowledge() {
  if (state.knowledge.running) return;
  syncKnowledgeForm();
  state.knowledge.running = true;
  render();
  setGlobal('抓取知识区');
  try {
    const r = await api('/api/fetch/knowledge', {
      method: 'POST',
      body: JSON.stringify({
        tid: state.knowledge.tid,
        limit: state.knowledge.limit,
        enrich: state.knowledge.enrich,
        keywords: String(state.knowledge.keywords || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
      }),
    });
    state.knowledge.result = r;
    toast(r.ok ? `抓到 ${r.count} 条知识区最新视频` : `抓取失败：${r.error?.code || 'UNKNOWN'} ${r.error?.message || ''}`, !r.ok);
    await loadAll({ quiet: true });
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.knowledge.running = false;
    setGlobal(null);
    render();
  }
}

async function saveSchedule() {
  const job = currentScheduleJob();
  if (!job.times.length) { toast('至少添加一个定点时间', true); return; }
  if (!job.days.length) { toast('至少选一天', true); return; }
  try {
    const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify({ job }) });
    state.schedule = { ...state.schedule, ...r };
    render();
    toast('定时设置已保存');
  } catch (e) { toast(e.message, true); }
}

async function runScheduleNow() {
  if (state.knowledge.running) return;
  state.knowledge.running = true;
  render();
  setGlobal('定点抓取');
  try {
    const r = await api('/api/schedule/run', { method: 'POST', body: JSON.stringify({ job: currentScheduleJob() }) });
    state.schedule = { ...state.schedule, ...r };
    await loadAll({ quiet: true });
    const e = r.entry || {};
    toast(r.ok ? `抓取成功：${e.count || 0} 条（不使用 AI）` : `抓取失败：${e.error || 'UNKNOWN'} ${e.message || ''}`, !r.ok);
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.knowledge.running = false;
    setGlobal(null);
    render();
  }
}

function addTimePoint() {
  const v = String($('#s-new-time')?.value || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) { toast('先选一个时间点（HH:MM）', true); return; }
  const job = currentScheduleJob();
  job.times = [...new Set([...job.times, v])].sort();
  state.schedule = { ...state.schedule, job: { ...state.schedule.job, ...job } };
  state.knowledge.newTime = '';
  render();
}

// ================================================================ 事件
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;

  if (act === 'refresh') { await loadAll(); return; }

  if (act === 'fetch-data' || act === 'regen-topics') {
    const ok = await dialog({
      title: act === 'regen-topics' ? '重新生成选题' : '抓取最新数据',
      bodyHtml: `<p class="muted">会跑完整数据流水线：B 站热门 → 内部数据 → 重建看板 → pi 推荐 6 个主题。</p>
        <p class="muted">耗时 1–3 分钟，约 18 万 token。</p>`,
      okText: '开跑',
    });
    if (!ok) return;
    try {
      await api('/api/run', { method: 'POST', body: JSON.stringify({ pipeline: 'trends-analysis', options: {} }) });
      toast('已开始，看底部日志');
      $('#logbar').classList.add('open');
    } catch (err) { toast(err.message, true); }
    return;
  }

  if (act === 'save-cookie') { await saveCookie(); return; }
  if (act === 'clear-cookie') { await removeCookie(); return; }
  if (act === 'fetch-knowledge') { await fetchKnowledge(); return; }
  if (act === 'fetch-hot') { await fetchHot(); return; }
  if (act === 'save-schedule') { await saveSchedule(); return; }
  if (act === 'run-schedule') { await runScheduleNow(); return; }
  if (act === 'add-time') { addTimePoint(); return; }
  if (act === 'rm-time') {
    const job = currentScheduleJob();
    job.times = job.times.filter((x) => x !== t.dataset.time);
    state.schedule = { ...state.schedule, job: { ...state.schedule.job, ...job } };
    render();
    return;
  }
  if (act === 'go-sources') { switchView('sources'); return; }

  if (act === 'use-theme') {
    state.create = { stage: 'idle', themeId: t.dataset.theme, themesPath: t.dataset.path || 'data/themes/latest.json', runId: null, draft: null, production: null };
    switchView('create');
    return;
  }

  if (act === 'start-script') { await startScript(); return; }
  if (act === 'pause') { pauseCountdown(); toast('已暂停，改完点「立即渲染」'); return; }
  if (act === 'render-now') { await doRender(); return; }
  if (act === 'rewrite') {
    const ok = await dialog({ title: '重新写稿', bodyHtml: '<p class="muted">会丢弃当前稿子，重新跑一次写稿（约 3 万 token）。</p>', okText: '重写' });
    if (ok) { state.create.stage = 'idle'; render(); await startScript(); }
    return;
  }
  if (act === 'reset-create') { clearCountdown(); state.create = { stage: 'idle', themeId: state.create.themeId, themesPath: state.create.themesPath, runId: null, draft: null, production: null }; render(); return; }
  if (act === 'go-publish') { state.publish.runId = t.dataset.run; switchView('publish'); return; }
  if (act === 'select-prod') { state.publish.runId = t.dataset.run; state.publish.record = null; renderPublish(); return; }
  if (act === 'precheck') { await doPublish(false); return; }
  if (act === 'publish-real') { await doPublish(true); return; }
  if (act === 'open-run') { state.publish.runId = t.dataset.run; switchView('publish'); return; }
  if (act === 'stop') { await stopRun(); return; }
});

$('#logHandle').addEventListener('click', (e) => {
  if (e.target.closest('#stopBtn') || e.target.closest('input')) return;
  $('#logbar').classList.toggle('open');
});
$('#stopBtn').addEventListener('click', stopRun);
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) switchView(t.dataset.view);
});

// 表单改动先写回 state（不重渲染，避免输入被打断），点保存/执行时再提交
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('#view-sources')) {
    if (t.id === 'k-tid') state.knowledge.tid = Number(t.value) || 36;
    else if (t.id === 'k-limit') state.knowledge.limit = Math.min(50, Math.max(1, Number(t.value) || 20));
    else if (t.id === 'k-enrich') state.knowledge.enrich = t.checked;
    else if (t.id === 'k-keywords') state.knowledge.keywords = t.value;
    return;
  }
  if (t.closest('#view-schedule')) {
    const job = state.schedule?.job;
    if (!job) return;
    if (t.id === 's-enabled') job.enabled = t.checked;
    else if (t.id === 's-tid') job.params = { ...(job.params || {}), tid: Number(t.value) || 36 };
    else if (t.id === 's-limit') job.params = { ...(job.params || {}), limit: Math.min(50, Math.max(1, Number(t.value) || 20)) };
    else if (t.id === 's-enrich') job.params = { ...(job.params || {}), enrich: t.checked };
    else if (t.id === 's-keywords') job.params = { ...(job.params || {}), keywords: t.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean) };
    else if (t.id === 's-new-time') state.knowledge.newTime = t.value;
    else if (t.dataset.day != null) {
      const d = Number(t.dataset.day);
      job.days = t.checked ? [...new Set([...(job.days || []), d])].sort((a, b) => a - b) : (job.days || []).filter((x) => x !== d);
    }
  }
});
window.addEventListener('hashchange', () => switchView(location.hash.slice(1) || 'sources', false));

// ================================================================ 启动
(async function boot() {
  const initial = location.hash.slice(1);
  if (VIEWS.includes(initial)) state.view = initial;
  for (const t of $$('#tabs .tab')) t.classList.toggle('active', t.dataset.view === state.view);
  for (const v of VIEWS) $('#view-' + v).classList.toggle('active', v === state.view);
  if (STATIC) {
    document.body.classList.add('is-static');
    const b = document.createElement('div');
    b.className = 'static-banner';
    b.innerHTML = `<b>静态演示站</b> · 只读数据快照（选题/成片/预检结果），流水线需要本地 <code>./webui/start.sh</code>
      <a href="https://github.com/auulb/mediaOPC" target="_blank" rel="noreferrer">源码 ↗</a>`;
    document.body.prepend(b);
    $('#stopBtn')?.remove();
  }
  try {
    await loadAll();
  } catch (e) {
    toast(`加载失败：${e.message}`, true);
  }
  if (!STATIC) openStream();
})();
