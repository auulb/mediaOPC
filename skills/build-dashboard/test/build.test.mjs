import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from '../lib/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const F = (p) => path.join(ROOT, 'fixtures', p);

const baseParams = {
  root: ROOT,
  rawItems: ['fixtures/fetch-bilibili-hot/output.json', 'fixtures/fetch-internal-metrics/output.json'],
  ledger: 'fixtures/token-ledger/token_ledger.jsonl',
  taskStatus: 'fixtures/build-dashboard/task_status.jsonl',
  dailyTokenBudget: 500000,
  now: '2024-01-16T10:00:00Z',
};

function assertRefsResolve(dash, refs, at) {
  assert.ok(Array.isArray(refs) && refs.length > 0, `${at} 缺少 sourceRef`);
  const ids = new Set(dash.sources.map((s) => s.id));
  for (const r of refs) {
    assert.ok(ids.has(r.source), `${at} 引用了不存在的 source ${r.source}`);
    assert.equal(typeof r.pointer, 'string', `${at} pointer 缺失`);
  }
}

test('看板：所有指标都有可解析的 sourceRef', () => {
  const { dashboard } = buildDashboard(baseParams);

  for (const [i, t] of dashboard.externalTrends.topTopics.entries()) assertRefsResolve(dashboard, t.sourceRef, `topTopics[${i}]`);
  for (const [p, m] of Object.entries(dashboard.externalTrends.flowDirection)) assertRefsResolve(dashboard, m.sourceRef, `flowDirection.${p}`);
  for (const [i, it] of dashboard.externalTrends.topItems.entries()) assertRefsResolve(dashboard, it.sourceRef, `topItems[${i}]`);
  for (const [i, e] of dashboard.internalPerformance.episodes.entries()) assertRefsResolve(dashboard, e.sourceRef, `episodes[${i}]`);
  assertRefsResolve(dashboard, dashboard.internalPerformance.avgEngagement.sourceRef, 'avgEngagement');
  assertRefsResolve(dashboard, dashboard.tokenUsage.sourceRef, 'tokenUsage');
  assertRefsResolve(dashboard, dashboard.taskStatus.sourceRef, 'taskStatus');
});

test('看板：话题热度、流量占比、榜单排序', () => {
  const { dashboard } = buildDashboard(baseParams);
  const topics = dashboard.externalTrends.topTopics;
  assert.equal(topics[0].heat, 100);
  assert.equal(topics[0].topic, '动画');
  assert.ok(topics.every((t, i) => i === 0 || topics[i - 1].heat >= t.heat));
  assert.equal(dashboard.externalTrends.flowDirection.bilibili.value, 100);
  assert.equal(dashboard.externalTrends.topItems[0].id, 'BV1xx411c7mD');
  assert.equal(dashboard.externalTrends.topItems[0].engagement, 0.1027);
  assert.ok(topics.every((t) => t.growth === 'n/a')); // 无上一版看板
});

test('看板：有上一版时计算 growth', () => {
  const prev = JSON.parse(fs.readFileSync(F('build-dashboard/output.json'), 'utf8'));
  const prevFile = path.join(ROOT, 'data', 'test-previous-dashboard.json');
  fs.mkdirSync(path.dirname(prevFile), { recursive: true });
  fs.writeFileSync(prevFile, JSON.stringify(prev));
  try {
    const { dashboard } = buildDashboard({ ...baseParams, previousDashboard: 'data/test-previous-dashboard.json' });
    const animation = dashboard.externalTrends.topTopics.find((t) => t.topic === '动画');
    assert.equal(animation.growth, '+0%'); // 两版输入相同 → 热度不变
    assert.match(animation.growth, /^[+-]?\d+(\.\d+)?%$/);
  } finally {
    fs.rmSync(prevFile, { force: true });
  }
});

test('看板：token 今日/本周/预算与按步骤聚合', () => {
  const { dashboard } = buildDashboard(baseParams);
  const t = dashboard.tokenUsage;
  assert.equal(t.today, 19600);
  assert.equal(t.thisWeek, 20600);
  assert.equal(t.budget, 500000);
  assert.equal(t.utilizationRate, 0.0392);
  assert.deepEqual(t.byStep.map((s) => s.stepId), ['recommend', 'build-dashboard', 'fetch-bilibili']);
  assert.equal(t.byStep[0].tokens, 15000);
});

