import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const validate = path.join(HERE, '..', 'scripts', 'validate.mjs');
const fixture = path.join(ROOT, 'fixtures', 'recommend-themes', 'output.json');
const dashboard = path.join(ROOT, 'fixtures', 'recommend-themes', 'input.json');

const run = (themesFile) => spawnSync(process.execPath, [validate, themesFile, '--dashboard', dashboard], { encoding: 'utf8' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-themes-'));

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('主题样例：6 条且 evidence 全部可在看板解析', () => {
  const r = run(fixture);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /6 themes \(3 external \/ 3 internal\)/);
});

test('主题校验：外部/内部数量不对要报错', () => {
  const d = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  d.themes[0].source = 'internal';
  const f = path.join(tmp, 'bad-count.json');
  fs.writeFileSync(f, JSON.stringify(d));
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /外部主题必须 3 条/);
});

test('主题校验：编造 evidence 指针要报错', () => {
  const d = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  d.themes[0].evidence[0].pointer = '/externalTrends/topTopics/99';
  const f = path.join(tmp, 'bad-pointer.json');
  fs.writeFileSync(f, JSON.stringify(d));
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /找不到/);
});

test('主题校验：id 重复要报错', () => {
  const d = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  d.themes[1].id = d.themes[0].id;
  const f = path.join(tmp, 'dup-id.json');
  fs.writeFileSync(f, JSON.stringify(d));
  const r = run(f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /id 有重复/);
});
