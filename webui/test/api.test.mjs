// Web 控制台 API 冒烟测试：只验证路由与安全边界，不触发任何真实流水线。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, ['webui/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, OPC_WEB_PORT: String(PORT), OPC_WEB_NO_OPEN: '1' },
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

after(() => { try { child.kill(); } catch {} });

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
