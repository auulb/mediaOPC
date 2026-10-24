#!/usr/bin/env node
// 零依赖 JSON Schema 子集校验器（draft 2020-12 子集）
// 支持：type, required, properties, additionalProperties(bool|schema), items,
//       enum, const, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
//       minLength, maxLength, minItems, maxItems, uniqueItems, pattern,
//       allOf, anyOf, oneOf, not, if/then/else,
//       format(date-time|date|uri), $ref(本文件 #/$defs/... 或相对文件路径)
// CLI: node validate.mjs <schema.json> <data.json>   退出码 0=通过 1=不通过 2=用法/读取错误
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMATS = {
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  uri: (v) => /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v),
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(expected, v) {
  const t = typeOf(v);
  if (expected === 'number') return t === 'number' || t === 'integer';
  return expected === t;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 校验 data 是否符合 schema。
 * @param {object} schema 根 schema
 * @param {any} data 待校验数据
 * @param {string} [schemaFile] schema 文件路径，用于解析相对 $ref
 * @returns {string[]} 错误列表，空数组表示通过
 */
export function validate(schema, data, schemaFile) {
  const errors = [];
  const baseDir = schemaFile ? path.dirname(path.resolve(schemaFile)) : process.cwd();
  const fileCache = new Map();

  function resolveRef(ref, root, rootDir) {
    const [filePart, pointer = ''] = ref.split('#');
    let doc = root;
    let dir = rootDir;
    if (filePart) {
      const abs = path.resolve(rootDir, filePart);
      if (!fileCache.has(abs)) fileCache.set(abs, loadJson(abs));
      doc = fileCache.get(abs);
      dir = path.dirname(abs);
    }
    let node = doc;
    for (const seg of pointer.split('/').filter(Boolean)) {
      node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (node === undefined) throw new Error(`无法解析 $ref: ${ref}`);
    return { node, root: doc, dir };
  }

  // 子 schema 试校验：不污染主错误列表
  function passes(s, v, at, root, dir) {
    const saved = errors.length;
    walk(s, v, at, root, dir);
    const ok = errors.length === saved;
    errors.length = saved;
    return ok;
  }

  function walk(s, v, at, root, dir) {
    if (s === true || s === undefined) return;
    if (s === false) { errors.push(`${at}: 不允许出现`); return; }
    for (const sub of s.allOf || []) walk(sub, v, at, root, dir);
    if (s.anyOf && !s.anyOf.some((sub) => passes(sub, v, at, root, dir))) errors.push(`${at}: 不满足 anyOf 任一分支`);
    if (s.oneOf) {
      const n = s.oneOf.filter((sub) => passes(sub, v, at, root, dir)).length;
      if (n !== 1) errors.push(`${at}: oneOf 应恰好命中 1 个分支，实际 ${n}`);
    }
    if (s.not && passes(s.not, v, at, root, dir)) errors.push(`${at}: 不应满足 not 分支`);
    if (s.if) {
      if (passes(s.if, v, at, root, dir)) { if (s.then) walk(s.then, v, at, root, dir); }
      else if (s.else) walk(s.else, v, at, root, dir);
    }
    if (s.$ref) {
      const r = resolveRef(s.$ref, root, dir);
      walk(r.node, v, at, r.root, r.dir);
    }
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeMatches(t, v))) {
        errors.push(`${at}: 类型应为 ${types.join('|')}，实际 ${typeOf(v)}`);
        return;
      }
    }
    if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) errors.push(`${at}: 应等于 ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${at}: 取值应为 ${JSON.stringify(s.enum)} 之一`);

    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${at}: 应 >= ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${at}: 应 <= ${s.maximum}`);
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) errors.push(`${at}: 应 > ${s.exclusiveMinimum}`);
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) errors.push(`${at}: 应 < ${s.exclusiveMaximum}`);
    }
    if (typeof v === 'string') {
      const len = [...v].length; // 按码点计长度，中文/emoji 不被算成 2
      if (s.minLength !== undefined && len < s.minLength) errors.push(`${at}: 长度应 >= ${s.minLength}`);
      if (s.maxLength !== undefined && len > s.maxLength) errors.push(`${at}: 长度应 <= ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${at}: 不匹配 ${s.pattern}`);
      if (s.format && FORMATS[s.format] && !FORMATS[s.format](v)) errors.push(`${at}: 不是合法的 ${s.format}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${at}: 元素数应 >= ${s.minItems}`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${at}: 元素数应 <= ${s.maxItems}`);
      if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push(`${at}: 元素不可重复`);
      if (s.items) v.forEach((item, i) => walk(s.items, item, `${at}[${i}]`, root, dir));
    }
    if (typeOf(v) === 'object') {
      for (const key of s.required || []) {
        if (!(key in v)) errors.push(`${at}: 缺少必填字段 ${key}`);
      }
      const props = s.properties || {};
      for (const [key, val] of Object.entries(v)) {
        if (key in props) walk(props[key], val, `${at}.${key}`, root, dir);
        else if (s.additionalProperties === false) errors.push(`${at}: 不允许的字段 ${key}`);
        else if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, val, `${at}.${key}`, root, dir);
      }
    }
  }

  walk(schema, data, '$', schema, baseDir);
  return errors;
}

/** 读取文件并校验，返回错误列表 */
export function validateFile(schemaFile, dataFile) {
  return validate(loadJson(schemaFile), loadJson(dataFile), schemaFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [schemaFile, dataFile] = process.argv.slice(2);
  if (!schemaFile || !dataFile) {
    console.error('用法: node validate.mjs <schema.json> <data.json>');
    process.exit(2);
  }
  let errors;
  try {
    errors = validateFile(schemaFile, dataFile);
  } catch (e) {
    console.error(`读取失败: ${e.message}`);
    process.exit(2);
  }
  if (errors.length) {
    console.error(`校验失败 (${errors.length}):\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`OK ${dataFile}`);
}
