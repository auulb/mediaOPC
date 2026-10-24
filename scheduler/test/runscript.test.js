import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRunScript, renderSecretFile, shQuote } from '../lib/runscript.js';

const base = { piBin: '/usr/bin/pi', skillDir: '/tmp/skills/echo', skillName: 'echo', tools: ['read', 'write', 'bash'], env: { OPC_STEP_ID: 'echo' } };

test('run.sh 不含密钥；密钥只在 env.sh', () => {
  const secret = 'sk-do-not-leak';
  const run = renderRunScript({ ...base, env: { ...base.env, OPC_STEP_ID: secret } });
  assert.ok(run.includes(secret)); // OPC_* 不是密钥，允许出现
  const envSh = renderSecretFile({ OPENAI_API_KEY: secret });
  assert.ok(envSh.includes(secret));
  assert.ok(!renderRunScript(base).includes(secret));
});

test('单引号注入被转义，prompt 不拼进 shell 字符串', () => {
  const run = renderRunScript({ ...base, skillDir: "/tmp/a b'c", env: { OPC_STEP_ID: "x'; rm -rf / #" }, extraPrompt: "say 'hi'" });
  assert.ok(run.includes(`'\\''`), '应包含 POSIX 单引号转义序列');
  assert.ok(run.includes('env.sh'));
  assert.ok(!run.split('\n').some((line) => line.trim().startsWith('rm -rf')), '注入串不能形成独立命令');
});

test('非法 env 名 / 工具名直接报错', () => {
  assert.throws(() => renderRunScript({ ...base, env: { 'bad-name': 'x' } }), /非法环境变量名/);
  assert.throws(() => renderSecretFile({ 'bad-name': 'x' }), /非法环境变量名/);
  assert.throws(() => renderRunScript({ ...base, tools: ['read', 'bad tool'] }), /非法工具名/);
});

test('shQuote 处理空串与换行', () => {
  assert.equal(shQuote(''), "''");
  assert.equal(shQuote("a\nb"), "'a\nb'");
});
