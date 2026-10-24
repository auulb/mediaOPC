import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StepExecutor, isRetryable } from '../lib/executor.js';
import { createValidator } from '../lib/schema.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name) => path.join(repo, 'fixtures/echo', name);

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-exec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, 'contracts'), path.join(root, 'contracts'), { recursive: true });
  fs.cpSync(path.join(repo, 'skills/echo'), path.join(root, 'skills/echo'), { recursive: true });
  const fake = path.join(root, 'fake-pi');
  fs.copyFileSync(path.join(repo, 'scheduler/test/fixtures/fake-pi'), fake);
  fs.chmodSync(fake, 0o755);
  return { root, fake };
}

function makeExecutor(root, fake, retry = {}) {
  return new StepExecutor({ root, piBin: fake, launcher: 'spawn', retry: { maxAttempts: 3, baseDelayMs: 10, ...retry }, pollMs: 20 });
}

const step = (extra = {}) => ({ id: 'echo', skill: 'echo', timeout: 10, ...extra });
const ctx = (runId, pipelineId = 'test') => ({ runId, pipelineId });

test('失败 2 次后第 3 次成功：保留 3 个 attempt，双判定，ledger 完整', async (t) => {
  const { root, fake } = makeRoot(t);
  const secret = 'sk-test-secret';
  const prev = process.env.FAKE_SECRET;
  process.env.FAKE_SECRET = secret;
  t.after(() => { if (prev === undefined) delete process.env.FAKE_SECRET; else process.env.FAKE_SECRET = prev; });

  const exec = makeExecutor(root, fake);
  const env = await exec.executeWithRetry(step({ env: ['FAKE_SECRET'] }), ctx('run-retry'), fixture('input.fail-twice.json'));

  assert.equal(env.status, 'success');
  assert.equal(env.attempt, 3);
  assert.ok(env.output?.path.endsWith('attempt-3/output.json'));

  const attemptDir = (n) => path.join(root, 'workspace', 'run-retry', 'echo', `attempt-${n}`);
  for (const n of [1, 2, 3]) {
    assert.equal(fs.existsSync(path.join(attemptDir(n), 'run.sh')), true, `attempt-${n}/run.sh 应保留`);
    assert.equal(fs.existsSync(path.join(attemptDir(n), 'exit_code')), true);
  }
  assert.equal(fs.readFileSync(path.join(attemptDir(1), 'exit_code'), 'utf8').trim(), '1');
  assert.equal(fs.readFileSync(path.join(attemptDir(2), 'exit_code'), 'utf8').trim(), '1');
  assert.equal(fs.existsSync(path.join(attemptDir(1), 'output.json')), false);
  assert.equal(fs.existsSync(path.join(attemptDir(2), 'output.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(attemptDir(3), 'output.json'), 'utf8')).attempt, 3);

  const v = createValidator(root);
  const e1 = JSON.parse(fs.readFileSync(path.join(attemptDir(1), 'envelope.json'), 'utf8'));
  const e3 = JSON.parse(fs.readFileSync(path.join(attemptDir(3), 'envelope.json'), 'utf8'));
  assert.equal(v.validate('step-envelope', e1).ok, true, JSON.stringify(v.validate('step-envelope', e1).errors));
  assert.equal(v.validate('step-envelope', e3).ok, true);
  assert.equal(e1.status, 'failed');
  assert.equal(e1.error.code, 'NONZERO_EXIT');
  assert.equal(isRetryable(e1.error), true);
  assert.equal(e3.usage.totalTokens, 10);

  const ledger = fs.readFileSync(path.join(root, 'data/token_ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 3);
  assert.deepEqual(ledger.map((l) => l.outcome), ['failed', 'failed', 'success']);
  assert.deepEqual(ledger.map((l) => l.attempt), [1, 2, 3]);
  for (const l of ledger) assert.equal(v.validate('token-ledger', l).ok, true, JSON.stringify(v.validate('token-ledger', l).errors));
  assert.equal(ledger.reduce((s, l) => s + l.totalTokens, 0), 30);

  // 密钥只出现在 env.sh（0600），run.sh / 日志 / envelope 都没有
  const runSh = fs.readFileSync(path.join(attemptDir(3), 'run.sh'), 'utf8');
  assert.equal(runSh.includes(secret), false);
  const envSh = fs.readFileSync(path.join(attemptDir(3), 'env.sh'), 'utf8');
  assert.equal(envSh.includes(secret), true);
  assert.equal(fs.statSync(path.join(attemptDir(3), 'env.sh')).mode & 0o777, 0o600);
  const log = fs.readFileSync(path.join(root, 'logs', 'run-retry', 'echo', 'step.log.jsonl'), 'utf8');
  assert.equal(log.includes(secret), false);
});

test('error.json 不可重试：只跑 1 次 attempt', async (t) => {
  const { root, fake } = makeRoot(t);
  const exec = makeExecutor(root, fake);
  const env = await exec.executeWithRetry(step(), ctx('run-biz'), fixture('input.business-error.json'));

  assert.equal(env.status, 'failed');
  assert.equal(env.attempt, 1);
  assert.equal(env.exitCode, 0);
  assert.equal(env.error.code, 'PRECHECK_FAILED');
  assert.equal(isRetryable(env.error), false);
  assert.equal(fs.existsSync(path.join(root, 'workspace', 'run-biz', 'echo', 'attempt-2')), false);
  assert.equal(fs.existsSync(path.join(root, 'workspace', 'run-biz', 'echo', 'attempt-1', 'error.json')), true);
});

test('超时：终止进程、attempt 只跑 1 次、错误码 TIMEOUT', async (t) => {
  const { root, fake } = makeRoot(t);
  const exec = makeExecutor(root, fake, { maxAttempts: 1 });
  const started = Date.now();
  const env = await exec.executeWithRetry(step({ timeout: 0.4 }), ctx('run-timeout'), fixture('input.timeout.json'));
  const elapsed = Date.now() - started;

  assert.equal(env.status, 'failed');
  assert.equal(env.error.code, 'TIMEOUT');
  assert.equal(env.exitCode, null);
  assert.ok(elapsed < 4000, `超时清理太慢: ${elapsed}ms`);
  assert.equal(fs.existsSync(path.join(root, 'workspace', 'run-timeout', 'echo', 'attempt-2')), false);
});

test('单步 token 超阈值只告警，不判失败', async (t) => {
  const { root, fake } = makeRoot(t);
  const exec = makeExecutor(root, fake);
  const env = await exec.executeWithRetry(step({ tokenWarn: 5 }), ctx('run-token-warn'), fixture('input.json'));
  assert.equal(env.status, 'success');
  const log = fs.readFileSync(path.join(root, 'logs', 'run-token-warn', 'echo', 'step.log.jsonl'), 'utf8');
  assert.match(log, /token 超阈值/);
});

test('runId 含路径字符时在启动前报错', async (t) => {
  const { root, fake } = makeRoot(t);
  const exec = makeExecutor(root, fake);
  await assert.rejects(
    () => exec.executeWithRetry(step(), { runId: '../evil', pipelineId: 'test' }, fixture('input.json')),
    /runId 非法/,
  );
  assert.equal(fs.existsSync(path.join(root, 'workspace', 'evil')), false);
});

test('skill 不存在时在启动前报配置错误', async (t) => {
  const { root, fake } = makeRoot(t);
  const exec = makeExecutor(root, fake);
  await assert.rejects(
    () => exec.executeWithRetry({ id: 'nope', skill: 'nope' }, ctx('run-nope'), fixture('input.json')),
    /skill 不存在/,
  );
});