test('看板：任务状态面板来自 task_status.jsonl', () => {
  const { dashboard } = buildDashboard(baseParams);
  assert.deepEqual(dashboard.taskStatus.summary, { success: 4, failed: 0, running: 1, pending: 0 });
  assert.equal(dashboard.taskStatus.recent.length, 5);
  assert.equal(dashboard.taskStatus.recent[0].status, 'running');
});

test('看板：task_status 缺失时用 ledger 推导', () => {
  const { dashboard } = buildDashboard({ ...baseParams, taskStatus: 'data/does-not-exist.json' });
  assert.deepEqual(dashboard.taskStatus.summary, { success: 3, failed: 1, running: 0, pending: 0 });
  assert.equal(dashboard.taskStatus.recent.length, 4);
});

test('看板：内部表现按播放排序并给出 topPerformers', () => {
  const { dashboard } = buildDashboard(baseParams);
  const perf = dashboard.internalPerformance;
  assert.equal(perf.episodes.length, 2);
  assert.equal(perf.episodes[0].id, 'pub_20240115_bili_001');
  assert.equal(perf.episodes[0].window, '24h');
  assert.deepEqual(perf.topPerformers, ['pub_20240115_bili_001', 'pub_20240112_bili_002']);
  assert.equal(perf.avgEngagement.value, 0.1056); // (0.1123+0.0988)/2
  assert.equal(perf.episodes[0].roi, null); // 暂无法把 token 归因到单条视频
});

test('看板：rawItems 为空或缺失时报 INPUT_INVALID', () => {
  assert.throws(() => buildDashboard({ ...baseParams, rawItems: [] }), (e) => e.code === 'INPUT_INVALID');
  assert.throws(() => buildDashboard({ ...baseParams, rawItems: ['fixtures/nope.json'] }), (e) => e.code === 'INPUT_INVALID');
});

test('拆分文件：三份面板都带 generatedAt 与 sources', () => {
  const { split } = buildDashboard(baseParams);
  assert.deepEqual(Object.keys(split).sort(), ['external_trends.json', 'internal_performance.json', 'token_usage.json']);
  for (const v of Object.values(split)) {
    assert.ok(v.generatedAt);
    assert.ok(Array.isArray(v.sources) && v.sources.length > 0);
  }
});

test('看板：rawItems 缺省时从 workspace 上游 attempt 目录发现', () => {
  const root = fs.mkdtempSync(path.join(ROOT, 'data', 'test-workspace-'));
  try {
    const raw = fs.readFileSync(F('fetch-bilibili-hot/output.json'), 'utf8');
    for (const [step, attempt] of [['fetch-old', 'attempt-1'], ['fetch-hot', 'attempt-1'], ['fetch-hot', 'attempt-2']]) {
      const dir = path.join(root, 'workspace', 'run-1', step, attempt);
      fs.mkdirSync(dir, { recursive: true });
      // 只有 fetch-hot 的 attempt-2 是最终产物；attempt-1 放一份旧数据用于验证“取最大 attempt”
      const data = attempt === 'attempt-2' ? JSON.parse(raw) : { ...JSON.parse(raw), timestamp: '2020-01-01T00:00:00Z' };
      fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(data));
    }
    const { dashboard } = buildDashboard({ root, upstream: ['fetch-old', 'fetch-hot'], runId: 'run-1', now: '2024-01-16T10:00:00Z' });
    assert.equal(dashboard.sources.filter((s) => s.kind === 'raw-items').length, 2);
    assert.ok(dashboard.sources.some((s) => s.file.endsWith('fetch-hot/attempt-2/output.json')));
    assert.ok(!dashboard.sources.some((s) => s.file.endsWith('fetch-hot/attempt-1/output.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('看板：冷启动没有自有内容时 avgEngagement 仍有 sourceRef', () => {
  const { dashboard } = buildDashboard({ ...baseParams, rawItems: ['fixtures/fetch-bilibili-hot/output.json'], now: '2024-01-16T10:00:00Z' });
  assert.equal(dashboard.internalPerformance.episodes.length, 0);
  assert.equal(dashboard.internalPerformance.avgEngagement.value, 0);
  assert.ok(dashboard.internalPerformance.avgEngagement.sourceRef.length > 0);
  const ids = new Set(dashboard.sources.map((s) => s.id));
  assert.ok(dashboard.internalPerformance.avgEngagement.sourceRef.every((r) => ids.has(r.source)));
});
