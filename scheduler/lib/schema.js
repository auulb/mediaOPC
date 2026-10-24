// JSON Schema 校验：contracts/*.schema.json 预注册，支持跨文件 $ref（按 $id）。
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export function createValidator(root) {
  // strict:false —— 契约里有 x-version 等自定义注解关键字
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const contractsDir = path.join(root, 'contracts');
  const byName = new Map(); // contract name -> ajv key
  const warnings = [];
  if (fs.existsSync(contractsDir)) {
    for (const f of fs.readdirSync(contractsDir).filter((f) => f.endsWith('.schema.json'))) {
      const name = f.replace(/\.schema\.json$/, '');
      const schema = JSON.parse(fs.readFileSync(path.join(contractsDir, f), 'utf8'));
      const key = schema.$id || `opc-contract:${name}`;
      try {
        if (schema.$id) ajv.addSchema(schema);
        else ajv.addSchema(schema, key);
        byName.set(name, key);
      } catch (e) {
        warnings.push(`跳过契约 ${f}: ${e.message}`);
      }
    }
  }

  const fileCache = new Map();
  function getFn(ref) {
    if (byName.has(ref)) return ajv.getSchema(byName.get(ref));
    const abs = path.resolve(ref);
    if (fileCache.has(abs)) return fileCache.get(abs);
    if (!fs.existsSync(abs)) throw Object.assign(new Error(`schema 不存在: ${ref}`), { code: 'SCHEMA_NOT_FOUND' });
    const schema = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const fn = (schema.$id && ajv.getSchema(schema.$id)) || ajv.compile(schema);
    fileCache.set(abs, fn);
    return fn;
  }

  return {
    warnings,
    contracts: () => [...byName.keys()],
    hasContract: (name) => byName.has(name),
    /** ref = 契约名（如 production）或 schema 文件路径 */
    validate(ref, data) {
      const fn = getFn(ref);
      if (!fn) return { ok: false, errors: [`无法加载 schema: ${ref}`] };
      const ok = fn(data);
      const errors = ok ? [] : (fn.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ''}`);
      return { ok: !!ok, errors };
    },
  };
}
