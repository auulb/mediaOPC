#!/usr/bin/env node
// OPC Web 控制台：把命令行包装成按钮。
// 零依赖（只用 Node 内置模块 + 根目录已有的 yaml），不改 A/B 的任何文件。
//
//   node webui/server.mjs          → http://127.0.0.1:4180
//   OPC_WEB_PORT=8080 node webui/server.mjs
//   OPC_WEB_NO_OPEN=1             → 不自动开浏览器
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.OPC_WEB_PORT || 4180);
const HOST = process.env.OPC_WEB_HOST || '127.0.0.1';

// ---------------------------------------------------------------- 小工具
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
const bad = (res, code, msg) => json(res, code, { error: msg });

function safePath(relPath) {
  const abs = path.resolve(ROOT, String(relPath || ''));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

// 能被浏览器直接读取的目录白名单（绝不能把 data/browser-profiles 里的 cookie 暴露出去）
const MEDIA_ALLOW = ['data/productions/', 'data/scripts/', 'data/themes/', 'dashboard/', 'logs/', 'workspace/'];
const mediaAllowed = (rel) => MEDIA_ALLOW.some((p) => rel.startsWith(p)) && !rel.includes('..');

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}


// ---------------------------------------------------------------- 业务视图（数据接口 / 看板 / 选题 / 成片）
const relOf = (abs) => path.relative(ROOT, abs);
const urlOf = (item) => item.url || (item.id && /^BV/.test(item.id) ? `https://www.bilibili.com/video/${item.id}` : null);

function latestAttempt(stepDir) {
  try {
    const atts = fs.readdirSync(stepDir).filter((d) => /^attempt-\d+$/.test(d));
    if (!atts.length) return null;
    atts.sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    return path.join(stepDir, atts[atts.length - 1]);
  } catch { return null; }
}

function readStepOutput(runId, stepId) {
  const att = latestAttempt(path.join(ROOT, 'workspace', runId, stepId));
  if (!att) return null;
  return {
    dir: relOf(att),
    output: readJson(path.join(att, 'output.json')),
    error: readJson(path.join(att, 'error.json')),
    envelope: readJson(path.join(att, 'envelope.json')),
  };
}

function sourcesView() {
  const dash = readJson(path.join(ROOT, 'dashboard/dashboard.json'));
  const list = [];
  for (const src of dash?.sources || []) {
    if (src.kind !== 'raw-items') continue; // token-ledger / task-status 不是采集接口
    const doc = readJson(safePath(src.file) || '');
    const items = Array.isArray(doc?.items) ? doc.items : [];
    list.push({
      id: src.id,
      dataSource: src.dataSource || 'unknown',
      kind: src.kind,
      timestamp: src.timestamp || doc?.timestamp || null,
      file: src.file,
      count: items.length,
      fields: items[0] ? Object.keys(items[0]) : [],
      items: items.map((i) => ({
        id: i.id, title: i.title, url: urlOf(i), platform: i.platform || doc?.platform || null,
        channel: i.channel?.name || null, views: i.views ?? null, likes: i.likes ?? null,
        comments: i.comments ?? null, shares: i.shares ?? null, favorites: i.favorites ?? null,
        engagement: i.metrics?.engagement ?? null, viewsPerHour: i.metrics?.viewsPerHour ?? null,
        velocity: i.metrics?.velocity ?? null, tags: i.tags || [], category: i.category || null,
        durationSec: i.durationSec ?? null, publishDate: i.publishDate || null,
        internal: i.internal || null,
      })),
    });
  }
  const creators = new Map();
  for (const src of list) {
    const isInternal = /internal/.test(src.dataSource);
    for (const i of src.items) {
      if (!i.channel) continue;
      const key = `${isInternal ? 'internal' : 'external'}:${i.channel}`;
      const cur = creators.get(key) || { name: i.channel, internal: isInternal, items: 0, views: 0, likes: 0, engagementSum: 0, rising: 0, tags: new Set(), ids: [] };
      cur.items += 1;
      cur.views += i.views || 0;
      cur.likes += i.likes || 0;
      cur.engagementSum += i.engagement || 0;
      if (i.velocity === 'rising') cur.rising += 1;
      for (const t of i.tags || []) cur.tags.add(t);
      cur.ids.push(i.id);
      creators.set(key, cur);
    }
  }

  const platforms = [...new Set(list.filter((x) => !/internal/.test(x.dataSource))
    .map((x) => (x.items[0]?.platform || '').toLowerCase()).filter(Boolean))];
  const hasCreator = list.some((x) => x.items.some((i) => i.channel));
  return {
    generatedAt: dash?.generatedAt || null,
    sources: list,
    creators: [...creators.values()].map((c) => ({
      ...c,
      tags: [...c.tags].slice(0, 5),
      avgEngagement: c.items ? c.engagementSum / c.items : null,
    })).sort((a, b) => b.views - a.views),
    coverage: {
      platforms,
      hasDouyin: platforms.includes('douyin'),
      hasCreatorMetrics: hasCreator,
      gaps: [
        ...(platforms.includes('douyin') ? [] : ['抖音热门 / 同赛道数据未接入（adapter 未实现）']),
        ...(hasCreator ? [] : ['同领域优秀博主榜单未接入']),
        '平台只返回 Top3 样本，样本量偏小（fetch-bilibili 的 limit 参数）',
      ],
    },
  };
}

