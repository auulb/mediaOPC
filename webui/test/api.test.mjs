// Web 控制台 API 冒烟测试：只验证路由与安全边界，不触发任何真实流水线。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let tmp;

before(async () => {
  // 定时/采集状态写到临时目录，测试不污染仓库 data/
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opc-webui-'));
  child = spawn(process.execPath, ['webui/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPC_WEB_PORT: String(PORT),
      OPC_WEB_NO_OPEN: '1',
      OPC_SCHED_DIR: path.join(tmp, 'schedule'),
      OPC_SOURCES_DIR: path.join(tmp, 'sources'),
      OPC_COOKIE_FILE: path.join(tmp, 'cookie.txt'),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/bootstrap`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务器没起来');
});

after(async () => {
  try { child.kill(); } catch {}
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test('首页与静态资源可访问', async () => {
  for (const p of ['/', '/app.js', '/style.css']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    assert.ok((await r.text()).length > 100, p);
  }
});

test('bootstrap 至少返回 create-video 与 trends-analysis，且排在冒烟前面', async () => {
  const b = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const ids = b.pipelines.map((p) => p.id);
  assert.ok(ids.includes('create-video'));
  assert.ok(ids.includes('trends-analysis'));
  assert.equal(ids[0], 'create-video');
  assert.ok(Array.isArray(b.themeSources));
  assert.ok(Array.isArray(b.runs));
});

test('选题接口返回主题列表', async () => {
  const r = await fetch(`${BASE}/api/themes?path=fixtures/recommend-themes/output.json`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.themes.length > 0);
  assert.ok(d.themes[0].id && d.themes[0].title);
});

test('不允许通过 /media 读浏览器登录态（cookie）', async () => {
  const r = await fetch(`${BASE}/media?p=data/browser-profiles/bilibili/Default/Cookies`);
  assert.equal(r.status, 403);
});

test('不允许路径穿越', async () => {
  for (const p of ['../../etc/passwd', '/etc/passwd']) {
    const r = await fetch(`${BASE}/media?p=${encodeURIComponent(p)}`);
    assert.notEqual(r.status, 200, p);
  }
});

test('unknown pipeline 返回 400，而不是崩掉进程', async () => {
  const r = await fetch(`${BASE}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pipeline: 'nope' }),
  });
  assert.equal(r.status, 400);
});

test('不存在的 run 返回 404', async () => {
  const r = await fetch(`${BASE}/api/run?id=does-not-exist`);
  assert.equal(r.status, 404);
});

test('教程接口返回 markdown', async () => {
  const r = await fetch(`${BASE}/api/tutorial`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /OPC 使用教程/);
});

test('/api/data 返回看板、数据源与博主聚合', async () => {
  const d = await (await fetch(`${BASE}/api/data`)).json();
  assert.ok(d.dashboard);
  assert.ok(Array.isArray(d.sources.sources));
  assert.ok(d.sources.sources.length >= 1);
  assert.ok(Array.isArray(d.sources.creators));
  assert.ok(d.sources.creators.some((c) => c.name));
  assert.ok(Array.isArray(d.schedule));
});

test('/api/topics 给出外部 3 + 内部 3，且不混入 fixture', async () => {
  const t = await (await fetch(`${BASE}/api/topics`)).json();
  assert.ok(t.recommendations.external.length <= 3);
  assert.ok(t.recommendations.internal.length <= 3);
  assert.ok(t.themes.every((x) => !String(x.themesFile).startsWith('fixtures/')));
  for (const x of [...t.recommendations.external, ...t.recommendations.internal]) {
    assert.equal(x.themesFile, t.primaryPath);
  }
});

test('/api/productions 每条都带 video 路径与横竖封面字段', async () => {
  const d = await (await fetch(`${BASE}/api/productions`)).json();
  assert.ok(Array.isArray(d.productions));
  for (const p of d.productions) {
    assert.ok(p.video?.path, p.productionId);
    assert.ok('coverPortrait' in p);
  }
});

test('POST /api/publish 没有成片时 404', async () => {
  const r = await fetch(`${BASE}/api/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'no-such-run', publish: false }),
  });
  assert.equal(r.status, 404);
});

test('POST /api/create/render 没有稿子时 404', async () => {
  const r = await fetch(`${BASE}/api/create/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'no-such-run' }),
  });
  assert.equal(r.status, 404);
});

test('数据接口：Cookie 必须手动写入，且接口永不回显原文', async () => {
  let st = await (await fetch(`${BASE}/api/cookie`)).json();
  assert.equal(st.configured, false);
  assert.equal(st.manualOnly, true);

  // 缺 SESSDATA → 400，不落盘
  const bad = await fetch(`${BASE}/api/cookie`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookie: 'bili_jct=zzz' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await (await fetch(`${BASE}/api/cookie`)).json()).configured, false);

  const ok = await fetch(`${BASE}/api/cookie`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookie: 'Cookie: SESSDATA=secret-value; bili_jct=zzz;' }),
  });
  assert.equal(ok.status, 200);
  const d = await ok.json();
  assert.equal(d.configured, true);
  assert.equal(d.hasSessdata, true);
  assert.ok(!JSON.stringify(d).includes('secret-value'), '接口不能返回 Cookie 原文');

  // /api/data 里也不能出现 Cookie 原文；/media 读不到
  const data = await (await fetch(`${BASE}/api/data`)).json();
  assert.ok(!JSON.stringify(data).includes('secret-value'));
  const media = await fetch(`${BASE}/media?p=data/secrets/bilibili-cookie.txt`);
  assert.equal(media.status, 403);

  await fetch(`${BASE}/api/cookie`, { method: 'DELETE' });
  st = await (await fetch(`${BASE}/api/cookie`)).json();
  assert.equal(st.configured, false);
});

test('定时定点：默认任务存在，保存会规范化时间点/星期，且只用确定性脚本', async () => {
  const s = await (await fetch(`${BASE}/api/schedule`)).json();
  assert.equal(s.aiFree, true);
  assert.equal(s.server.mode, 'no-ai');
  assert.equal(s.job.id, 'knowledge-latest');
  assert.ok(Array.isArray(s.zones) && s.zones.some((z) => z.tid === 36));
  assert.ok(s.script.includes('fetch-bilibili-knowledge'));
  assert.equal(s.job.params.tid, 36);

  const r = await fetch(`${BASE}/api/schedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job: {
        id: 'knowledge-latest',
        enabled: true,
        times: ['25:99', '08:30', '08:30', '19:05'],
        days: [1, 2, 9, 2],
        params: { tid: 201, limit: 999, enrich: false, keywords: ['AI', 'ai', '  '] },
      },
    }),
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.job.times, ['08:30', '19:05']);
  assert.deepEqual(d.job.days, [1, 2]);
  assert.equal(d.job.params.tid, 201);
  assert.equal(d.job.params.limit, 50);
  assert.equal(d.job.params.enrich, false);
  assert.deepEqual(d.job.params.keywords, ['AI', 'ai']);
  assert.ok(d.job.nextRunAt, '启用后应算出下次执行时间');

  // 落盘再读，保持一致
  const again = await (await fetch(`${BASE}/api/schedule`)).json();
  assert.deepEqual(again.job.times, ['08:30', '19:05']);
});
