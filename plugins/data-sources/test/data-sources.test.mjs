import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BilibiliHotPlugin } from '../bilibili-hot.mjs';
import { InternalMetricsPlugin, windowOf } from '../internal-metrics.mjs';
import { runFetchStep } from '../lib/step.mjs';
import { validate } from '../lib/validate.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const CONTRACT = path.join(ROOT, 'contracts/raw-items.schema.json');

const realFetch = globalThis.fetch;
let tmp;
let fetchCalls;
let fetchImpl;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-ds-'));
  fetchCalls = [];
  fetchImpl = null;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchImpl) return fetchImpl(String(url), init);
    return jsonResponse({ code: 0, data: { list: [], no_more: true } });
  };
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.exitCode = 0;
  await fs.rm(tmp, { recursive: true, force: true });
});

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const popularItem = (over = {}) => ({
  bvid: 'BV1xx411c7mD',
  title: 'AI 动画是怎么做出来的',
  pubdate: Math.floor(Date.now() / 1000) - 2 * 3600,
  duration: 183,
  tname: '科技',
  stat: { view: 100000, like: 8000, reply: 500, share: 300, favorite: 2000 },
  owner: { mid: 12345, name: '测试UP' },
  rcmd_reason: { content: '热门推荐' },
  ...over,
});

async function assertContract(data) {
  const schema = JSON.parse(await fs.readFile(CONTRACT, 'utf8'));
  assert.deepEqual(validate(schema, data, CONTRACT), []);
}

test('bilibili：转换结果符合 raw-items 契约', async () => {
  fetchImpl = async () => jsonResponse({ code: 0, data: { list: [popularItem()], no_more: true } });
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ limit: 10 });

  await assertContract(out);
  assert.equal(out.dataSource, 'bilibili-hot');
  assert.equal(out.platform, 'bilibili');
  assert.equal(out.cache.hit, false);
  assert.equal(out.items.length, 1);
  const item = out.items[0];
  assert.equal(item.id, 'BV1xx411c7mD');
  assert.equal(item.views, 100000);
  assert.equal(item.metrics.engagement, 0.108); // (8000+500+300+2000)/100000
  assert.ok(item.metrics.viewsPerHour > 0);
  assert.equal(item.channel.subscribers, null);
  assert.match(item.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('bilibili：1 小时内重复调用命中缓存，不再请求', async () => {
  fetchImpl = async () => jsonResponse({ code: 0, data: { list: [popularItem()], no_more: true } });
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });

  const first = await plugin.run({ limit: 10 });
  const second = await plugin.run({ limit: 10 });

  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(second.timestamp, first.timestamp);
  assert.ok(Date.parse(second.cache.expiresAt) > Date.now());
});

test('bilibili：noCache 强制重新抓取', async () => {
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  await plugin.run({ limit: 10 });
  await plugin.run({ limit: 10, noCache: true });
  assert.equal(fetchCalls.length, 2);
});

test('bilibili：不同参数使用不同缓存 key', async () => {
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  await plugin.run({ limit: 10 });
  await plugin.run({ limit: 20 });
  assert.notEqual(fetchCalls.length, 1);
});

test('限速：两次真实请求间隔不小于 minIntervalMs', async () => {
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 120 });
  const t0 = Date.now();
  await plugin.run({ limit: 10 });
  await plugin.run({ limit: 11 }); // 不同 key，必然发起第二次真实请求
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 100, `间隔过短: ${elapsed}ms`);
  assert.equal(fetchCalls.length, 2);
});

test('bilibili：412 映射为可重试的 API_RATE_LIMIT', async () => {
  fetchImpl = async () => jsonResponse({}, 412);
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  await assert.rejects(plugin.run({}), (e) => e.code === 'API_RATE_LIMIT');
});

test('bilibili：业务码 -352 映射为 API_RATE_LIMIT', async () => {
  fetchImpl = async () => jsonResponse({ code: -352, message: '风控校验失败' });
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  await assert.rejects(plugin.run({}), (e) => e.code === 'API_RATE_LIMIT');
});

test('bilibili：网络异常映射为 NETWORK_ERROR', async () => {
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(plugin.run({}), (e) => e.code === 'NETWORK_ERROR');
});

test('bilibili：跳过无 bvid 条目并写 warning', async () => {
  fetchImpl = async () => jsonResponse({ code: 0, data: { list: [popularItem(), { ...popularItem(), bvid: '' }], no_more: true } });
  const plugin = new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({});
  assert.equal(out.items.length, 1);
  assert.equal(out.warnings.length, 1);
});

test('step：成功时写平铺 output.json + artifacts.json，不写 envelope', async () => {
  fetchImpl = async () => jsonResponse({ code: 0, data: { list: [popularItem()], no_more: true } });
  const dir = path.join(tmp, 'attempt-1');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'input.json'), JSON.stringify({ params: { limit: 5 } }));

  await runFetchStep({
    plugin: new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 }),
    inputFile: path.join(dir, 'input.json'),
    outputFile: path.join(dir, 'output.json'),
  });

  const out = JSON.parse(await fs.readFile(path.join(dir, 'output.json'), 'utf8'));
  await assertContract(out);
  const artifacts = JSON.parse(await fs.readFile(path.join(dir, 'artifacts.json'), 'utf8'));
  assert.equal(artifacts[0].contract, 'raw-items');
  await assert.rejects(fs.access(path.join(dir, 'error.json')));
  await assert.rejects(fs.access(path.join(dir, 'envelope.json')));
});

