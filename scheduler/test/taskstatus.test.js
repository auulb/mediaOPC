import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TaskStatusStore } from '../lib/taskstatus.js';
import { makeTempRoot } from './helpers.js';

test('task_status：initRun → running → success，按 runId+stepId 更新同一条', (t) => {
  const { root } = makeTempRoot(t);
  const store = new TaskStatusStore(root);
  store.initRun({ runId: 'r1', pipelineId: 'p', steps: [{ id: 'a', skill: 'echo' }, { id: 'b', skill: 'echo' }] });
  store.update('r1', 'a', { status: 'running', startedAt: '2024-01-01T00:00:00Z' });
  store.update('r1', 'a', { status: 'success', finishedAt: '2024-01-01T00:00:01Z', tokens: 10 });

  const doc = JSON.parse(fs.readFileSync(path.join(root, 'dashboard/task_status.json'), 'utf8'));
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.tasks.length, 2);
  const a = doc.tasks.find((x) => x.stepId === 'a');
  assert.equal(a.status, 'success');
  assert.equal(a.tokens, 10);
  assert.equal(a.startedAt, '2024-01-01T00:00:00Z');
  assert.equal(doc.tasks.find((x) => x.stepId === 'b').status, 'pending');
});

test('task_status：拒绝非法状态，文件损坏时从空开始', (t) => {
  const { root } = makeTempRoot(t);
  const file = path.join(root, 'dashboard/task_status.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const store = new TaskStatusStore(root);
  assert.deepEqual(store.read().tasks, []);
  assert.throws(() => store.update('r', 's', { status: 'done' }), /非法 task status/);
  store.update('r', 's', { status: 'running' }, { pipelineId: 'p', skill: 'echo' });
  assert.equal(store.get('r', 's').status, 'running');
});
