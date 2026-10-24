// 看板构建：raw-items + token ledger + task status → dashboard v1（contracts/dashboard.schema.json）
// 纯函数，不做网络请求，便于离线测试。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DAILY_TOKEN_BUDGET = 500000;

/** 相对 OPC_ROOT 解析路径（绝对路径原样返回） */
export function resolveIn(root, p) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`读取失败 ${file}: ${e.message}`);
  }
}

function readJsonlIfExists(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`读取失败 ${file}: ${e.message}`);
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`${file} 第 ${i + 1} 行不是合法 JSON: ${e.message}`);
      }
    });
}

function readTaskStatus(file) {
  // .jsonl 每行一个任务；普通 .json 支持数组或 { tasks: [] }
  if (file.endsWith('.jsonl')) {
    const lines = readJsonlIfExists(file);
    return lines ? { tasks: lines } : null;
  }
  return readJsonIfExists(file);
}

/**
 * 从调度器工作区发现上游产物：workspace/{runId}/{stepId}/attempt-{n}/output.json（n 最大者）
 * 约定来源：A-core 的隔离执行器；params.runId 缺省读 env OPC_RUN_ID。
 */
export function discoverUpstream(root, params) {
  const runId = params.runId || process.env.OPC_RUN_ID;
  const steps = Array.isArray(params.upstream) ? params.upstream : [];
  if (!runId || steps.length === 0) return [];
  return steps.map((stepId) => {
    const dir = path.join(root, 'workspace', runId, stepId);
    if (!fs.existsSync(dir)) {
      const err = new Error(`找不到上游步骤目录 workspace/${runId}/${stepId}`);
      err.code = 'INPUT_INVALID';
      throw err;
    }
    const attempt = fs
      .readdirSync(dir)
      .filter((f) => /^attempt-\d+$/.test(f))
      .sort((a, b) => Number(a.slice('attempt-'.length)) - Number(b.slice('attempt-'.length)))
      .at(-1);
    const file = attempt ? path.join(dir, attempt, 'output.json') : null;
    if (!file || !fs.existsSync(file)) {
      const err = new Error(`上游步骤 ${stepId} 没有成功的 output.json`);
      err.code = 'INPUT_INVALID';
      throw err;
    }
    return path.relative(root, file);
  });
}

