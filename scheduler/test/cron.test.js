import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCron, cronMatches, loadSchedules, runDue, formatMinute } from '../lib/cron.js';
import { makeTempRoot, repo } from './helpers.js';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);

test('cron：5 段、范围、步长、英文月/星期', () => {
  assert.equal(cronMatches('0 9 * * *', at(2024, 1, 1, 9, 0)), true);
  assert.equal(cronMatches('0 9 * * *', at(2024, 1, 1, 9, 1)), false);
  assert.equal(cronMatches('*/5 * * * *', at(2024, 1, 1, 9, 35)), true);
  assert.equal(cronMatches('*/5 * * * *', at(2024, 1, 1, 9, 36)), false);
  assert.equal(cronMatches('0 14 * * MON,WED,FRI', at(2024, 1, 1, 14, 0)), true); // 2024-01-01 周一
  assert.equal(cronMatches('0 14 * * MON,WED,FRI', at(2024, 1, 2, 14, 0)), false); // 周二
  assert.equal(cronMatches('0 0 1-7 JAN *', at(2024, 1, 3, 0, 0)), true);
  assert.equal(cronMatches('0 0 8 JAN *', at(2024, 1, 3, 0, 0)), false);
  assert.equal(cronMatches('0 0 * * 7', at(2024, 1, 7, 0, 0)), true); // 周日
  assert.throws(() => parseCron('* * * *'), /5 段/);
  assert.throws(() => parseCron('60 * * * *'), /越界/);
});

test('cron：schedule.yaml 可加载且默认不启用', () => {
  const list = loadSchedules(repo);
  assert.ok(Array.isArray(list));
  assert.equal(list.every((s) => s.enabled === false), true);
});

test('runDue：到期才跑、同分钟去重、下次到期再跑', async (t) => {
  const { root } = makeTempRoot(t);
  const schedules = [{ name: 'daily', cron: '0 9 * * *', pipeline: 'p', enabled: true, dependencies: [], manual_approval: false }];
  let calls = 0;
  const runner = async () => { calls += 1; return { status: 'success', runId: `r${calls}` }; };

  const r1 = await runDue(root, at(2024, 1, 1, 9, 0), { schedules, runner });
  assert.equal(r1.length, 1);
  assert.equal(calls, 1);
  const state1 = JSON.parse(fs.readFileSync(path.join(root, 'data/schedule_state.json'), 'utf8'));
  assert.equal(state1.schedules.daily.lastStatus, 'success');
  assert.equal(state1.schedules.daily.lastRunMinute, formatMinute(at(2024, 1, 1, 9, 0)));

  const r2 = await runDue(root, at(2024, 1, 1, 9, 0), { schedules, runner });
  assert.equal(r2.length, 0);
  assert.equal(calls, 1);

  const r3 = await runDue(root, at(2024, 1, 1, 9, 1), { schedules, runner });
  assert.equal(r3.length, 0);

  const r4 = await runDue(root, at(2024, 1, 2, 9, 0), { schedules, runner });
  assert.equal(r4.length, 1);
  assert.equal(calls, 2);
});

test('runDue：dependencies 未成功则跳过，manual_approval / enabled:false 不跑', async (t) => {
  const { root } = makeTempRoot(t);
  const schedules = [
    { name: 'a', cron: '0 9 * * *', pipeline: 'p', enabled: true, dependencies: [], manual_approval: false },
    { name: 'b', cron: '0 9 * * *', pipeline: 'p', enabled: true, dependencies: ['a'], manual_approval: false },
    { name: 'c', cron: '0 9 * * *', pipeline: 'p', enabled: false, dependencies: [], manual_approval: false },
    { name: 'd', cron: '0 9 * * *', pipeline: 'p', enabled: true, dependencies: [], manual_approval: true },
  ];
  let calls = 0;
  const runner = async ({ schedule }) => {
    calls += 1;
    return { status: schedule.name === 'a' ? 'failed' : 'success', runId: `r-${schedule.name}` };
  };
  const results = await runDue(root, at(2024, 1, 1, 9, 0), { schedules, runner });
  assert.deepEqual(results.map((r) => [r.name, r.status]), [
    ['a', 'failed'],
    ['b', 'dependency_failed'],
    ['d', 'pending_approval'],
  ]);
  assert.equal(calls, 1);
});
