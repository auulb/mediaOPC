#!/usr/bin/env node
// 校验 output.json 是否符合 raw-items v1。用法: node scripts/validate.mjs ./output.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../../plugins/data-sources/lib/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractFile = path.join(here, '..', '..', '..', 'contracts', 'raw-items.schema.json');
const dataFile = path.resolve(process.argv[2] || './output.json');

const errors = validate(JSON.parse(fs.readFileSync(contractFile, 'utf8')), JSON.parse(fs.readFileSync(dataFile, 'utf8')), contractFile);
if (errors.length) {
  console.error(`校验失败 (${errors.length}):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`OK ${dataFile}`);