function dashboardView() {
  const dash = readJson(path.join(ROOT, 'dashboard/dashboard.json'));
  const files = ['dashboard.json', 'external_trends.json', 'internal_performance.json', 'token_usage.json', 'task_status.json']
    .map((f) => {
      const abs = path.join(ROOT, 'dashboard', f);
      return { file: `dashboard/${f}`, mtime: exists(abs) ? fs.statSync(abs).mtime.toISOString() : null };
    });
  const budget = (() => {
    try {
      const y = parseYaml(readText(path.join(ROOT, 'config/token-budget.yaml')) || '') || {};
      return y;
    } catch { return null; }
  })();
  return {
    generatedAt: dash?.generatedAt || null,
    external: dash?.externalTrends || null,
    internal: dash?.internalPerformance || null,
    tokens: dash?.tokenUsage || null,
    tasks: dash?.taskStatus || null,
    budget,
    files,
  };
}

function scheduleView() {
  try {
    const y = parseYaml(readText(path.join(ROOT, 'config/schedule.yaml')) || '') || {};
    return (y.schedules || []).map((s) => ({ name: s.name, cron: s.cron, pipeline: s.pipeline, enabled: Boolean(s.enabled), manualApproval: Boolean(s.manual_approval) }));
  } catch { return []; }
}

