// 两个 schema 的同构性守护：同一份 fixture 必须同时通过
//   skils/generate-script/schemas/output.schema.json（调度器校验用，内联）
//   skills/render-remotion/schemas/input.schema.json（render 步骤读取用，$ref）
// 任一处改动导致行为漂移就会挂。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createValidator } from '../../../scheduler/lib/schema.js';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats').default;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

function assemble() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-gen-'));
  for (const f of ['input.json', 'draft.json']) {
    fs.copyFileSync(path.join(ROOT, 'fixtures/generate-script', f), path.join(work, f));
  }
  execFileSync(process.execPath, [
    path.join(ROOT, 'skills/generate-script/scripts/assemble.mjs'),
    '--input', path.join(work, 'input.json'),
    '--draft', path.join(work, 'draft.json'),
    '--output', path.join(work, 'output.json'),
  ], { env: { ...process.env, OPC_ROOT: ROOT, OPC_RUN_ID: `test-${process.pid}` }, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(path.join(work, 'output.json'), 'utf8'));
}

test('generate-script 产物同时通过 render-remotion input 与自身 output schema', () => {
  const out = assemble();

  // 调度器侧：必须能只靠 skills/generate-script/schemas/output.schema.json 校验
  const own = createValidator(ROOT).validate(path.join(ROOT, 'skills/generate-script/schemas/output.schema.json'), out);
  assert.equal(own.ok, true, own.errors.join('; '));

  // 渲染侧：input schema 带相对 $ref，需要同时注册 storyboard schema
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const sb = read(path.join(ROOT, 'skills/render-remotion/schemas/storyboard.schema.json'));
  ajv.addSchema(sb, sb.$id);
  const inputSchema = read(path.join(ROOT, 'skills/render-remotion/schemas/input.schema.json'));
  const fn = ajv.getSchema(inputSchema.$id) || ajv.compile(inputSchema);
  assert.equal(fn(out), true, ajv.errorsText(fn.errors, { separator: '; ' }));
});

test('时长偏差超过 20% 时拒绝组装', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-gen-'));
  fs.copyFileSync(path.join(ROOT, 'fixtures/generate-script/input.json'), path.join(work, 'input.json'));
  const draft = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/generate-script/draft.json'), 'utf8'));
  draft.scenes = draft.scenes.map((s) => ({ ...s, durationSec: 2 })); // 8s，远低于 30s
  fs.writeFileSync(path.join(work, 'draft.json'), JSON.stringify(draft));

  assert.throws(() => execFileSync(process.execPath, [
    path.join(ROOT, 'skills/generate-script/scripts/assemble.mjs'),
    '--input', path.join(work, 'input.json'),
    '--draft', path.join(work, 'draft.json'),
    '--output', path.join(work, 'output.json'),
  ], { env: { ...process.env, OPC_ROOT: ROOT, OPC_RUN_ID: `test-${process.pid}` }, stdio: 'pipe' }));

  const err = JSON.parse(fs.readFileSync(path.join(work, 'error.json'), 'utf8'));
  assert.equal(err.code, 'DURATION_MISMATCH');
});
