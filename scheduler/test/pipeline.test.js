import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline, normalizePipeline, topoSort, loadPipelineConfig } from '../lib/pipeline.js';
import { makeTempRoot, makeExecutor, repo } from './helpers.js';

const echoStep = (id, extra = {}) => ({ id, skill: 'echo', ...extra });
const inputPath = (root) => path.join(root, 'fixtures/echo/input.json');

test('pipeline：顺序执行，后一步 input = 前一步 output', async (t) => {
  const { root, fake } = makeTempRoot(t);
  const config = {
    pipelines: {
      chain: {
        steps: [
          echoStep('first', { input: 'fixtures/echo/input.json' }),
          echoStep('second', { depends_on: ['first'] }),
        ],
      },
    },
  };
  const result = await runPipeline(root, 'chain', { config, executor: makeExecutor(root, fake), runId: 'run-chain' });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.steps.map((s) => s.id), ['first', 'second']);

  const firstOut = JSON.parse(fs.readFileSync(path.join(root, 'workspace/run-chain/first/attempt-1/output.json'), 'utf8'));
  const secondIn = JSON.parse(fs.readFileSync(path.join(root, 'workspace/run-chain/second/attempt-1/input.json'), 'utf8'));
  assert.deepEqual(secondIn, firstOut);
  assert.equal(secondIn.message, 'hello from opc');

  const tasks = JSON.parse(fs.readFileSync(path.join(root, 'dashboard/task_status.json'), 'utf8')).tasks;
  assert.deepEqual(tasks.map((x) => x.status), ['success', 'success']);
  const run = JSON.parse(fs.readFileSync(path.join(root, 'workspace/run-chain/run.json'), 'utf8'));
  assert.equal(run.status, 'success');
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[1].output.endsWith('attempt-1/output.json'), true);
});

test('pipeline：input 模板 {{steps.<id>.output}} 替换为依赖 output 路径', async (t) => {
  const { root, fake } = makeTempRoot(t);
  const config = {
    pipelines: {
      tpl: {
        steps: [
          echoStep('first', { input: 'fixtures/echo/input.json' }),
          echoStep('second', { input: 'fixtures/echo/input.template.json', depends_on: ['first'] }),
        ],
      },
    },
  };
  const result = await runPipeline(root, 'tpl', { config, executor: makeExecutor(root, fake), runId: 'run-tpl' });
  assert.equal(result.status, 'success');
  const firstOut = path.join(root, 'workspace/run-tpl/first/attempt-1/output.json');
  const secondIn = JSON.parse(fs.readFileSync(path.join(root, 'workspace/run-tpl/second/attempt-1/input.json'), 'utf8'));
  assert.equal(secondIn.message, firstOut);
  const secondOut = JSON.parse(fs.readFileSync(path.join(root, 'workspace/run-tpl/second/attempt-1/output.json'), 'utf8'));
  assert.equal(secondOut.message, firstOut);
});

test('pipeline：多依赖合并为 { depId: output }', async (t) => {
  const { root, fake } = makeTempRoot(t);
  const config = {
    pipelines: {
      dag: {
        steps: [
          echoStep('a', { input: 'fixtures/echo/input.json' }),
          echoStep('b', { input: 'fixtures/echo/input.json' }),
          echoStep('c', { depends_on: ['a', 'b'] }),
        ],
      },
    },
  };
  const result = await runPipeline(root, 'dag', { config, executor: makeExecutor(root, fake), runId: 'run-dag' });
  assert.equal(result.status, 'success');
  const merged = JSON.parse(fs.readFileSync(path.join(root, 'workspace/run-dag/_inputs/c.json'), 'utf8'));
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b']);
  assert.equal(merged.a.message, 'hello from opc');
});

test('pipeline：前序失败时后续 skipped，run 失败，attempts 保留', async (t) => {
  const { root, fake } = makeTempRoot(t);
  const config = {
    pipelines: {
      fail: {
        steps: [
          echoStep('bad', { input: 'fixtures/echo/input.fail-twice.json', retry: { maxAttempts: 1 } }),
          echoStep('after', { depends_on: ['bad'] }),
        ],
      },
    },
  };
  const result = await runPipeline(root, 'fail', { config, executor: makeExecutor(root, fake), runId: 'run-fail' });
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[1].status, 'skipped');

  const tasks = JSON.parse(fs.readFileSync(path.join(root, 'dashboard/task_status.json'), 'utf8')).tasks;
  assert.deepEqual(tasks.map((x) => x.status), ['failed', 'skipped']);
  assert.equal(fs.existsSync(path.join(root, 'workspace/run-fail/bad/attempt-1/exit_code')), true);
});

test('pipeline：非法 runId / pipelineId 在启动前报错', async (t) => {
  const { root, fake } = makeTempRoot(t);
  const config = { pipelines: { p: { steps: [echoStep('a', { input: 'fixtures/echo/input.json' })] } } };
  const executor = makeExecutor(root, fake);
  await assert.rejects(() => runPipeline(root, 'p', { config, executor, runId: '../x' }), /runId 非法/);
  assert.throws(() => normalizePipeline('../p', { steps: [echoStep('a')] }), /pipelineId 非法/);
});

test('pipeline：环检测、依赖不存在、重复 id 在启动前报错', async (t) => {
  const { root, fake } = makeTempRoot(t);
  const executor = makeExecutor(root, fake);
  const cycle = { pipelines: { c: { steps: [echoStep('a', { depends_on: ['b'] }), echoStep('b', { depends_on: ['a'] })] } } };
  await assert.rejects(() => runPipeline(root, 'c', { config: cycle, executor }), /存在环/);
  const missing = { pipelines: { m: { steps: [echoStep('a', { depends_on: ['nope'] })] } } };
  await assert.rejects(() => runPipeline(root, 'm', { config: missing, executor }), /依赖不存在/);
  const dup = { pipelines: { d: { steps: [echoStep('a'), echoStep('a')] } } };
  await assert.rejects(() => runPipeline(root, 'd', { config: dup, executor }), /重复/);
});

test('normalizePipeline / topoSort 保持配置顺序并尊重依赖', () => {
  const steps = normalizePipeline('p', {
    steps: [
      { id: 'render', skill: 'echo', depends_on: ['script'] },
      { id: 'script', skill: 'echo' },
      { id: 'publish', skill: 'echo', depends_on: ['render'] },
    ],
  });
  assert.deepEqual(topoSort(steps), ['script', 'render', 'publish']);
  assert.throws(() => normalizePipeline('p', { steps: [] }), /没有 steps/);
  assert.throws(() => normalizePipeline('p', { steps: [{ id: 'x' }] }), /skill 非法/);
});

test('config/pipeline.yaml 是合法配置，且能列出 echo 冒烟 pipeline', () => {
  const doc = loadPipelineConfig(repo);
  assert.ok(doc.pipelines['echo-smoke']);
  const steps = normalizePipeline('echo-smoke', doc.pipelines['echo-smoke']);
  assert.equal(steps[0].skill, 'echo');
  assert.equal(steps[0].input, 'fixtures/echo/input.json');
  // 不应在仓库根留下测试输入（仅确认 fixture 存在）
  assert.equal(fs.existsSync(inputPath(repo)), true);
});