function scanProductions() {
  const ws = path.join(ROOT, 'workspace');
  if (!exists(ws)) return [];
  const byId = new Map();
  for (const run of fs.readdirSync(ws)) {
    const renderDir = path.join(ws, run, 'render');
    if (!exists(renderDir)) continue;
    const att = latestAttempt(renderDir);
    if (!att) continue;
    const prod = readJson(path.join(att, 'output.json'));
    if (!prod || !prod.video?.path) continue;
    const pub = readStepOutput(run, 'publish');
    const publish = pub?.output ? {
      status: pub.output.status, url: pub.output.url || null,
      platformVideoId: pub.output.platformVideoId || null, publishId: pub.output.publishId || null,
      error: pub.output.error || null, precheck: pub.output.precheck || null,
    } : null;
    byId.set(prod.productionId, {
      ...prod,
      coverPortrait: prod.coverPortrait || null,
      runId: run,
      renderDir: relOf(att),
      publish,
      videoExists: exists(safePath(prod.video.path) || ''),
      coverExists: prod.cover?.path ? exists(safePath(prod.cover.path) || '') : false,
      coverPortraitExists: prod.coverPortrait?.path ? exists(safePath(prod.coverPortrait.path) || '') : false,
    });
  }
  return [...byId.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function topicUsage() {
  const map = new Map();
  for (const p of scanProductions()) {
    const tid = p.themeId;
    if (!tid) continue;
    const cur = map.get(tid) || { themeId: tid, productions: [], published: null };
    cur.productions.push({ productionId: p.productionId, runId: p.runId, createdAt: p.createdAt });
    if (p.publish && ['published', 'submitted'].includes(p.publish.status)) cur.published = p.publish;
    map.set(tid, cur);
  }
  return map;
}

function topicsView() {
  const usage = topicUsage();
  const seen = new Set();
  const themes = [];
  const files = [];
  for (const src of themeSources()) {
    if (src.path.startsWith('fixtures/')) continue; // 样例数据不进主题库
    const doc = readJson(path.join(ROOT, src.path));
    if (!doc?.themes) continue;
    files.push({ path: src.path, label: src.label, generatedAt: doc.generatedAt || null, count: doc.themes.length });
    for (const t of doc.themes) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const u = usage.get(t.id) || null;
      themes.push({
        ...t,
        themesFile: src.path,
        usage: u ? { productions: u.productions.length, published: Boolean(u.published), last: u.productions[u.productions.length - 1] || null } : { productions: 0, published: false, last: null },
      });
    }
  }
  const rank = (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0);
  // 推荐只取“当前选题”那一份，避免把历史文件 / fixture 混进来
  const primaryPath = files.find((f) => f.path === 'data/themes/latest.json')?.path || files[0]?.path || null;
  const primary = themes.filter((t) => t.themesFile === primaryPath);
  return {
    files,
    primaryPath,
    themes,
    recommendations: {
      external: primary.filter((t) => t.source === 'external').sort(rank).slice(0, 3),
      internal: primary.filter((t) => t.source === 'internal').sort(rank).slice(0, 3),
    },
    counts: { total: themes.length, external: themes.filter((t) => t.source === 'external').length, internal: themes.filter((t) => t.source === 'internal').length, published: themes.filter((t) => t.usage.published).length },
  };
}

// ---------------------------------------------------------------- 单步执行（创作/发布流水线用）
function runChild({ runId, pipeline, args, env = {}, onDone }) {
  if (activeRunId) throw Object.assign(new Error(`已有任务在运行：${activeRunId}，请等它结束或先停止`), { status: 409 });
  const state = { runId, pipeline, lines: [], startedAt: Date.now(), child: null, stopping: false, adhoc: true };
  live.set(runId, state);
  activeRunId = runId;

  const logFile = path.join(ROOT, 'workspace', runId, 'console.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const push = (stream, line) => {
    const item = { stream, line, t: Date.now() };
    state.lines.push(item);
    if (state.lines.length > 5000) state.lines.splice(0, 1000);
    broadcast({ type: 'log', runId, ...item });
  };

  const fullEnv = { ...process.env, ...env };
  const child = spawn(process.execPath, args, { cwd: ROOT, env: fullEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;
  const wire = (stream, chunk) => {
    fs.writeSync(fd, chunk);
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      push(stream, line);
      const m = /^\[run\]\s+(step_start|step_end|run_start|run_end)\s*(\S*)\s*(\S*)/.exec(line);
      if (m) broadcast({ type: 'event', runId, name: m[1], stepId: m[2] || null, status: m[3] || null });
    }
  };
  child.stdout.on('data', (c) => wire('stdout', c));
  child.stderr.on('data', (c) => wire('stderr', c));

  broadcast({ type: 'started', runId, pipeline, startedAt: state.startedAt });

  return new Promise((resolve) => {
    child.on('error', (e) => push('stderr', `启动失败：${e.message}`));
    child.on('exit', (code, signal) => {
      try { fs.closeSync(fd); } catch {}
      state.exitCode = code;
      state.finishedAt = Date.now();
      activeRunId = null;
      let extra = null;
      try { extra = onDone ? onDone(code) : null; } catch {}
      broadcast({ type: 'done', runId, code, signal, run: null, adhoc: true, extra });
      resolve({ code, signal, logFile: relOf(logFile), extra });
    });
  });
}

const cleanTags = (tags) => (Array.isArray(tags) ? tags : [])
  .map((t) => String(t).trim().slice(0, 20)).filter(Boolean)
  .filter((t, i, a) => a.indexOf(t) === i).slice(0, 10);

function patchScriptDraft(draft, patch = {}) {
  const out = JSON.parse(JSON.stringify(draft));
  if (patch.title != null) out.metadataDraft.title = String(patch.title).trim().slice(0, 80);
  if (patch.description != null) out.metadataDraft.description = String(patch.description).slice(0, 2000);
  if (patch.tags != null) out.metadataDraft.tags = cleanTags(patch.tags);
  if (Array.isArray(patch.scenes)) {
    if (patch.scenes.length < 2 || patch.scenes.length > 12) throw Object.assign(new Error('分镜数量必须是 2–12 个'), { status: 400 });
    out.storyboard.scenes = patch.scenes.map((s, i) => {
      const kind = ['title', 'point', 'outro'].includes(s.kind) ? s.kind : (i === 0 ? 'title' : 'point');
      const heading = String(s.heading || '').trim();
      if (!heading) throw Object.assign(new Error(`第 ${i + 1} 个分镜缺标题`), { status: 400 });
      const durationSec = Number(s.durationSec);
      if (!(durationSec >= 2 && durationSec <= 20)) throw Object.assign(new Error(`第 ${i + 1} 个分镜时长需在 2–20 秒`), { status: 400 });
      return { kind, heading: heading.slice(0, 24), ...(s.body ? { body: String(s.body).slice(0, 60) } : {}), durationSec };
    });
  }
  return out;
}

// ---------------------------------------------------------------- pipeline 元信息
const UI = {
  'create-video': { title: '一键出片', icon: '🎬', desc: '写稿 → 渲染成片 → 发布预检（可选真投稿）', accent: 'create' },
  'trends-analysis': { title: '抓数据 + 选题', icon: '📈', desc: 'B 站热门 → 看板 → pi 推荐 6 个候选主题', accent: 'data' },
  'echo-smoke': { title: '冒烟：跑单步', icon: '🧪', desc: '验证调度器 + pi 通路，秒级完成', accent: 'smoke' },
  'echo-chain': { title: '冒烟：两步串联', icon: '🔗', desc: '验证 depends_on 与产物拷贝', accent: 'smoke' },
  'echo-retry-smoke': { title: '冒烟：失败重试', icon: '🔁', desc: '验证重试与 token 账本', accent: 'smoke' },
  'echo-fail': { title: '冒烟：预期失败', icon: '💥', desc: '验证失败判定与 error.json', accent: 'smoke' },
};

function loadPipelines() {
  const out = [];
  const push = (id, def, configFile) => {
    const meta = UI[id] || { title: id, icon: '⚙️', desc: def.description || '', accent: 'smoke' };
    out.push({
      id,
      ...meta,
      description: def.description || meta.desc,
      configFile,
      steps: (def.steps || []).map((s) => ({ id: s.id, skill: s.skill, depends_on: s.depends_on || [], contract: s.contract || null })),
      options: id === 'create-video' ? { themes: true, theme: true, publish: true } : {},
    });
  };
  const main = parseYaml(readText(path.join(ROOT, 'config/pipeline.yaml')) || '') || {};
  for (const [id, def] of Object.entries(main.pipelines || {})) push(id, def, 'config/pipeline.yaml');
  const cFile = 'plugins/publishers/pipelines/create-video.yaml';
  const c = parseYaml(readText(path.join(ROOT, cFile)) || '') || {};
  for (const [id, def] of Object.entries(c.pipelines || {})) push(id, def, cFile);
  // 创作链路置顶，冒烟自检沉底
  const rank = { 'create-video': 0, 'trends-analysis': 1 };
  return out.sort((a, b) => (rank[a.id] ?? 9) - (rank[b.id] ?? 9) || a.id.localeCompare(b.id));
}

function themeSources() {
  const list = [];
  const add = (rel, label) => {
    const doc = readJson(path.join(ROOT, rel));
    if (!doc || !Array.isArray(doc.themes) || !doc.themes.length) return;
    const top = doc.themes.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a), doc.themes[0]);
    list.push({ path: rel, label, count: doc.themes.length, generatedAt: doc.generatedAt || null, top: top.title || top.id });
  };
  add('data/themes/latest.json', '当前选题');
  const ws = path.join(ROOT, 'workspace');
  if (exists(ws)) {
    for (const run of fs.readdirSync(ws).sort().reverse()) {
      const dir = path.join(ws, run, 'recommend');
      if (!exists(dir)) continue;
      for (const att of fs.readdirSync(dir).sort().reverse()) {
        add(`workspace/${run}/recommend/${att}/output.json`, `选题 · ${run}`);
      }
    }
  }
  add('fixtures/recommend-themes/output.json', '样例选题（fixture）');
  const seen = new Set();
  return list.filter((x) => (seen.has(x.path) ? false : seen.add(x.path)));
}

