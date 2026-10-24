// 单步隔离执行器：attempt-n 目录 + run.sh + 新终端 + 退出码/schema 双判定 + 指数退避重试。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renderRunScript, renderSecretFile, ENV_NAME } from './runscript.js';
import { launch, killRun } from './terminal.js';
import { sumUsageFile } from './usage.js';
import { createValidator } from './schema.js';

/** 调度器保留错误码；缺省可重试（pi 跑偏 / 网络抖动都值得再来一次） */
export const RESERVED_CODES = ['TIMEOUT', 'NETWORK_ERROR', 'API_RATE_LIMIT', 'OUTPUT_MISSING', 'OUTPUT_INVALID', 'NONZERO_EXIT', 'LAUNCH_FAILED'];

export const DEFAULT_RETRY = { maxAttempts: 3, baseDelayMs: 1000 }; // 1s, 2s, 4s
/** 单步 token 告警阈值（不熔断；C 曾出现单步 50 万 token 的跑偏） */
export const DEFAULT_STEP_TOKEN_WARN = 100_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const RUN_FILES = ['exit_code', 'exit_code.tmp', 'output.json', 'error.json', 'artifacts.json', 'envelope.json', 'events.jsonl', 'stderr.log', 'run.pid'];

export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 允许 --pi-bin 用相对路径（如 scheduler/test/fixtures/fake-pi）；命令名（pi）原样保留 */
function resolvePiBin(v) {
  if (!v || typeof v !== 'string') return v;
  if (!v.includes('/') && !v.includes(path.sep)) return v;
  if (path.isAbsolute(v)) return v;
  const abs = path.resolve(v);
  return fs.existsSync(abs) ? abs : v;
}

function readJsonSafe(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, error: e }; }
}

/** 轮询等待 exit_code，超时返回 null */
async function waitForExitCode(dir, timeoutMs, pollMs) {
  const file = path.join(dir, 'exit_code');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      return Number.isInteger(n) ? n : -1;
    }
    await sleep(pollMs);
  }
  return null;
}

export function isRetryable(error) {
  if (!error) return false;
  if (typeof error.retryable === 'boolean') return error.retryable;
  return RESERVED_CODES.includes(error.code);
}

export class StepExecutor {
  /**
   * @param {object} o
   * @param {string} o.root             仓库根
   * @param {string} [o.piBin]          默认 OPC_PI_BIN 或 pi
   * @param {string} [o.launcher]       terminal|tmux|spawn|auto
   * @param {object} [o.retry]          { maxAttempts, baseDelayMs }
   * @param {number} [o.pollMs]
   * @param {(rec:object)=>void} [o.onLog]
   */
  constructor({ root, piBin, launcher, retry, pollMs = 200, onLog } = {}) {
    this.root = path.resolve(root);
    this.piBin = resolvePiBin(piBin || process.env.OPC_PI_BIN || 'pi');
    this.launcher = launcher;
    this.retry = { ...DEFAULT_RETRY, ...retry };
    this.pollMs = pollMs;
    this.onLog = onLog;
    this.validator = createValidator(this.root);
  }

