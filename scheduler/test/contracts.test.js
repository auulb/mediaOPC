import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createValidator } from '../lib/schema.js';
import { validateFixtures } from '../lib/fixtures.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('contracts 全部能被 ajv 加载', () => {
  const v = createValidator(repo);
  assert.deepEqual(v.warnings, []);
  for (const name of ['step-envelope', 'raw-items', 'dashboard', 'themes', 'production', 'publish-record', 'token-ledger']) {
    assert.equal(v.hasContract(name), true, `缺少契约 ${name}`);
  }
});

test('fixtures/ 全部通过对应契约校验', () => {
  const v = createValidator(repo);
  const r = validateFixtures(repo, v);
  assert.ok(r.checked > 0, '没有校验任何 fixture');
  assert.deepEqual(r.failures, [], JSON.stringify(r.failures, null, 2));
});

test('step-envelope 拒绝缺字段、拒绝 success 带 error', () => {
  const v = createValidator(repo);
  const good = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/step-envelope/output.json'), 'utf8'));
  assert.equal(v.validate('step-envelope', good).ok, true);
  const missing = { ...good };
  delete missing.status;
  assert.equal(v.validate('step-envelope', missing).ok, false);
  assert.equal(v.validate('step-envelope', { ...good, error: { code: 'X', message: 'x' } }).ok, false);
});

test('token-ledger 拒绝负 token 和未知字段', () => {
  const v = createValidator(repo);
  const good = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/token-ledger/output.json'), 'utf8'));
  assert.equal(v.validate('token-ledger', good).ok, true);
  assert.equal(v.validate('token-ledger', { ...good, totalTokens: -1 }).ok, false);
  assert.equal(v.validate('token-ledger', { ...good, secret: 'x' }).ok, false);
});