function listRuns(limit = 40) {
  const ws = path.join(ROOT, 'workspace');
  if (!exists(ws)) return [];
  const out = [];
  for (const d of fs.readdirSync(ws)) {
    const run = readJson(path.join(ws, d, 'run.json'));
    if (!run) continue;
    out.push({
      runId: run.runId || d,
      pipelineId: run.pipelineId,
      status: run.status,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || null,
      tokens: (run.steps || []).reduce((a, s) => a + (s.tokens || 0), 0),
    });
  }
  out.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return out.slice(0, limit);
}

function buildRunView(runId) {
  const dir = path.join(ROOT, 'workspace', runId);
  const run = readJson(path.join(dir, 'run.json'));
  if (!run) return null;
  const steps = (run.steps || []).map((s) => {
    const output = s.output ? readJson(s.output) : null;
    const errFile = s.output ? path.join(path.dirname(s.output), 'error.json') : null;
    return { ...s, output, errorDetail: errFile && exists(errFile) ? readJson(errFile) : null };
  });
  const art = { theme: null, video: null, cover: null, script: null, scriptMd: null, storyboard: null, production: null, publish: null, publishId: null };
  for (const s of steps) {
    const o = s.output;
    if (!o) continue;
    if (o.video && o.video.path) { art.production = o; art.video = o.video; art.cover = o.cover || null; }
    if (o.script && o.script.path) { art.script = o.script.path; art.scriptMd = readText(safePath(o.script.path)); }
    if (o.script && o.script.storyboardPath) art.storyboard = readJson(safePath(o.script.storyboardPath));
    if (o.publishId) { art.publish = o; art.publishId = o.publishId; }
    if (o.sourceRef && o.sourceRef.themesFile && o.sourceRef.themeId) {
      const themes = readJson(safePath(o.sourceRef.themesFile));
      const t = themes?.themes?.find((x) => x.id === o.sourceRef.themeId);
      if (t) art.theme = { id: t.id, title: t.title, angle: t.angle || null, confidence: t.confidence ?? null, durationSec: t.brief?.durationSec ?? null, themesFile: o.sourceRef.themesFile };
    }
  }
  return { run, steps, artifacts: art, log: readText(path.join(dir, 'console.log')) };
}