test('step：失败时写 error.json、不写 output.json，退出码非 0', async () => {
  fetchImpl = async () => jsonResponse({}, 429);
  const dir = path.join(tmp, 'attempt-2');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'input.json'), '{}');

  await runFetchStep({
    plugin: new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 }),
    inputFile: path.join(dir, 'input.json'),
    outputFile: path.join(dir, 'output.json'),
  });

  const err = JSON.parse(await fs.readFile(path.join(dir, 'error.json'), 'utf8'));
  assert.equal(err.code, 'API_RATE_LIMIT');
  assert.equal(err.retryable, true);
  assert.equal(process.exitCode, 1);
  await assert.rejects(fs.access(path.join(dir, 'output.json')));
});

test('step：损坏的 input.json 报 INPUT_INVALID 且不可重试', async () => {
  const dir = path.join(tmp, 'attempt-3');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'input.json'), '{oops');

  await runFetchStep({
    plugin: new BilibiliHotPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 }),
    inputFile: path.join(dir, 'input.json'),
    outputFile: path.join(dir, 'output.json'),
  });

  const err = JSON.parse(await fs.readFile(path.join(dir, 'error.json'), 'utf8'));
  assert.equal(err.code, 'INPUT_INVALID');
  assert.equal(err.retryable, false);
  assert.equal(fetchCalls.length, 0);
});

test('windowOf：发布后时长落区间', () => {
  assert.equal(windowOf(1), '0h');
  assert.equal(windowOf(24), '24h');
  assert.equal(windowOf(71.9), '24h');
  assert.equal(windowOf(72), '72h');
  assert.equal(windowOf(167), '72h');
  assert.equal(windowOf(168), '7d');
  assert.equal(windowOf(400), 'latest');
});

const record = (over = {}) => ({
  schemaVersion: 1,
  publishId: 'pub_test_001',
  themeId: 'theme_001',
  productionId: 'prod_test_001',
  platform: 'bilibili',
  status: 'published',
  publishedAt: new Date(Date.now() - 30 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  platformVideoId: 'BV1xx411c7mD',
  metadata: { title: '测试标题', description: '', tags: ['AI'], thumbnail: 'a.jpg' },
  precheck: { passed: true, checks: [] },
  error: null,
  ...over,
});

const viewBody = {
  code: 0,
  data: { title: '测试标题', duration: 30, stat: { view: 5000, like: 400, reply: 30, share: 20, favorite: 100 }, owner: { mid: 1, name: 'self' } },
};

test('internal：只处理 published 且有 platformVideoId 的记录', async () => {
  fetchImpl = async () => jsonResponse(viewBody);
  const plugin = new InternalMetricsPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({
    records: [
      record(),
      record({ publishId: 'pub_failed', status: 'precheck_failed', platformVideoId: null }),
      record({ publishId: 'pub_yt', platform: 'youtube' }),
    ],
    noCache: true,
    snapshot: false,
  });

  await assertContract(out);
  assert.equal(out.items.length, 1);
  const item = out.items[0];
  assert.equal(item.id, 'BV1xx411c7mD');
  assert.equal(item.internal.publishId, 'pub_test_001');
  assert.equal(item.internal.window, '24h');
  assert.equal(item.metrics.engagement, 0.11); // (400+30+20+100)/5000
  assert.equal(out.warnings.length, 2);
  assert.equal(fetchCalls.length, 1);
});

test('internal：单条拉取失败跳过并记录 warning，不整体失败', async () => {
  fetchImpl = async () => jsonResponse({ code: -404, message: '啥都木有' });
  const plugin = new InternalMetricsPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ records: [record()], noCache: true, snapshot: false });
  assert.equal(out.items.length, 0);
  assert.equal(out.warnings.length, 1);
});

test('internal：平台限流则整体失败，交给调度器退避', async () => {
  fetchImpl = async () => jsonResponse({}, 412);
  const plugin = new InternalMetricsPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  await assert.rejects(plugin.run({ records: [record()], noCache: true, snapshot: false }), (e) => e.code === 'API_RATE_LIMIT');
});

test('internal：从 JSONL 读取发布记录', async () => {
  fetchImpl = async () => jsonResponse(viewBody);
  const jsonl = path.join(tmp, 'records.jsonl');
  await fs.writeFile(jsonl, `${JSON.stringify(record())}\n${JSON.stringify(record({ publishId: 'pub_test_002' }))}\n`);
  const plugin = new InternalMetricsPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ recordsJsonl: jsonl, noCache: true, snapshot: false });
  assert.equal(out.items.length, 2);
});

test('internal：真实抓取追加窗口快照，便于回看 24h/72h', async () => {
  fetchImpl = async () => jsonResponse(viewBody);
  const snap = path.join(tmp, 'snapshots.jsonl');
  const plugin = new InternalMetricsPlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  await plugin.run({ records: [record()], noCache: true, snapshotsJsonl: snap });

  const lines = (await fs.readFile(snap, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].publishId, 'pub_test_001');
  assert.equal(lines[0].window, '24h');
  assert.equal(lines[0].views, 5000);
  assert.equal(lines[0].hoursSincePublish, 30);
});
