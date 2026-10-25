// 知识区最新视频采集（禁止 AI）+ 手动 Cookie 单元测试。全部离线（mock fetch）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BilibiliKnowledgePlugin } from '../bilibili-knowledge.mjs';
import {
  sanitizeCookie, validateCookie, writeCookie, readCookie, cookieStatus, clearCookie,
} from '../lib/cookie.mjs';
import { validate } from '../lib/validate.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const CONTRACT = path.join(ROOT, 'contracts/raw-items.schema.json');

const realFetch = globalThis.fetch;
let tmp;
let fetchCalls;
let fetchImpl;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-knowledge-'));
  process.env.OPC_COOKIE_FILE = path.join(tmp, 'bilibili-cookie.txt');
  fetchCalls = [];
  fetchImpl = null;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchImpl) return fetchImpl(String(url), init);
    return jsonResponse({ code: 0, data: { archives: [] } });
  };
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env.OPC_COOKIE_FILE;
  process.exitCode = 0;
  await fs.rm(tmp, { recursive: true, force: true });
});

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const nowSec = () => Math.floor(Date.now() / 1000);

const archive = (over = {}) => ({
  bvid: 'BV1aa411c7mD',
  title: '大模型推理到底是怎样工作的',
  pubdate: nowSec() - 600,
  duration: 420,
  tid: 201,
  tname: '科学科普',
  stat: { view: 0, like: 0, reply: 0, share: 0, favorite: 0 },
  owner: { mid: 12345, name: 'AI 测试UP' },
  desc: '讲清楚 transformer 与推理',
  ...over,
});

const viewBody = (over = {}) => ({
  code: 0,
  data: {
    stat: { view: 12000, like: 900, reply: 60, share: 30, favorite: 200 },
    duration: 420,
    tname: '科学科普',
    tnamev2: '计算机技术',
    owner: { mid: 12345, name: 'AI 测试UP' },
    ...over,
  },
});

async function assertContract(data) {
  const schema = JSON.parse(await fs.readFile(CONTRACT, 'utf8'));
  assert.deepEqual(validate(schema, data, CONTRACT), []);
}

test('知识区 latest：按发布时间倒序、limit 生效、符合 raw-items 契约', async () => {
  const base = nowSec();
  fetchImpl = async (url) => {
    if (url.includes('/newlist')) {
      return jsonResponse({
        code: 0,
        data: {
          archives: [
            archive({ bvid: 'BV1old', title: '旧视频', pubdate: base - 7200 }),
            archive({ bvid: 'BV1new', title: '新视频', pubdate: base - 60 }),
            archive({ bvid: 'BV1mid', title: '中间视频', pubdate: base - 1800 }),
          ],
        },
      });
    }
    return jsonResponse(viewBody());
  };
  const plugin = new BilibiliKnowledgePlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ tid: 36, limit: 2, enrich: false });

  await assertContract(out);
  assert.equal(out.dataSource, 'bilibili-knowledge');
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.items.map((i) => i.id), ['BV1new', 'BV1mid']);
  assert.equal(out.params.tid, 36);
  assert.ok(out.items.every((i) => i.tags.includes('知识（全部）')));
});

test('知识区 latest：enrich 用 view 接口补播放/点赞，engagement 落在 metrics', async () => {
  fetchImpl = async (url) => (url.includes('/newlist')
    ? jsonResponse({ code: 0, data: { archives: [archive()] } })
    : jsonResponse(viewBody()));
  const plugin = new BilibiliKnowledgePlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ limit: 1, enrich: true });
  await assertContract(out);
  assert.equal(out.items[0].views, 12000);
  assert.equal(out.items[0].likes, 900);
  assert.ok(out.items[0].metrics.engagement > 0);
  assert.deepEqual(out.items[0].tags.slice(0, 2), ['知识（全部）', '科学科普']);
});

test('知识区 latest：关键词为纯字符串筛选，并给 ASCII 词加边界（AI 不命中 email）', async () => {
  const base = nowSec();
  fetchImpl = async (url) => (url.includes('/newlist')
    ? jsonResponse({
      code: 0,
      data: {
        archives: [
          archive({ bvid: 'BV1ai', title: 'AI 大模型推理优化实战', pubdate: base - 100 }),
          archive({ bvid: 'BV1mail', title: '如何写好一封 email', pubdate: base - 150 }),
          archive({ bvid: 'BV1tag', title: '随便聊聊 AI 绘画', pubdate: base - 160 }),
          archive({ bvid: 'BV1moba', title: '一把菜刀打上王者', pubdate: base - 200, tname: '社科·法律·心理' }),
        ],
      },
    })
    : jsonResponse(viewBody()));
  const plugin = new BilibiliKnowledgePlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ limit: 5, keywords: ['AI'], enrich: false });
  assert.deepEqual(out.items.map((i) => i.id), ['BV1ai', 'BV1tag']);
  assert.ok((out.warnings || []).some((w) => w.includes('关键词筛选')));
  assert.equal(out.params.keywords[0], 'AI');
});

