import test from 'node:test';
import assert from 'node:assert/strict';
import { sumUsageText, sumUsageFile, emptyUsage } from '../lib/usage.js';

test('从 message_end 汇总 assistant usage，忽略 user / 非 JSON 行', () => {
  const lines = [
    JSON.stringify({ type: 'message_end', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'message_update', usage: { totalTokens: 999 }, assistantMessageEvent: { type: 'text_delta', delta: 'x' } }),
    'not json',
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'p', model: 'm', usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, totalTokens: 128, cost: { total: 0.5 } } } }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.25 } } } }),
  ].join('\n');
  const u = sumUsageText(lines);
  assert.equal(u.input, 110);
  assert.equal(u.output, 22);
  assert.equal(u.cacheRead, 5);
  assert.equal(u.cacheWrite, 3);
  assert.equal(u.totalTokens, 140);
  assert.equal(u.costUsd, 0.75);
  assert.equal(u.messages, 2);
  assert.equal(u.provider, 'p');
  assert.equal(u.model, 'm');
});

test('缺 totalTokens 时用 input+output 兜底；空文件返回零', () => {
  const u = sumUsageText(JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 7, output: 3 } } }));
  assert.equal(u.totalTokens, 10);
  assert.deepEqual(sumUsageFile('/definitely/not/here.jsonl'), emptyUsage());
});
