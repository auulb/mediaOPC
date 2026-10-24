#!/usr/bin/env node
// 校验 themes v1 + 业务规则。用法:
//   node scripts/validate.mjs ./output.json [--dashboard ./input.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../../plugins/data-sources/lib/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractFile = path.join(here, '..', '..', '..', 'contracts', 'themes.schema.json');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dataFile = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : './output.json');
const dashFile = arg('dashboard', null);

const themes = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const errors = validate(JSON.parse(fs.readFileSync(contractFile, 'utf8')), themes, contractFile);

if (Array.isArray(themes.themes)) {
  const list = themes.themes;
  if (list.length !== 6) errors.push(`$.themes: 必须正好 6 条，实际 ${list.length}`);
  const ext = list.filter((t) => t.source === 'external').length;
  const int = list.filter((t) => t.source === 'internal').length;
  if (ext !== 3) errors.push(`$.themes: 外部主题必须 3 条，实际 ${ext}`);
  if (int !== 3) errors.push(`$.themes: 内部主题必须 3 条，实际 ${int}`);

  const ids = list.map((t) => t.id);
  if (new Set(ids).size !== ids.length) errors.push('$.themes: id 有重复');

  for (const [i, t] of list.entries()) {
    const at = `$.themes[${i}]`;
    if (t.title && [...t.title].length > 40) errors.push(`${at}.title: 超过 40 字`);
    if (t.brief?.durationSec != null && (t.brief.durationSec < 10 || t.brief.durationSec > 120)) {
      errors.push(`${at}.brief.durationSec: 应在 10–120 秒`);
    }
    const prefixes = t.source === 'external' ? ['/externalTrends'] : ['/internalPerformance', '/tokenUsage', '/taskStatus'];
    const refs = t.evidence || [];
    if (!refs.some((e) => prefixes.some((p) => e.pointer?.startsWith(p)))) {
      errors.push(`${at}.evidence: ${t.source} 主题至少要有一条指向 ${prefixes.join(' 或 ')} 的依据`);
    }
  }
}

// 有 dashboard 时，逐条解析 JSON Pointer，防止编造依据
if (dashFile && !errors.length) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(dashFile), 'utf8'));
  const dash = raw?.data?.externalTrends ? raw.data : raw;
  for (const [i, t] of themes.themes.entries()) {
    for (const [j, e] of t.evidence.entries()) {
      const node = pointerGet(dash, e.pointer);
      if (node === undefined) errors.push(`$.themes[${i}].evidence[${j}]: 在看板中找不到 ${e.pointer}`);
    }
  }
}

if (errors.length) {
  console.error(`校验失败 (${errors.length}):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`OK ${dataFile}: 6 themes (3 external / 3 internal)`);

function pointerGet(obj, pointer) {
  if (pointer === '' || pointer === '/') return obj;
  if (!pointer.startsWith('/')) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, key) => (node == null ? undefined : node[key]), obj);
}