test('知识区 latest：翻页重复条目按 bvid 去重（保留最新）', async () => {
  const base = nowSec();
  const dup = archive({ bvid: 'BV1dup', title: '同一个视频', pubdate: base - 60 });
  fetchImpl = async (url) => (url.includes('/newlist')
    ? jsonResponse({ code: 0, data: { archives: [dup, dup, archive({ bvid: 'BV1uniq', title: '另一个', pubdate: base - 120 })] } })
    : jsonResponse(viewBody()));
  const plugin = new BilibiliKnowledgePlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ limit: 10, enrich: false });
  assert.deepEqual(out.items.map((i) => i.id), ['BV1dup', 'BV1uniq']);
  assert.ok((out.warnings || []).some((w) => w.includes('去重')));
});

test('Cookie：只手动写入本地文件，请求头带上但不回显到 params', async () => {
  const w = writeCookie('  cookie: SESSDATA=abc%2C123; bili_jct=zzz;\n');
  assert.equal(w.ok, true);
  assert.equal(readCookie(), 'SESSDATA=abc%2C123; bili_jct=zzz');

  fetchImpl = async (url) => (url.includes('/newlist')
    ? jsonResponse({ code: 0, data: { archives: [archive()] } })
    : jsonResponse(viewBody()));
  const plugin = new BilibiliKnowledgePlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ limit: 1, enrich: false });

  const sent = fetchCalls.find((c) => c.url.includes('/newlist'));
  assert.equal(sent.init.headers.Cookie, 'SESSDATA=abc%2C123; bili_jct=zzz');
  const json = JSON.stringify(out);
  assert.ok(!json.includes('SESSDATA'), 'output.json 不能回显 Cookie');
  assert.ok(!('cookie' in (out.params || {})), 'params 不能包含 cookie');
  assert.ok(!out.cache.key.includes('SESSDATA'), '缓存 key 不能包含 Cookie');

  const st = cookieStatus();
  assert.equal(st.configured, true);
  assert.equal(st.hasSessdata, true);
  assert.ok(!JSON.stringify(st).includes('abc%2C123'), '状态接口不能泄露 Cookie 原文');
  clearCookie();
  assert.equal(cookieStatus().configured, false);
});

test('Cookie：空 / 缺 SESSDATA / 格式错都拒绝写入', async () => {
  assert.equal(validateCookie('').ok, false);
  assert.equal(validateCookie('bili_jct=zzz').ok, false);
  assert.equal(validateCookie('not-a-cookie').ok, false);
  assert.equal(writeCookie('bili_jct=zzz').ok, false);
  assert.equal(readCookie(), '');
  assert.equal(sanitizeCookie('Cookie: A=1;\nB=2;'), 'A=1; B=2');
});

test('知识区：-352 风控映射为可重试 API_RATE_LIMIT，并提示手动配 Cookie', async () => {
  fetchImpl = async () => jsonResponse({ code: -352, message: '-352' });
  const plugin = new BilibiliKnowledgePlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  await assert.rejects(() => plugin.run({ limit: 1 }), (e) => {
    assert.equal(e.code, 'API_RATE_LIMIT');
    assert.match(e.message, /手动粘贴 Cookie/);
    return true;
  });
});

test('知识区：补抓播放失败时降级为 warning，不整体失败', async () => {
  let views = 0;
  fetchImpl = async (url) => {
    if (url.includes('/newlist')) {
      return jsonResponse({ code: 0, data: { archives: [archive({ bvid: 'BV1a' }), archive({ bvid: 'BV1b' })] } });
    }
    views += 1;
    return jsonResponse({ code: -412, message: 'risk' });
  };
  const plugin = new BilibiliKnowledgePlugin({ cacheDir: path.join(tmp, 'cache'), minIntervalMs: 0 });
  const out = await plugin.run({ limit: 2, enrich: true });
  await assertContract(out);
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].views, 0);
  assert.ok((out.warnings || []).some((w) => w.includes('补抓播放数据失败')));
  assert.ok(views <= 2);
});
