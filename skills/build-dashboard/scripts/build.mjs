#!/usr/bin/env node
// 用法: node scripts/build.mjs [--input ./input.json] [--output ./output.json]
// 读取 raw-items / token ledger / task status → 写 ./output.json（dashboard v1）
// 同时写 dashboard/{dashboard,external_trends,internal_performance,token_usage}.json
import fs from 'node:fs';
import path from 'node:path';
import { buildDashboard, writeDashboardFiles, resolveIn } from '../lib/build.mjs';
import { OPC_ROOT } from '../../../plugins/data-sources/lib/base.mjs';
import { validate } from '../../../plugins/data-sources/lib/validate.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const inputFile = path.resolve(arg('input', './input.json'));
const outputFile = path.resolve(arg('output', './output.json'));
const contractFile = path.join(OPC_ROOT, 'contracts/dashboard.schema.json');

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function fail(code, message, details) {
  fs.rmSync(outputFile, { force: true });
  writeJson(path.join(path.dirname(outputFile), 'error.json'), { code, message, retryable: false, ...(details ? { details } : {}) });
  console.error(`FAILED ${code}: ${message}`);
  process.exit(1);
}

let params = {};
try {
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  params = input.params ?? input.data?.params ?? (input.stepId ? {} : input);
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    fail('INPUT_INVALID', 'input.params 必须是对象');
  }
} catch (e) {
  if (e.code !== 'ENOENT') fail('INPUT_INVALID', `input.json 解析失败: ${e.message}`);
}

let result;
try {
  result = buildDashboard({ ...params, root: OPC_ROOT });
} catch (e) {
  fail(e.code === 'INPUT_INVALID' ? 'INPUT_INVALID' : 'UNKNOWN', e.message);
}

const errors = validate(JSON.parse(fs.readFileSync(contractFile, 'utf8')), result.dashboard, contractFile);
if (errors.length) fail('OUTPUT_INVALID', 'dashboard 契约校验失败', { errors: errors.slice(0, 20) });

writeJson(outputFile, result.dashboard);

const dashboardDir = resolveIn(OPC_ROOT, params.dashboardDir || 'dashboard');
const written = writeDashboardFiles(dashboardDir, result.dashboard, result.split);
writeJson(path.join(dashboardDir, 'dashboard.json'), result.dashboard);

const rel = (f) => path.relative(OPC_ROOT, f);
writeJson(path.join(path.dirname(outputFile), 'artifacts.json'), [
  { path: path.basename(outputFile), kind: 'json', contract: 'dashboard', description: 'dashboard v1' },
  ...written.filter((f) => path.basename(f) !== 'dashboard.json').map((f) => ({ path: rel(f), kind: 'json', description: path.basename(f) })),
  { path: rel(path.join(dashboardDir, 'dashboard.json')), kind: 'json', contract: 'dashboard', description: 'dashboard 权威副本' },
]);

console.log(
  `OK topics=${result.dashboard.externalTrends.topTopics.length} episodes=${result.dashboard.internalPerformance.episodes.length} ` +
    `tokensToday=${result.dashboard.tokenUsage.today} -> ${outputFile}`,
);