// ---------------------------------------------------------------- 运行中的任务
const live = new Map(); // runId -> { lines, subs, child, startedAt, pipeline, stopping }
const SUBS = new Set(); // SSE 客户端
let activeRunId = null;

function broadcast(ev) {
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const s of SUBS) {
    try { s.write(payload); } catch { /* 客户端已断开 */ }
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const cleanId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

function startRun({ pipeline, options = {} }) {
  if (activeRunId) throw Object.assign(new Error(`已有任务在运行：${activeRunId}，请等它结束或先停止`), { status: 409 });
  const def = loadPipelines().find((p) => p.id === pipeline);
  if (!def) throw Object.assign(new Error(`未知 pipeline：${pipeline}`), { status: 400 });

  if (def.options.themes && options.themesPath) {
    const src = safePath(options.themesPath);
    if (!src || !exists(src)) throw Object.assign(new Error(`选题文件不存在：${options.themesPath}`), { status: 400 });
    const target = path.join(ROOT, 'data/themes/latest.json');
    if (path.resolve(src) !== target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
    }
  }

  const runId = cleanId(options.runId) || `${pipeline}-${stamp()}`;
  const env = { ...process.env };
  if (def.options.publish) {
    if (options.publish) env.OPC_PUBLISH_ENABLED = '1';
    else delete env.OPC_PUBLISH_ENABLED;
  }
  if (def.options.theme && options.themeId) env.OPC_THEME_ID = String(options.themeId);
  else delete env.OPC_THEME_ID;

  const args = ['bin/opc', 'run', pipeline, '--launcher', 'spawn', '--run-id', runId, '--verbose'];
  if (def.configFile && def.configFile !== 'config/pipeline.yaml') args.push('--pipeline-config', def.configFile);

  const state = { runId, pipeline, lines: [], startedAt: Date.now(), child: null, stopping: false };
  live.set(runId, state);
  activeRunId = runId;

  const logFile = path.join(ROOT, 'workspace', runId, 'console.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');

  const push = (stream, line) => {
    const item = { stream, line, t: Date.now() };
    state.lines.push(item);
    if (state.lines.length > 5000) state.lines.splice(0, 1000);
    broadcast({ type: 'log', runId, ...item });
  };

  const child = spawn(process.execPath, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;

  const wire = (stream, chunk) => {
    fs.writeSync(fd, chunk);
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      push(stream, line);
      const m = /^\[run\]\s+(step_start|step_end|run_start|run_end)\s*(\S*)\s*(\S*)/.exec(line);
      if (m) broadcast({ type: 'event', runId, name: m[1], stepId: m[2] || null, status: m[3] || null });
    }
  };
  child.stdout.on('data', (c) => wire('stdout', c));
  child.stderr.on('data', (c) => wire('stderr', c));

  child.on('error', (e) => {
    push('stderr', `启动失败：${e.message}`);
  });

  child.on('exit', (code, signal) => {
    try { fs.closeSync(fd); } catch {}
    const view = buildRunView(runId);
    state.exitCode = code;
    state.exitSignal = signal;
    state.finishedAt = Date.now();
    activeRunId = null;
    broadcast({ type: 'done', runId, code, signal, run: view?.run || null });
  });

  broadcast({ type: 'started', runId, pipeline, startedAt: state.startedAt });
  return { runId, pipeline, logFile: path.relative(ROOT, logFile) };
}

function stopRun(runId) {
  const state = live.get(runId);
  if (!state || !state.child) throw Object.assign(new Error('没有在跑的任务'), { status: 400 });
  state.stopping = true;
  try { process.kill(-state.child.pid, 'SIGTERM'); } catch { try { state.child.kill('SIGTERM'); } catch {} }
  broadcast({ type: 'stopping', runId });
  return { runId, stopping: true };
}

// ---------------------------------------------------------------- 静态 / 媒体
function serveFile(req, res, abs, { download = false } = {}) {
  let stat;
  try { stat = fs.statSync(abs); } catch { return bad(res, 404, '文件不存在'); }
  if (!stat.isFile()) return bad(res, 404, '不是文件');
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (download) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(path.basename(abs))}"`;

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
      if (start > end) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  fs.createReadStream(abs).pipe(res);
}

