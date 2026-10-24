// 发布记录契约测试：每种状态都必须能通过 contracts/publish-record.schema.json
// 目的是挡住两类回归：STATUS 键名写错导致 status=undefined；if/then 在缺字段时误触发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator } from '../../../scheduler/lib/schema.js';
import { STATUS, buildRecord } from '../lib/base.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const validator = createValidator(ROOT);

const base = {
  themeId: 'theme_001',
  productionId: 'prod_test_theme_001',
  platform: 'bilibili',
  metadata: { title: '测试标题', description: '测试描述', tags: ['AI'], thumbnail: 'data/x/cover.jpg' },
  precheck: { passed: true, checks: [{ name: 'duration', passed: true, detail: '30s' }] },
};

const cases = [
  ['published', { status: STATUS.published, publishedAt: '2024-01-15T14:35:00Z', url: 'https://www.bilibili.com/video/BV1xx411c7mD', platformVideoId: 'BV1xx411c7mD' }],
  ['submitted', { status: STATUS.submitted, platformVideoId: 'BV1xx411c7mD' }],
  ['precheck_failed', { status: STATUS.precheckFailed, precheck: { passed: false, checks: [{ name: 'tagCount', passed: false, detail: '12/10' }] }, error: { code: 'PRECHECK_FAILED', message: '预检未通过' } }],
  ['login_required', { status: STATUS.loginRequired, error: { code: 'LOGIN_TIMEOUT', message: '扫码超时' } }],
  ['manual_fallback(disabled)', { status: STATUS.manualFallback, error: { code: 'PUBLISH_DISABLED', message: '未启用真实投稿' } }],
  ['manual_fallback(selector)', { status: STATUS.manualFallback, error: { code: 'SELECTOR_NOT_FOUND', message: '找不到选择器', screenshot: 'logs/publish/x/failure.png' } }],
  ['failed', { status: STATUS.failed, error: { code: 'UPLOAD_FAILED', message: '上传失败' } }],
];

for (const [name, overrides] of cases) {
  test(`发布记录 ${name} 通过契约校验`, () => {
    const record = buildRecord({ ...base, ...overrides });
    const v = validator.validate('publish-record', record);
    assert.deepEqual(v.errors, [], v.errors.join('; '));
    assert.equal(record.status, overrides.status);
  });
}

test('STATUS 的每个键都能产出非空 status（防 manual_fallback / manualFallback 这类拼写错误）', () => {
  for (const [key, value] of Object.entries(STATUS)) {
    assert.equal(typeof value, 'string', `STATUS.${key} 必须是字符串`);
    assert.ok(value.length > 0, `STATUS.${key} 不能为空`);
  }
  assert.ok(STATUS.manualFallback, 'manual_fallback 的键名是 manualFallback');
});

test('published 缺少 url/BV 号必须被拒绝', () => {
  const record = buildRecord({ ...base, status: STATUS.published, publishedAt: '2024-01-15T14:35:00Z' });
  const v = validator.validate('publish-record', record);
  assert.equal(v.ok, false);
});

test('缺 status 必须被拒绝（if/then 不得因字段缺失而通过）', () => {
  const record = buildRecord(base);
  delete record.status;
  const v = validator.validate('publish-record', record);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /status/.test(e)), v.errors.join('; '));
});
