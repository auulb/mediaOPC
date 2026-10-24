#!/usr/bin/env node
// 发布前预检（C-media）：只读文件与 metadata，不联网、不启动浏览器。
// 用法：node precheck.mjs --input <production.json> [--platform bilibili]
// 输出：stdout JSON { passed, checks }；退出码 0=通过 2=不通过 1=输入错误
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OPC_ROOT, check, readSensitiveWords, trimMetadata } from '../lib/base.mjs';

const PLATFORM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BILIBILI = JSON.parse(fs.readFileSync(path.join(PLATFORM_DIR, 'bilibili/platform.json'), 'utf8'));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

function probe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration,size',
    '-of', 'json', file,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out.toString());
  return {
    durationSec: Number(j.format.duration),
    sizeBytes: Number(j.format.size),
    width: j.streams[0].width,
    height: j.streams[0].height,
  };
}

export function precheck(production, { root = OPC_ROOT, limits = BILIBILI.limits } = {}) {
  const checks = [];
  const raw = { ...production.metadataDraft, thumbnail: production.metadataDraft.thumbnail || production.cover?.path };
  // 用原始值判定（裁剪后再判定就永远查不出超限），用裁剪值提交
  const meta = trimMetadata(raw, limits);
  const rawTags = [...new Set(raw.tags || [])];
  const videoFile = path.resolve(root, production.video.path);

  // 1. 文件存在 + 实测参数（不信 manifest，防上游篡改/文件被替换）
  let actual = null;
  if (fs.existsSync(videoFile)) {
    try {
      actual = probe(videoFile);
    } catch {
      checks.push(check('fileSize', false, 'ffprobe 读取失败'));
    }
  } else {
    checks.push(check('fileSize', false, `文件不存在: ${production.video.path}`));
  }
  const m = actual || production.video;

  checks.push(check('duration', m.durationSec > 0 && m.durationSec <= limits.maxDurationSec, `${m.durationSec}s / 上限 ${limits.maxDurationSec}s`));
  checks.push(check('fileSize', (m.sizeBytes ?? 0) > 0 && m.sizeBytes <= limits.maxFileSizeBytes, `${((m.sizeBytes ?? 0) / 1048576).toFixed(1)}MB / 上限 ${(limits.maxFileSizeBytes / 1048576).toFixed(0)}MB`));
  checks.push(check('resolution', (m.width ?? 0) >= limits.minWidth && (m.height ?? 0) >= limits.minHeight, `${m.width}x${m.height}`));

  // 2. 标题 / 标签
  checks.push(check('titleLength', raw.title.length > 0 && raw.title.length <= limits.maxTitleLength, `${raw.title.length}/${limits.maxTitleLength}`));
  checks.push(check('tagCount', rawTags.length >= 1 && rawTags.length <= limits.maxTags, `${rawTags.length}/${limits.maxTags}`));

  // 3. 敏感词（标题+描述+标签）
  const words = readSensitiveWords(path.join(PLATFORM_DIR, 'bilibili/sensitive-words.txt'));
  const haystack = [raw.title, raw.description, ...(raw.tags || [])].join('\n');
  const hits = words.filter((w) => haystack.includes(w));
  checks.push(check('sensitiveWords', hits.length === 0, hits.length ? `命中: ${hits.join(', ')}` : '未命中'));

  // 4. 封面
  const coverFile = path.resolve(root, raw.thumbnail || '');
  checks.push(check('coverExists', Boolean(raw.thumbnail) && fs.existsSync(coverFile), raw.thumbnail || '未提供封面'));

  return { passed: checks.every((c) => c.passed), checks, metadata: meta };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const production = JSON.parse(fs.readFileSync(path.resolve(args.input || './input.json'), 'utf8'));
    const platform = args.platform || 'bilibili';
    if (platform !== 'bilibili') throw new Error(`暂不支持的平台: ${platform}`);
    const r = precheck(production);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return r.passed ? 0 : 2;
  } catch (e) {
    process.stderr.write(`[precheck] ${e.message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