function servePublic(res, name) {
  const abs = path.join(PUBLIC, name);
  if (!abs.startsWith(PUBLIC + path.sep)) return bad(res, 404, 'not found');
  if (!exists(abs)) return bad(res, 404, 'not found');
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(abs).pipe(res);
}

// ---------------------------------------------------------------- 路由
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return servePublic(res, 'index.html');
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) return servePublic(res, p.slice(1));

    if (req.method === 'GET' && p === '/api/bootstrap') {
      return json(res, 200, {
        root: ROOT,
        pipelines: loadPipelines(),
        themeSources: themeSources(),
        runs: listRuns(),
        active: activeRunId ? { runId: activeRunId, pipeline: live.get(activeRunId)?.pipeline, startedAt: live.get(activeRunId)?.startedAt } : null,
        publishEnabledHint: '默认只预检；勾选真实投稿才会设置 OPC_PUBLISH_ENABLED=1',
      });
    }

    if (req.method === 'GET' && p === '/api/themes') {
      const rel = url.searchParams.get('path');
      const abs = rel ? safePath(rel) : null;
      if (!abs || !exists(abs)) return bad(res, 400, '选题文件不存在');
      const doc = readJson(abs);
      if (!doc || !Array.isArray(doc.themes)) return bad(res, 400, '不是合法的选题文件（缺 themes[]）');
      return json(res, 200, {
        path: rel,
        generatedAt: doc.generatedAt || null,
        themes: doc.themes.map((t) => ({
          id: t.id, title: t.title, angle: t.angle || null,
          confidence: t.confidence ?? null, durationSec: t.brief?.durationSec ?? null,
        })),
      });
    }


    // ------------------------------------------------------------ 业务视图
    if (req.method === 'GET' && p === '/api/data') {
      return json(res, 200, { dashboard: dashboardView(), sources: sourcesView(), schedule: scheduleView() });
    }
    if (req.method === 'GET' && p === '/api/topics') return json(res, 200, topicsView());
    if (req.method === 'GET' && p === '/api/productions') return json(res, 200, { productions: scanProductions() });

    if (req.method === 'GET' && p === '/api/create/draft') {
      const runId = cleanId(url.searchParams.get('id'));
      const step = readStepOutput(runId, 'script');
      if (!step?.output) return bad(res, 404, '没有这个稿子');
      const out = step.output;
      const themes = readJson(safePath(out.sourceRef?.themesFile || '') || '');
      const theme = themes?.themes?.find((x) => x.id === out.sourceRef?.themeId) || null;
      return json(res, 200, {
        runId,
        theme: theme ? { id: theme.id, title: theme.title, source: theme.source, confidence: theme.confidence, brief: theme.brief } : null,
        title: out.metadataDraft?.title || '',
        description: out.metadataDraft?.description || '',
        tags: out.metadataDraft?.tags || [],
        scenes: out.storyboard?.scenes || [],
        scriptPath: out.script?.path || null,
        scriptMarkdown: out.script?.path ? readText(safePath(out.script.path) || '') : null,
        totalSec: (out.storyboard?.scenes || []).reduce((a, x) => a + (x.durationSec || 0), 0),
      });
    }

    if (req.method === 'POST' && p === '/api/create/script') {
      const body = await readBody(req);
      const themesRel = String(body.themesPath || 'data/themes/latest.json');
      const themesAbs = safePath(themesRel);
      if (!themesAbs || !exists(themesAbs)) return bad(res, 400, `选题文件不存在：${themesRel}`);
      const runId = cleanId(body.runId) || `create-${stamp()}`;
      const env = {};
      if (body.themeId) env.OPC_THEME_ID = String(body.themeId);
      const args = ['bin/opc', 'run-step', '--skill', 'generate-script', '--id', 'script', '--input', themesRel,
        '--run-id', runId, '--launcher', 'spawn', '--verbose', '--timeout', '900'];
      const { code } = await runChild({ runId, pipeline: 'create-script', args, env });
      const step = readStepOutput(runId, 'script');
      if (code !== 0 || !step?.output) {
        return json(res, 200, { runId, ok: false, error: step?.error || { code: 'SCRIPT_FAILED', message: '写稿失败' }, log: step?.dir || null });
      }
      const out = step.output;
      const themes = readJson(themesAbs);
      const theme = themes?.themes?.find((x) => x.id === out.sourceRef?.themeId) || null;
      return json(res, 200, {
        runId, ok: true,
        draft: {
          title: out.metadataDraft?.title || '',
          description: out.metadataDraft?.description || '',
          tags: out.metadataDraft?.tags || [],
          scenes: out.storyboard?.scenes || [],
          scriptPath: out.script?.path || null,
          scriptMarkdown: out.script?.path ? readText(safePath(out.script.path) || '') : null,
          totalSec: (out.storyboard?.scenes || []).reduce((a, x) => a + (x.durationSec || 0), 0),
          theme: theme ? { id: theme.id, title: theme.title, source: theme.source, confidence: theme.confidence } : null,
        },
      });
    }

    if (req.method === 'POST' && p === '/api/create/render') {
      const body = await readBody(req);
      const runId = cleanId(body.runId);
      const step = readStepOutput(runId, 'script');
      if (!step?.output) return bad(res, 404, '稿子不存在，先写稿');
      let inputRel = path.join(step.dir, 'output.json');
      if (body.patch) {
        const patched = patchScriptDraft(step.output, body.patch);
        if (body.scriptMarkdown) {
          const mdRel = path.join('workspace', runId, 'edit', 'script.md');
          const mdAbs = path.join(ROOT, mdRel);
          fs.mkdirSync(path.dirname(mdAbs), { recursive: true });
          fs.writeFileSync(mdAbs, String(body.scriptMarkdown));
          patched.script = { ...(patched.script || {}), path: mdRel };
        }
        const editRel = path.join('workspace', runId, 'edit', 'script-output.json');
        const editAbs = path.join(ROOT, editRel);
        fs.mkdirSync(path.dirname(editAbs), { recursive: true });
        fs.writeFileSync(editAbs, JSON.stringify(patched, null, 2) + '\n');
        inputRel = editRel;
      }
      const args = ['bin/opc', 'run-step', '--skill', 'render-remotion', '--id', 'render', '--contract', 'production',
        '--input', inputRel, '--run-id', runId, '--launcher', 'spawn', '--verbose', '--timeout', '1500'];
      const { code } = await runChild({ runId, pipeline: 'create-render', args });
      const render = readStepOutput(runId, 'render');
      if (code !== 0 || !render?.output) {
        return json(res, 200, { runId, ok: false, error: render?.error || { code: 'RENDER_FAILED', message: '渲染失败' } });
      }
      const prod = scanProductions().find((x) => x.productionId === render.output.productionId) || render.output;
      return json(res, 200, { runId, ok: true, production: prod });
    }

    if (req.method === 'POST' && p === '/api/publish') {
      const body = await readBody(req);
      const runId = cleanId(body.runId);
      const render = readStepOutput(runId, 'render');
      if (!render?.output) return bad(res, 404, '这条 run 还没有成片');
      let inputRel = path.join(render.dir, 'output.json');
      if (body.metadata) {
        const prod = JSON.parse(JSON.stringify(render.output));
        const meta = body.metadata;
        if (meta.title != null) prod.metadataDraft.title = String(meta.title).trim().slice(0, 80);
        if (meta.description != null) prod.metadataDraft.description = String(meta.description).slice(0, 2000);
        if (meta.tags != null) prod.metadataDraft.tags = cleanTags(meta.tags);
        const inRel = path.join('workspace', runId, 'publish-input.json');
        fs.writeFileSync(path.join(ROOT, inRel), JSON.stringify(prod, null, 2) + '\n');
        inputRel = inRel;
      }
      // 显式覆盖：继承来的环境变量也不能让「只跑预检」变成真投稿
      const env = { OPC_PUBLISH_ENABLED: body.publish === true ? '1' : '' };
      const args = ['bin/opc', 'run-step', '--skill', 'publish-bilibili', '--id', 'publish', '--contract', 'publish-record',
        '--input', inputRel, '--run-id', runId, '--launcher', 'spawn', '--verbose', '--timeout', '900', '--max-attempts', '1'];
      const { code } = await runChild({ runId, pipeline: 'publish', args, env });
      const pub = readStepOutput(runId, 'publish');
      return json(res, 200, { runId, ok: code === 0, record: pub?.output || null, error: pub?.error || null });
    }

    if (req.method === 'GET' && p === '/api/runs') return json(res, 200, { runs: listRuns() });

    if (req.method === 'GET' && p === '/api/run') {
      const view = buildRunView(cleanId(url.searchParams.get('id')));
      if (!view) return bad(res, 404, '没有这个 run');
      return json(res, 200, view);
    }

    if (req.method === 'GET' && p === '/api/log') {
      const id = cleanId(url.searchParams.get('id'));
      const text = readText(path.join(ROOT, 'workspace', id, 'console.log'));
      if (text == null) return bad(res, 404, '没有日志');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }

    if (req.method === 'POST' && p === '/api/run') {
      const body = await readBody(req);
      const started = startRun({ pipeline: body.pipeline, options: body.options || {} });
      return json(res, 202, started);
    }

    if (req.method === 'POST' && p === '/api/stop') {
      const body = await readBody(req);
      return json(res, 200, stopRun(cleanId(body.runId) || activeRunId));
    }

    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`retry: 2000\n\n`);
      SUBS.add(res);
      const state = activeRunId ? live.get(activeRunId) : null;
      res.write(`data: ${JSON.stringify({ type: 'hello', active: state ? { runId: state.runId, pipeline: state.pipeline, startedAt: state.startedAt } : null })}\n\n`);
      if (state) for (const l of state.lines) res.write(`data: ${JSON.stringify({ type: 'log', runId: state.runId, ...l })}\n\n`);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(hb); SUBS.delete(res); });
      return;
    }

    if (req.method === 'GET' && p === '/api/tutorial') {
      const md = readText(path.join(ROOT, 'docs/使用教程.md')) || '# 教程缺失\n\n请查看 docs/使用教程.md';
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(md);
    }

    if (req.method === 'GET' && p === '/media') {
      const rel = url.searchParams.get('p') || '';
      if (!mediaAllowed(rel)) return bad(res, 403, '不允许访问该路径');
      const abs = safePath(rel);
      if (!abs) return bad(res, 403, '非法路径');
      return serveFile(req, res, abs, { download: url.searchParams.get('dl') === '1' });
    }

    return bad(res, 404, 'not found');
  } catch (e) {
    return bad(res, e.status || 500, e.message || '服务器错误');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(`端口 ${PORT} 已被占用。换个端口：OPC_WEB_PORT=4181 node webui/server.mjs\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  process.stdout.write(`OPC 控制台已启动：${url}\n仓库根：${ROOT}\n`);
  if (process.platform === 'darwin' && process.env.OPC_WEB_NO_OPEN !== '1') {
    try { spawn('open', [url], { stdio: 'ignore', detached: true }).unref(); } catch {}
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (activeRunId) { try { stopRun(activeRunId); } catch {} }
    process.exit(0);
  });
}