  log(level, ctx, message, metadata) {
    const rec = { timestamp: new Date().toISOString(), level, pipelineId: ctx.pipelineId, runId: ctx.runId, stepId: ctx.stepId, message, ...(metadata ? { metadata } : {}) };
    const dir = path.join(this.root, 'logs', ctx.runId, ctx.stepId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'step.log.jsonl'), `${JSON.stringify(rec)}\n`);
    this.onLog?.(rec);
  }

  /** 输出校验所用 schema：step.contract 优先，其次 skill 自带 schemas/output.schema.json */
  resolveOutputSchema(step) {
    if (step.contract) {
      if (!this.validator.hasContract(step.contract)) throw new Error(`契约不存在: contracts/${step.contract}.schema.json`);
      return { ref: step.contract, contract: step.contract };
    }
    const own = path.join(this.root, 'skills', step.skill, 'schemas', 'output.schema.json');
    if (fs.existsSync(own)) return { ref: own, contract: null };
    throw new Error(`step ${step.id} 未声明 contract，且 skills/${step.skill}/schemas/output.schema.json 不存在`);
  }

  validateStep(step) {
    for (const k of ['id', 'skill']) {
      if (!ID.test(step[k] || '')) throw new Error(`step.${k} 非法: ${step[k]}`);
    }
    const skillDir = path.join(this.root, 'skills', step.skill);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) throw new Error(`skill 不存在: ${skillDir}/SKILL.md`);
    return skillDir;
  }

  /**
   * 跑一次 attempt。业务失败返回 failed envelope；配置错误（skill 不存在等）抛异常。
   */
  async runAttempt(step, ctx, inputFile, attempt) {
    if (!ID.test(ctx.runId || '')) throw new Error(`runId 非法: ${ctx.runId}`);
    if (!ID.test(ctx.pipelineId || '')) throw new Error(`pipelineId 非法: ${ctx.pipelineId}`);
    const skillDir = this.validateStep(step);
    const schema = this.resolveOutputSchema(step);
    const dir = path.join(this.root, 'workspace', ctx.runId, step.id, `attempt-${attempt}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* 非 POSIX 忽略 */ }
    const lctx = { ...ctx, stepId: step.id };
    const startedAt = new Date();

    if (!inputFile || !fs.existsSync(inputFile)) {
      throw new Error(`input.json 不存在: ${inputFile ?? '(未提供)'}`);
    }
    fs.copyFileSync(inputFile, path.join(dir, 'input.json'));

    // 同目录重跑时清掉上一次的运行产物，避免读到旧 exit_code / output.json。
    for (const f of RUN_FILES) fs.rmSync(path.join(dir, f), { force: true });

    const env = {
      OPC_ROOT: this.root,
      OPC_RUN_ID: ctx.runId,
      OPC_PIPELINE_ID: ctx.pipelineId,
      OPC_STEP_ID: step.id,
      OPC_ATTEMPT: String(attempt),
    };
    // 按步注入的密钥：配置里只写变量名，值从调度器 env 取，写进 env.sh（0600），不落 run.sh / 日志
    const secretEnv = {};
    const missingEnv = [];
    for (const name of step.env || []) {
      if (!ENV_NAME.test(name)) throw new Error(`step.env 非法变量名: ${name}`);
      if (process.env[name] !== undefined) secretEnv[name] = process.env[name];
      else missingEnv.push(name);
    }
    const envFile = path.join(dir, 'env.sh');
    if (Object.keys(secretEnv).length) {
      fs.writeFileSync(envFile, renderSecretFile(secretEnv), { mode: 0o600 });
      try { fs.chmodSync(envFile, 0o600); } catch { /* ignore */ }
    } else {
      fs.rmSync(envFile, { force: true });
    }
    if (missingEnv.length) this.log('WARN', lctx, `缺少按步环境变量: ${missingEnv.join(',')}`);

    const runSh = path.join(dir, 'run.sh');
    fs.writeFileSync(runSh, renderRunScript({
      piBin: this.piBin,
      skillDir,
      skillName: step.skill,
      tools: step.tools || ['read', 'write', 'bash'],
      env,
      extraPrompt: step.prompt,
    }), { mode: 0o700 });
    try { fs.chmodSync(runSh, 0o700); } catch { /* ignore */ }

    this.log('INFO', lctx, `attempt ${attempt} started`, { dir, launcher: this.launcher || 'auto' });

    let exitCode = null;
    let error = null;
    let launcherMode = null;
    try {
      launcherMode = await launch(runSh, { launcher: this.launcher, title: `${ctx.runId}/${step.id}#${attempt}` });
      exitCode = await waitForExitCode(dir, (step.timeout ?? 600) * 1000, this.pollMs);
      if (exitCode === null) {
        const pid = Number.parseInt(fs.existsSync(path.join(dir, 'run.pid')) ? fs.readFileSync(path.join(dir, 'run.pid'), 'utf8') : '', 10);
        killRun(pid);
        error = { code: 'TIMEOUT', message: `超过 ${step.timeout ?? 600}s 未结束（launcher=${launcherMode}）` };
      }
    } catch (e) {
      error = { code: e.code && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : 'LAUNCH_FAILED', message: e.message, ...(typeof e.retryable === 'boolean' ? { retryable: e.retryable } : {}) };
    }

    // 判定顺序：skill 主动声明的 error.json > 退出码 > output 缺失 > schema 不通过
    const outFile = path.join(dir, 'output.json');
    const errFile = path.join(dir, 'error.json');
    if (!error && fs.existsSync(errFile)) {
      const r = readJsonSafe(errFile);
      const e = r.ok ? r.value : null;
      error = e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(e.code)
        ? { code: e.code, message: String(e.message ?? ''), ...(typeof e.retryable === 'boolean' ? { retryable: e.retryable } : {}), ...(e.details && typeof e.details === 'object' ? { details: e.details } : {}) }
        : { code: 'OUTPUT_INVALID', message: 'error.json 格式不合法' };
    }
    if (!error && exitCode !== 0) error = { code: 'NONZERO_EXIT', message: `pi 退出码 ${exitCode}，见 stderr.log` };
    if (!error && !fs.existsSync(outFile)) error = { code: 'OUTPUT_MISSING', message: 'output.json 不存在' };
    if (!error) {
      const r = readJsonSafe(outFile);
      if (!r.ok) error = { code: 'OUTPUT_INVALID', message: `output.json 不是合法 JSON: ${r.error.message}` };
      else {
        const v = this.validator.validate(schema.ref, r.value);
        if (!v.ok) error = { code: 'OUTPUT_INVALID', message: `output.json 未通过 ${schema.contract || 'skill output schema'} 校验`, details: { errors: v.errors.slice(0, 20) } };
      }
    }

    let artifacts = [];
    const artFile = path.join(dir, 'artifacts.json');
    if (fs.existsSync(artFile)) {
      const r = readJsonSafe(artFile);
      if (r.ok && Array.isArray(r.value)) {
        artifacts = r.value.filter((a) => a && typeof a.path === 'string' && a.path && typeof a.kind === 'string' && a.kind)
          .map(({ path: p, kind, contract, description }) => ({ path: p, kind, ...(contract ? { contract } : {}), ...(description ? { description } : {}) }));
      }
    }

    const finishedAt = new Date();
    const usage = sumUsageFile(path.join(dir, 'events.jsonl'));
    const envelope = {
      schemaVersion: 1,
      status: error ? 'failed' : 'success',
      runId: ctx.runId,
      pipelineId: ctx.pipelineId,
      stepId: step.id,
      skill: step.skill,
      attempt,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode,
      output: fs.existsSync(outFile) ? { path: outFile, contract: schema.contract } : null,
      artifacts,
      usage: { totalTokens: usage.totalTokens, costUsd: usage.costUsd },
      error,
    };
    const envCheck = this.validator.hasContract('step-envelope') ? this.validator.validate('step-envelope', envelope) : { ok: true, errors: [] };
    if (!envCheck.ok) this.log('ERROR', lctx, 'envelope 未通过 step-envelope 校验', { errors: envCheck.errors.slice(0, 10) });
    fs.writeFileSync(path.join(dir, 'envelope.json'), `${JSON.stringify(envelope, null, 2)}\n`);

    this.appendLedger({
      schemaVersion: 1,
      ts: envelope.finishedAt,
      runId: ctx.runId,
      pipelineId: ctx.pipelineId,
      stepId: step.id,
      skill: step.skill,
      attempt,
      outcome: envelope.status,
      provider: usage.provider,
      model: usage.model,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
      costUsd: usage.costUsd,
      durationMs: finishedAt - startedAt,
      messages: usage.messages,
    });

    const tokenWarn = Number.isFinite(step.tokenWarn) ? step.tokenWarn : DEFAULT_STEP_TOKEN_WARN;
    if (usage.totalTokens > tokenWarn) {
      this.log('WARN', lctx, `attempt ${attempt} token 超阈值（仅告警，不熔断）`, { tokens: usage.totalTokens, threshold: tokenWarn });
    }
    if (error) this.log('WARN', lctx, `attempt ${attempt} failed: ${error.code}`, { message: error.message, exitCode, retryable: isRetryable(error) });
    else this.log('INFO', lctx, `attempt ${attempt} succeeded`, { duration: (finishedAt - startedAt) / 1000, tokensUsed: usage.totalTokens });
    return envelope;
  }

  appendLedger(entry) {
    const v = this.validator.hasContract('token-ledger') ? this.validator.validate('token-ledger', entry) : { ok: true, errors: [] };
    if (!v.ok) throw new Error(`ledger 条目不符合契约: ${v.errors.join('; ')}`);
    const file = path.join(this.root, 'data', 'token_ledger.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }

  /**
   * 带重试执行一步。返回最后一次 attempt 的 envelope（success 或 failed）。
   */
  async executeWithRetry(step, ctx, inputFile) {
    const maxAttempts = step.retry?.maxAttempts ?? this.retry.maxAttempts;
    const baseDelayMs = step.retry?.baseDelayMs ?? this.retry.baseDelayMs;
    let env;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      env = await this.runAttempt(step, ctx, inputFile, attempt);
      if (env.status === 'success') return env;
      if (!isRetryable(env.error)) {
        this.log('ERROR', { ...ctx, stepId: step.id }, `不可重试错误 ${env.error.code}，停止`);
        return env;
      }
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        this.log('WARN', { ...ctx, stepId: step.id }, `将在 ${delay}ms 后重试`, { nextAttempt: attempt + 1 });
        await sleep(delay);
      }
    }
    this.log('ERROR', { ...ctx, stepId: step.id }, `重试 ${maxAttempts} 次后仍失败`);
    return env;
  }
}
