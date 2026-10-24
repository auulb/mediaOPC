import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import fs from 'node:fs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => YAML.parse(fs.readFileSync(path.join(repo, 'config', f), 'utf8'));

test('pipeline.yaml 可解析，echo 冒烟步骤齐全', () => {
  const doc = read('pipeline.yaml');
  assert.equal(doc.version, 1);
  assert.equal(doc.pipelines['echo-smoke'].steps[0].skill, 'echo');
  assert.equal(doc.pipelines['echo-retry-smoke'].steps[0].input, 'fixtures/echo/input.fail-twice.json');
  assert.deepEqual(doc.pipelines['echo-chain'].steps[1].depends_on, ['first']);
  assert.equal(doc.pipelines['trends-analysis'].steps[2].skill, 'build-dashboard');
  assert.deepEqual(doc.pipelines['trends-analysis'].steps[2].depends_on, ['fetch-bilibili', 'fetch-internal']);
});

test('pipeline.yaml 每条 pipeline 都能 normalize', () => {
  const doc = read('pipeline.yaml');
  for (const [id, p] of Object.entries(doc.pipelines)) {
    assert.ok(Array.isArray(p.steps) && p.steps.length > 0, `${id} 没有 steps`);
  }
});

test('schedule.yaml 默认不启用任何定时任务', () => {
  const doc = read('schedule.yaml');
  assert.ok(Array.isArray(doc.schedules));
  assert.equal(doc.schedules.every((s) => s.enabled === false), true);
});

test('token-budget.yaml 阈值与日预算合法', () => {
  const doc = read('token-budget.yaml');
  assert.ok(doc.daily > 0);
  assert.ok(doc.alertThresholds.warning < doc.alertThresholds.critical);
  assert.equal(doc.stepLimits['recommend-themes'], 50000);
  assert.equal(doc.stepWarnTokens, 100000);
});
