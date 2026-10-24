// fixtures/ 校验：按目录名映射契约（render-* → production，publish-* → publish-record ...），
// 目录内可放 contract.json 显式覆盖：{"contract":"production"} 或 {"schema":"skills/echo/schemas/output.schema.json"}。
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = [
  ['render-', 'production'],
  ['publish-', 'publish-record'],
  ['fetch-', 'raw-items'],
  ['recommend-themes', 'themes'],
  ['build-dashboard', 'dashboard'],
  ['internal-metrics', 'raw-items'],
  ['competitor', 'raw-items'],
  ['themes', 'themes'],
  ['dashboard', 'dashboard'],
  ['raw-items', 'raw-items'],
  ['production', 'production'],
  ['publish-record', 'publish-record'],
  ['step-envelope', 'step-envelope'],
  ['token-ledger', 'token-ledger'],
];

export function defaultContractFor(dirName) {
  if (dirName === 'echo') return { schema: 'skills/echo/schemas/output.schema.json' };
  if (dirName === 'generate-script') return { schema: 'skills/generate-script/schemas/output.schema.json' };
  for (const [prefix, contract] of PREFIX) {
    if (dirName === prefix || dirName.startsWith(prefix)) return { contract };
  }
  return null;
}

function readContractOverride(dir) {
  const file = path.join(dir, 'contract.json');
  if (!fs.existsSync(file)) return null;
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (v.contract && v.schema) throw new Error(`${file}: contract 与 schema 只能二选一`);
  if (!v.contract && !v.schema) throw new Error(`${file}: 需要 contract 或 schema 字段`);
  return v;
}

/** 递归收集一个 fixture 目录下需要校验的 json 文件 */
function collectJson(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJson(p, out);
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    if (entry.name === 'contract.json') continue;
    // 只校验步骤输出样例；input.* / draft.json / storyboard.json 等是输入或中间产物。
    if (!entry.name.startsWith('output')) continue;
    out.push(p);
  }
  return out;
}

/**
 * @param {string} root 仓库根
 * @param {{validate:(ref:string,data:any)=>{ok:boolean,errors:string[]}}} validator
 * @returns {{checked:number, skipped:number, results:Array, failures:Array}}
 */
export function validateFixtures(root, validator) {
  const fixturesDir = path.join(root, 'fixtures');
  const results = [];
  const failures = [];
  let skipped = 0;
  if (!fs.existsSync(fixturesDir)) return { checked: 0, skipped: 0, results, failures };

  for (const entry of fs.readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(fixturesDir, entry.name);
    let target;
    try {
      target = readContractOverride(dir) || defaultContractFor(entry.name);
    } catch (e) {
      failures.push({ file: dir, ref: null, errors: [e.message] });
      continue;
    }
    const files = collectJson(dir, []);
    if (!files.length) { skipped++; continue; } // 只有输入/中间产物，没有输出样例
    if (!target) {
      failures.push({ file: dir, ref: null, errors: ['无法确定契约：目录名不在默认映射中，请添加 contract.json'] });
      continue;
    }
    const ref = target.contract || target.schema;
    for (const file of files) {
      const rel = path.relative(root, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        failures.push({ file: rel, ref, errors: [`JSON 解析失败: ${e.message}`] });
        results.push({ file: rel, ref, ok: false });
        continue;
      }
      const v = validator.validate(ref, data);
      results.push({ file: rel, ref, ok: v.ok });
      if (!v.ok) failures.push({ file: rel, ref, errors: v.errors });
    }
  }
  return { checked: results.length, skipped, results, failures };
}
