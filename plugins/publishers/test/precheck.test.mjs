// 预检单元测试：用 ffmpeg 现场造小文件，不依赖仓库里的 data/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { precheck } from '../bilibili/precheck.mjs';
import { trimMetadata } from '../lib/base.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

function makeMedia({ seconds = 3, size = '1280x720' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-pub-'));
  const video = path.join(dir, 'final.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size}:d=${seconds}`, '-pix_fmt', 'yuv420p', video]);
  const cover = path.join(dir, 'cover.jpg');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', cover]);
  return { dir, video, cover };
}

function manifest(dir, overrides = {}) {
  return {
    schemaVersion: 1,
    productionId: 'prod_test_theme_001',
    themeId: 'theme_001',
    createdAt: '2024-01-15T14:32:10Z',
    renderer: 'remotion',
    template: 'remotion/explainer-30s',
    video: { path: path.relative(ROOT, path.join(dir, 'final.mp4')), durationSec: 3, width: 1280, height: 720, fps: 30, sizeBytes: 1000 },
    cover: { path: path.relative(ROOT, path.join(dir, 'cover.jpg')), width: 320, height: 180 },
    metadataDraft: { title: '测试标题', description: '测试描述', tags: ['AI', '动画'], category: '科技' },
    targetPlatforms: ['bilibili'],
    sourceRef: { themesFile: 'fixtures/generate-script/input.json', themeId: 'theme_001' },
    ...overrides,
  };
}

test('正常成片通过预检，且用实测参数而非 manifest', () => {
  const { dir } = makeMedia();
  const r = precheck(manifest(dir));
  assert.equal(r.passed, true, JSON.stringify(r.checks.filter((c) => !c.passed)));
  const dur = r.checks.find((c) => c.name === 'duration');
  assert.match(dur.detail, /^3(\.0+)?s/); // 实际 3s，manifest 写的也是 3
});

test('标签超过 10 个不通过', () => {
  const { dir } = makeMedia();
  const tags = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const r = precheck(manifest(dir, { metadataDraft: { title: '标题', description: '', tags } }));
  assert.equal(r.passed, false);
  assert.equal(r.checks.find((c) => c.name === 'tagCount').passed, false);
});

test('标题为空 / 过长不通过', () => {
  const { dir } = makeMedia();
  const r = precheck(manifest(dir, { metadataDraft: { title: '', description: '', tags: ['a'] } }));
  assert.equal(r.checks.find((c) => c.name === 'titleLength').passed, false);

  const long = precheck(manifest(dir, { metadataDraft: { title: '标'.repeat(81), description: '', tags: ['a'] } }));
  assert.equal(long.checks.find((c) => c.name === 'titleLength').passed, false);
});

test('命中敏感词不通过', () => {
  const { dir } = makeMedia();
  const r = precheck(manifest(dir, { metadataDraft: { title: '教你赌博', description: '', tags: ['a'] } }));
  assert.equal(r.passed, false);
  assert.match(r.checks.find((c) => c.name === 'sensitiveWords').detail, /赌博/);
});

test('视频文件缺失不通过', () => {
  const { dir } = makeMedia();
  const r = precheck(manifest(dir, { video: { path: 'data/nope.mp4', durationSec: 3, width: 1280, height: 720, fps: 30, sizeBytes: 1 } }));
  assert.equal(r.passed, false);
  assert.equal(r.checks.find((c) => c.name === 'fileSize').passed, false);
});

test('trimMetadata 去重、截断标签与描述', () => {
  const limits = { maxTags: 2, maxTagLength: 3, maxDescriptionLength: 5 };
  const m = trimMetadata({ title: 't', description: '123456789', tags: ['abcd', 'abcd', 'x'] }, limits);
  assert.deepEqual(m.tags, ['abc', 'x']);
  assert.equal(m.description, '12345');
});
