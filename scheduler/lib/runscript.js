// 生成每个 attempt 的 run.sh / env.sh。所有动态值都经 shQuote，终端与 AppleScript 只接触脚本路径。
// 敏感值（API Key 等）只写进 env.sh（0600），不写进 run.sh、日志或 envelope。

/** POSIX 单引号转义 */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
export const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function assertEnv(env) {
  for (const k of Object.keys(env)) {
    if (!ENV_NAME.test(k)) throw new Error(`非法环境变量名: ${k}`);
  }
}

/** 生成 env.sh 内容（只含密钥类变量，由调用方以 0600 写入） */
export function renderSecretFile(secretEnv = {}) {
  assertEnv(secretEnv);
  const lines = ['#!/usr/bin/env bash', '# 由 OPC 调度器生成，含密钥，权限 0600，勿提交、勿打印'];
  for (const [k, v] of Object.entries(secretEnv)) lines.push(`export ${k}=${shQuote(v)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * @param {object} p
 * @param {string} p.piBin       pi 可执行文件（测试时可换成假 pi）
 * @param {string} p.skillDir    skill 目录绝对路径
 * @param {string} p.skillName
 * @param {string[]} p.tools
 * @param {Record<string,string>} p.env  非敏感环境变量（OPC_*）
 * @param {string} [p.extraPrompt]
 */
export function renderRunScript({ piBin, skillDir, skillName, tools, env, extraPrompt }) {
  assertEnv(env);
  const toolList = tools || ['read', 'write', 'bash'];
  for (const t of toolList) {
    if (!TOOL_NAME.test(t)) throw new Error(`非法工具名: ${t}`);
  }
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)}`);
  const prompt = `/skill:${skillName} 读取 ./input.json，按 skill 要求把结果写到 ./output.json，完成后退出。${extraPrompt ? ` ${extraPrompt}` : ''}`;
  return [
    '#!/usr/bin/env bash',
    '# 由 OPC 调度器生成，请勿手改。重跑：bash run.sh',
    'set -uo pipefail',
    'cd "$(dirname "$0")"',
    'echo $$ > run.pid',
    '# 敏感变量单独存放（0600），不出现在本文件',
    'if [ -f env.sh ]; then',
    '  set -a',
    '  . ./env.sh',
    '  set +a',
    'fi',
    ...exports,
    `${shQuote(piBin)} -p --mode json --no-session \\`,
    `  -ns --skill ${shQuote(skillDir)} \\`,
    `  --tools ${shQuote(toolList.join(','))} \\`,
    `  ${shQuote(prompt)} \\`,
    '  > events.jsonl 2> stderr.log < /dev/null',
    'code=$?',
    // 原子写：调度器看到 exit_code 时内容一定完整
    'echo "$code" > exit_code.tmp && mv exit_code.tmp exit_code',
    'exit "$code"',
    '',
  ].join('\n');
}
