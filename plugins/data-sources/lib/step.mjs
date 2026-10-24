// fetch-* skill 的通用执行入口。
// 契约（A-core · step-envelope v1）：skill 把业务数据平铺写到 ./output.json；
// 可选 ./artifacts.json（数组）与 ./error.json（主动声明业务失败）。
// 本模块不写 envelope.json —— 那是调度器的职责。
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from './validate.mjs';
import { OPC_ROOT } from './base.mjs';

const RETRYABLE = new Set(['TIMEOUT', 'NETWORK_ERROR', 'API_RATE_LIMIT']);

/**
 * @param {object} opts
 * @param {import('./base.mjs').DataSourcePlugin} opts.plugin
 * @param {string} [opts.inputFile='./input.json']  不存在时按空参数处理
 * @param {string} [opts.outputFile='./output.json']
 */
export async function runFetchStep({ plugin, inputFile = './input.json', outputFile = './output.json' }) {
  const contract = path.join(OPC_ROOT, 'contracts/raw-items.schema.json');

  let params = {};
  try {
    const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
    // 兼容三种上游形态：{params}, envelope{data:{params}}, 直接传参对象
    params = input.params ?? input.data?.params ?? (input.stepId ? {} : input);
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return fail(outputFile, { code: 'INPUT_INVALID', message: 'input.params 必须是对象', retryable: false });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return fail(outputFile, { code: 'INPUT_INVALID', message: `input.json 解析失败: ${e.message}`, retryable: false });
    }
  }

  let data;
  try {
    data = await plugin.run(params);
  } catch (e) {
    const code = e.code && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : 'UNKNOWN';
    return fail(outputFile, {
      code,
      message: e.message,
      retryable: RETRYABLE.has(code),
      ...(e.details ? { details: e.details } : {}),
    });
  }

  let schema;
  try {
    schema = JSON.parse(await fs.readFile(contract, 'utf8'));
  } catch (e) {
    return fail(outputFile, { code: 'UNKNOWN', message: `读取契约失败 ${contract}: ${e.message}`, retryable: false });
  }
  const errors = validate(schema, data, contract);
  if (errors.length) {
    return fail(outputFile, {
      code: 'OUTPUT_INVALID',
      message: 'raw-items 契约校验失败',
      retryable: false,
      details: { errors: errors.slice(0, 20) },
    });
  }

  await writeJson(outputFile, data);
  await writeJson(path.join(path.dirname(outputFile), 'artifacts.json'), [
    {
      path: path.basename(outputFile),
      kind: 'json',
      contract: 'raw-items',
      description: `${data.items.length} items, cache ${data.cache.hit ? 'hit' : 'miss'}`,
    },
  ]);
  console.log(`OK ${data.items.length} items (cache ${data.cache.hit ? 'hit' : 'miss'}) -> ${outputFile}`);
}

async function fail(outputFile, error) {
  await fs.rm(outputFile, { force: true });
  await writeJson(path.join(path.dirname(outputFile), 'error.json'), error);
  console.error(`FAILED ${error.code}: ${error.message}`);
  process.exitCode = 1;
}

async function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file); // 原子写：调度器不会读到半个文件
}
