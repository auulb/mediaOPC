#!/usr/bin/env node
// 读 ./input.json，写 ./output.json。
// - input.failUntilAttempt = N：OPC_ATTEMPT < N 时以退出码 1 失败（不写 output），用于验证重试
// - input.businessError = true：写 error.json（不可重试业务错误）后退出 0，用于验证 error.json 优先与不重试
// - input.sleepMs：执行前等待，用于验证超时清理
import fs from 'node:fs';

const input = JSON.parse(fs.readFileSync('input.json', 'utf8'));
const attempt = Number.parseInt(process.env.OPC_ATTEMPT || '1', 10);
const failUntil = Number.isInteger(input.failUntilAttempt) ? input.failUntilAttempt : 0;
const sleepMs = Number.isInteger(input.sleepMs) && input.sleepMs > 0 ? input.sleepMs : 0;

if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));

if (input.businessError === true) {
  fs.writeFileSync('error.json', `${JSON.stringify({
    code: 'PRECHECK_FAILED',
    message: 'echo: 故意声明的业务失败',
    retryable: false,
    details: { hint: 'error.json 优先于退出码' },
  }, null, 2)}\n`);
  console.log('echo: business error');
  process.exit(0);
}

if (attempt < failUntil) {
  console.error(`echo: 故意失败 attempt=${attempt} < failUntilAttempt=${failUntil}`);
  process.exit(1);
}

const output = {
  message: String(input.message ?? ''),
  attempt,
  echoedAt: new Date().toISOString(),
};
fs.writeFileSync('output.json', `${JSON.stringify(output, null, 2)}\n`);
console.log('echo: ok');