const sourceId = (i, dataSource) => `raw-${i}-${String(dataSource || 'items').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;

const round = (n, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 本周一 00:00（本地时区） */
function startOfWeek(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - day);
  return d;
}

/**
 * @param {object} params
 * @param {string[]} params.rawItems  raw-items 文件路径（相对 OPC_ROOT 或绝对）
 * @param {string} [params.root]      OPC_ROOT
 * @param {string} [params.ledger]    token_ledger.jsonl 路径
 * @param {string} [params.taskStatus] task_status.json 路径
 * @param {string} [params.previousDashboard] 上一版看板，用于算 growth
 * @param {number} [params.dailyTokenBudget]
 * @param {number} [params.topTopicCount=10]
 * @param {number} [params.topItemCount=20]
 * @param {Date} [params.now]
 */
export function buildDashboard(params) {
  const root = params.root || process.cwd();
  const now = params.now ? new Date(params.now) : new Date();
  const ledgerPath = resolveIn(root, params.ledger || 'data/token_ledger.jsonl');
  const taskStatusPath = resolveIn(root, params.taskStatus || 'dashboard/task_status.json');
  const budget = Number(params.dailyTokenBudget ?? DEFAULT_DAILY_TOKEN_BUDGET);

  // rawItems 显式给出时直接用；否则按 upstream 步骤名去 workspace/{runId}/{step}/attempt-* 找最新产物
  const rawItems = Array.isArray(params.rawItems) && params.rawItems.length
    ? params.rawItems
    : discoverUpstream(root, params);
  if (rawItems.length === 0) {
    const err = new Error('params.rawItems 为空，且无法从 upstream/OPC_RUN_ID 找到上游产物');
    err.code = 'INPUT_INVALID';
    throw err;
  }

  const sources = [];
  const rawList = [];
  rawItems.forEach((file, i) => {
    const abs = resolveIn(root, file);
    const data = readJsonIfExists(abs);
    if (!data) {
      const err = new Error(`raw-items 文件不存在: ${file}`);
      err.code = 'INPUT_INVALID';
      throw err;
    }
    if (data.schemaVersion !== 1 || !Array.isArray(data.items)) {
      const err = new Error(`${file} 不是 raw-items v1`);
      err.code = 'INPUT_INVALID';
      throw err;
    }
    const id = sourceId(i, data.dataSource);
    sources.push({
      id,
      file: path.isAbsolute(file) ? path.relative(root, file) : file,
      kind: 'raw-items',
      ...(data.dataSource ? { dataSource: data.dataSource } : {}),
      ...(data.timestamp ? { timestamp: data.timestamp } : {}),
    });
    rawList.push({ id, file, data });
  });

  const ledgerEntries = readJsonlIfExists(ledgerPath);
  const ledgerSourceId = 'token-ledger';
  sources.push({ id: ledgerSourceId, file: path.relative(root, ledgerPath), kind: 'token-ledger' });

  const taskStatusRaw = readTaskStatus(taskStatusPath);
  const taskSourceId = 'task-status';
  sources.push({ id: taskSourceId, file: path.relative(root, taskStatusPath), kind: 'task-status' });

  const dashboard = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sources,
    externalTrends: buildExternalTrends(rawList, params, root),
    internalPerformance: buildInternalPerformance(rawList, ledgerSourceId),
    tokenUsage: buildTokenUsage(ledgerEntries || [], ledgerSourceId, budget, now),
    taskStatus: buildTaskStatus(taskStatusRaw, ledgerEntries, taskSourceId, ledgerSourceId),
  };

  return { dashboard, split: splitDashboard(dashboard) };
}

function buildExternalTrends(rawList, params, root) {
  const external = rawList.filter((s) => s.data.dataSource !== 'internal-metrics');
  const topics = new Map();
  const items = [];

  for (const src of external) {
    src.data.items.forEach((item, idx) => {
      const tags = (item.tags || []).filter(Boolean);
      const candidates = tags.length ? tags : [item.category || '未分类'];
      for (const topic of [...new Set(candidates)]) {
        const t = topics.get(topic) || { topic, itemCount: 0, views: 0, platforms: new Set(), refs: [] };
        t.itemCount += 1;
        t.views += item.views || 0;
        if (src.data.platform) t.platforms.add(src.data.platform);
        t.refs.push({ source: src.id, pointer: `/items/${idx}`, itemId: item.id });
        topics.set(topic, t);
      }
      items.push({ src, item, idx });
    });
  }

  // 与上一版看板比较热度
  const prevPath = resolveIn(root, params.previousDashboard || 'dashboard/dashboard.json');
  const prev = readJsonIfExists(prevPath);
  const prevHeat = new Map((prev?.externalTrends?.topTopics || []).map((t) => [t.topic, t.heat]));

  const maxViews = Math.max(0, ...[...topics.values()].map((t) => t.views));
  const topTopics = [...topics.values()]
    .map((t) => {
      const heat = maxViews > 0 ? round((t.views / maxViews) * 100, 1) : 0;
      const before = prevHeat.get(t.topic);
      let growth = 'n/a';
      if (typeof before === 'number' && before > 0) {
        const g = ((heat - before) / before) * 100;
        growth = `${g >= 0 ? '+' : ''}${round(g, 1)}%`;
      }
      return {
        topic: t.topic,
        heat,
        growth,
        itemCount: t.itemCount,
        platforms: [...t.platforms].sort(),
        sourceRef: t.refs.slice(0, 5),
      };
    })
    .sort((a, b) => b.heat - a.heat || b.itemCount - a.itemCount)
    .slice(0, Number(params.topTopicCount ?? 10));

  // 各平台流量占比（按播放量）
  const byPlatform = new Map();
  let totalViews = 0;
  for (const { src, item, idx } of items) {
    const p = src.data.platform || 'unknown';
    const ref = { source: src.id, pointer: `/items/${idx}`, itemId: item.id };
    const cur = byPlatform.get(p) || { views: 0, refs: [] };
    cur.views += item.views || 0;
    cur.refs.push(ref);
    byPlatform.set(p, cur);
    totalViews += item.views || 0;
  }
  const flowDirection = {};
  for (const [platform, v] of byPlatform) {
    flowDirection[platform] = {
      value: totalViews > 0 ? round((v.views / totalViews) * 100, 1) : 0,
      sourceRef: v.refs.slice(0, 20),
    };
  }

  const topItems = items
    .sort((a, b) => (b.item.views || 0) - (a.item.views || 0))
    .slice(0, Number(params.topItemCount ?? 20))
    .map(({ src, item, idx }) => ({
      id: item.id,
      title: item.title,
      platform: src.data.platform || 'unknown',
      views: item.views || 0,
      engagement: item.metrics?.engagement ?? 0,
      velocity: item.metrics?.velocity || 'unknown',
      tags: item.tags || [],
      sourceRef: [{ source: src.id, pointer: `/items/${idx}`, itemId: item.id }],
    }));

  return { topTopics, flowDirection, topItems };
}

function buildInternalPerformance(rawList, fallbackSourceId) {
  const episodes = [];
  const refs = [];
  let internalSourceId = null;
  for (const src of rawList.filter((s) => s.data.dataSource === 'internal-metrics')) {
    internalSourceId = src.id;
    src.data.items.forEach((item, idx) => {
      const ref = { source: src.id, pointer: `/items/${idx}`, itemId: item.id };
      refs.push(ref);
      episodes.push({
        id: item.internal?.publishId || item.id,
        ...(item.internal?.themeId ? { themeId: item.internal.themeId } : {}),
        title: item.title,
        platform: item.internal?.platform || src.data.platform || 'internal',
        window: item.internal?.window || 'latest',
        views: item.views || 0,
        likes: item.likes || 0,
        comments: item.comments || 0,
        engagement: item.metrics?.engagement ?? 0,
        tokensSpent: null,
        roi: null,
        sourceRef: [ref],
      });
    });
  }
  episodes.sort((a, b) => b.views - a.views);
  const avg = episodes.length ? episodes.reduce((s, e) => s + e.engagement, 0) / episodes.length : 0;
  const topPerformers = episodes.slice(0, 3).map((e) => e.id);
  // 冷启动没有任何自有内容时，也要给出可追溯的 sourceRef：优先内部数据文件，其次 ledger（0 条发布）
  const avgRef = refs.length
    ? refs.slice(0, 20)
    : [{ source: internalSourceId || fallbackSourceId, pointer: internalSourceId ? '/items' : '' }];
  return {
    episodes,
    avgEngagement: { value: round(avg, 4), sourceRef: avgRef },
    topPerformers,
  };
}

function buildTokenUsage(entries, sourceId, budget, now) {
  const todayKey = localDay(now);
  const weekStart = startOfWeek(now);
  let today = 0;
  let thisWeek = 0;
  let costToday = 0;
  const steps = new Map();

  for (const e of entries) {
    const ts = new Date(e.ts);
    if (Number.isNaN(ts.getTime())) continue;
    if (localDay(ts) === todayKey) {
      today += e.totalTokens || 0;
      costToday += e.costUsd || 0;
    }
    if (ts >= weekStart) {
      thisWeek += e.totalTokens || 0;
      const cur = steps.get(e.stepId) || { stepId: e.stepId, tokens: 0, cost: 0 };
      cur.tokens += e.totalTokens || 0;
      cur.cost += e.costUsd || 0;
      steps.set(e.stepId, cur);
    }
  }

  return {
    today,
    thisWeek,
    costToday: round(costToday, 6),
    budget,
    utilizationRate: budget > 0 ? round(today / budget, 4) : 0,
    byStep: [...steps.values()]
      .map((s) => ({ stepId: s.stepId, tokens: s.tokens, cost: round(s.cost, 6) }))
      .sort((a, b) => b.tokens - a.tokens),
    sourceRef: [{ source: sourceId, pointer: '' }],
  };
}

function buildTaskStatus(taskStatusRaw, ledger, taskSourceId, ledgerSourceId) {
  if (taskStatusRaw) {
    const tasks = Array.isArray(taskStatusRaw) ? taskStatusRaw : taskStatusRaw.tasks || [];
    const summary = { success: 0, failed: 0, running: 0, pending: 0 };
    for (const t of tasks) {
      const s = String(t.status || '').toLowerCase();
      if (s in summary) summary[s] += 1;
      else if (s === 'succeeded' || s === 'completed') summary.success += 1;
      else if (s === 'error') summary.failed += 1;
    }
    return {
      summary,
      recent: tasks.slice(-10).reverse(),
      sourceRef: [{ source: taskSourceId, pointer: Array.isArray(taskStatusRaw) ? '' : '/tasks' }],
    };
  }

  // 没有 A 的 task_status.json 时，用 ledger 的 attempt 记录推导
  const summary = { success: 0, failed: 0, running: 0, pending: 0 };
  for (const e of ledger || []) {
    if (e.outcome === 'success') summary.success += 1;
    else if (e.outcome === 'failed') summary.failed += 1;
  }
  const recent = (ledger || []).slice(-10).reverse().map((e) => ({
    runId: e.runId,
    stepId: e.stepId,
    skill: e.skill,
    status: e.outcome,
    finishedAt: e.ts,
  }));
  return { summary, recent, sourceRef: [{ source: ledgerSourceId, pointer: '' }] };
}

/** 设计文档 2.2 的拆分文件：外部趋势 / 自有表现 / token 用量（task_status.json 由 A 写，这里不碰） */
export function splitDashboard(dashboard) {
  return {
    'external_trends.json': {
      generatedAt: dashboard.generatedAt,
      sources: dashboard.sources,
      externalTrends: dashboard.externalTrends,
    },
    'internal_performance.json': {
      generatedAt: dashboard.generatedAt,
      sources: dashboard.sources,
      internalPerformance: dashboard.internalPerformance,
    },
    'token_usage.json': {
      generatedAt: dashboard.generatedAt,
      sources: dashboard.sources,
      tokenUsage: dashboard.tokenUsage,
    },
  };
}

export function writeDashboardFiles(outDir, dashboard, split) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (name, value) => {
    const file = path.join(outDir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
    written.push(file);
  };
  for (const [name, value] of Object.entries(split)) write(name, value);
  return written;
}
