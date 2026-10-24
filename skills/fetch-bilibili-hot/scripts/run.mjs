#!/usr/bin/env node
// 用法: node scripts/run.mjs [--input ./input.json] [--output ./output.json]
import path from 'node:path';
import { runFetchStep } from '../../../plugins/data-sources/lib/step.mjs';
import { BilibiliHotPlugin } from '../../../plugins/data-sources/bilibili-hot.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

await runFetchStep({
  plugin: new BilibiliHotPlugin(),
  inputFile: path.resolve(arg('input', './input.json')),
  outputFile: path.resolve(arg('output', './output.json')),
});
