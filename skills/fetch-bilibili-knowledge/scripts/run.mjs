#!/usr/bin/env node
// 用法: node scripts/run.mjs [--input ./input.json] [--output ./output.json]
// 确定性采集：不经过 pi / 大模型。Cookie 只在手动配置后从 data/secrets 读取。
import path from 'node:path';
import { runFetchStep } from '../../../plugins/data-sources/lib/step.mjs';
import { BilibiliKnowledgePlugin } from '../../../plugins/data-sources/bilibili-knowledge.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

await runFetchStep({
  plugin: new BilibiliKnowledgePlugin(),
  inputFile: path.resolve(arg('input', './input.json')),
  outputFile: path.resolve(arg('output', './output.json')),
});
