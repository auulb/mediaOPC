// pipeline.yaml 解析 + depends_on DAG + output→input 拷贝 + task_status（M2）。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { StepExecutor, newRunId } from './executor.js';
import { TaskStatusStore, taskPatchFromEnvelope } from './taskstatus.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export function loadPipelineConfig(root, file = 'config/pipeline.yaml') {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(abs)) throw new Error(`pipeline 配置不存在: ${abs}`);
  const doc = YAML.parse(fs.readFileSync(abs, 'utf8'));
  if (!doc || typeof doc !== 'object' || !doc.pipelines || typeof doc.pipelines !== 'object') {
    throw new Error(`${file}: 缺少 pipelines`);
  }
  return doc;
}

export function normalizePipeline(pipelineId, raw) {
  if (!ID.test(pipelineId || '')) throw new Error(`pipelineId 非法: ${pipelineId}`);
  if (!raw || typeof raw !== 'object') throw new Error(`pipeline ${pipelineId} 配置非法`);
  const rawSteps = asArray(raw.steps);
  if (!rawSteps.length) throw new Error(`pipeline ${pipelineId} 没有 steps`);
  const steps = rawSteps.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`pipeline ${pipelineId} 第 ${i + 1} 个 step 非法`);
    if (!ID.test(s.id || '')) throw new Error(`pipeline ${pipelineId} step.id 非法: ${s.id}`);
    if (!ID.test(s.skill || '')) throw new Error(`pipeline ${pipelineId}/${s.id} skill 非法: ${s.skill}`);
    const depends_on = asArray(s.depends_on ?? s.dependsOn);
    if (depends_on.some((d) => typeof d !== 'string')) throw new Error(`pipeline ${pipelineId}/${s.id} depends_on 必须是字符串数组`);
    if (s.input !== undefined && typeof s.input !== 'string') throw new Error(`pipeline ${pipelineId}/${s.id} input 必须是路径字符串`);
    if (s.timeout !== undefined && !(Number.isFinite(Number(s.timeout)) && Number(s.timeout) > 0)) {
      throw new Error(`pipeline ${pipelineId}/${s.id} timeout 必须是正数`);
    }
    if (s.env !== undefined && (!Array.isArray(s.env) || s.env.some((e) => !ENV_NAME.test(e)))) {
      throw new Error(`pipeline ${pipelineId}/${s.id} env 必须是合法环境变量名数组`);
    }
    if (s.tools !== undefined && (!Array.isArray(s.tools) || s.tools.length === 0)) {
      throw new Error(`pipeline ${pipelineId}/${s.id} tools 必须是非空数组`);
    }
    if (s.retry !== undefined) {
      const r = s.retry;
      if (!r || typeof r !== 'object') throw new Error(`pipeline ${pipelineId}/${s.id} retry 必须是对象`);
      if (r.maxAttempts !== undefined && (!Number.isInteger(Number(r.maxAttempts)) || Number(r.maxAttempts) < 1)) {
        throw new Error(`pipeline ${pipelineId}/${s.id} retry.maxAttempts 必须是 >=1 整数`);
      }
      if (r.baseDelayMs !== undefined && (!Number.isFinite(Number(r.baseDelayMs)) || Number(r.baseDelayMs) < 0)) {
        throw new Error(`pipeline ${pipelineId}/${s.id} retry.baseDelayMs 必须 >=0`);
      }
    }
    return {
      ...s,
      id: s.id,
      skill: s.skill,
      depends_on,
      ...(s.timeout !== undefined ? { timeout: Number(s.timeout) } : {}),
      ...(s.retry ? { retry: {
        ...(s.retry.maxAttempts !== undefined ? { maxAttempts: Number(s.retry.maxAttempts) } : {}),
        ...(s.retry.baseDelayMs !== undefined ? { baseDelayMs: Number(s.retry.baseDelayMs) } : {}),
      } } : {}),
      ...(s.continue_on_error !== undefined ? { continue_on_error: !!s.continue_on_error } : {}),
    };
  });
  const ids = new Set();
  for (const s of steps) {
    if (ids.has(s.id)) throw new Error(`pipeline ${pipelineId} step.id 重复: ${s.id}`);
    ids.add(s.id);
  }
  for (const s of steps) {
    for (const d of s.depends_on) {
      if (d === s.id) throw new Error(`pipeline ${pipelineId}/${s.id} 不能依赖自己`);
      if (!ids.has(d)) throw new Error(`pipeline ${pipelineId}/${s.id} 依赖不存在: ${d}`);
    }
  }
  return steps;
}

/** Kahn 拓扑排序，保持配置里的书写顺序作为同层顺序 */
export function topoSort(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indeg = new Map(steps.map((s) => [s.id, 0]));
  const children = new Map(steps.map((s) => [s.id, []]));
  for (const s of steps) {
    for (const d of s.depends_on) {
      indeg.set(s.id, indeg.get(s.id) + 1);
      children.get(d).push(s.id);
    }
  }
  const order = [];
  const queue = steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const c of children.get(id)) {
      indeg.set(c, indeg.get(c) - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  if (order.length !== steps.length) {
    const cycle = steps.filter((s) => indeg.get(s.id) > 0).map((s) => s.id);
    const err = new Error(`pipeline 存在环: ${cycle.join(' -> ')}`);
    err.code = 'PIPELINE_CYCLE';
    throw err;
  }
  return order;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const OUTPUT_PLACEHOLDER = /\{\{steps\.([A-Za-z0-9_.-]+)\.output\}\}/g;

function prepareInput({ root, runId, step, results }) {
  const inputDir = path.join(root, 'workspace', runId, '_inputs');
  if (step.input) {
    const abs = path.resolve(root, step.input);
    if (!fs.existsSync(abs)) throw Object.assign(new Error(`step ${step.id} 的 input 不存在: ${step.input}`), { code: 'INPUT_MISSING' });
    const raw = fs.readFileSync(abs, 'utf8');
    if (!raw.includes('{{steps.')) return abs;
    // 模板：把 {{steps.<id>.output}} 换成依赖的真实 output 路径，方便 build-dashboard 这类按路径读文件的 skill
    const replaced = raw.replace(OUTPUT_PLACEHOLDER, (_m, dep) => {
      const env = results.get(dep);
      if (!env || !env.output?.path) {
        throw Object.assign(new Error(`step ${step.id} 的 input 模板引用了没有 output 的步骤: ${dep}`), { code: 'DEPENDENCY_OUTPUT_MISSING' });
      }
      // 作为 JSON 字符串内容插入，转义反斜杠/引号
      return JSON.stringify(env.output.path).slice(1, -1);
    });
    try { JSON.parse(replaced); } catch (e) {
      throw Object.assign(new Error(`step ${step.id} 的 input 模板替换后不是合法 JSON: ${e.message}`), { code: 'INPUT_INVALID' });
    }
    const file = path.join(inputDir, `${step.id}.json`);
    writeTextAtomic(file, replaced);
    return file;
  }
  const file = path.join(inputDir, `${step.id}.json`);
  const deps = step.depends_on;
  if (deps.length === 0) {
    writeJsonAtomic(file, {});
    return file;
  }
  if (deps.length === 1) {
    const env = results.get(deps[0]);
    if (!env || env.status !== 'success' || !env.output?.path || !fs.existsSync(env.output.path)) {
      throw Object.assign(new Error(`依赖 ${deps[0]} 没有可用 output`), { code: 'DEPENDENCY_OUTPUT_MISSING' });
    }
    return env.output.path;
  }
  // 多依赖：合并成 { "<depId>": <dep output data>, ... }，写给下一步
  const combined = {};
  for (const dep of deps) {
    const env = results.get(dep);
    if (!env || env.status !== 'success' || !env.output?.path || !fs.existsSync(env.output.path)) {
      throw Object.assign(new Error(`依赖 ${dep} 没有可用 output`), { code: 'DEPENDENCY_OUTPUT_MISSING' });
    }
    combined[dep] = readJson(env.output.path);
  }
  writeJsonAtomic(file, combined);
  return file;
}

function syntheticFailure(step, e) {
  return {
    schemaVersion: 1,
    status: 'failed',
    stepId: step.id,
    skill: step.skill,
    attempt: 0,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: null,
    output: null,
    artifacts: [],
    usage: { totalTokens: 0, costUsd: 0 },
    error: { code: e.code && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : 'STEP_CONFIG_ERROR', message: e.message, retryable: false },
  };
}

/**
 * 顺序执行一条 pipeline（M2 不做并发；M4 再加并发上限）。
 * @returns {Promise<{runId,pipelineId,status,steps,runFile,taskStatusFile}>}
 */
export async function runPipeline(root, pipelineId, {
  config,
  executor,
  runId,
  taskStatusFile,
  onEvent = () => {},
} = {}) {
  const cfg = config || loadPipelineConfig(root);
  const raw = cfg.pipelines?.[pipelineId];
  if (!raw) throw new Error(`pipeline 不存在: ${pipelineId}`);
  const steps = normalizePipeline(pipelineId, raw);
  const order = topoSort(steps);
  const byId = new Map(steps.map((s) => [s.id, s]));
  if (runId && !ID.test(runId)) throw new Error(`runId 非法: ${runId}`);
  const id = runId || newRunId();
  const exec = executor || new StepExecutor({ root });
  const status = new TaskStatusStore(root, taskStatusFile || undefined);
  const startedAt = new Date().toISOString();
  const runDir = path.join(root, 'workspace', id);
  fs.mkdirSync(runDir, { recursive: true });

  status.initRun({ runId: id, pipelineId, steps });
  onEvent({ type: 'run_start', runId: id, pipelineId, steps: order });

  const results = new Map();
  const ctx = { runId: id, pipelineId };
  let runStatus = 'success';

  const skipRemaining = (fromIndex) => {
    for (const sid of order.slice(fromIndex)) {
      if (results.has(sid)) continue;
      const s = byId.get(sid);
      results.set(sid, { status: 'skipped', error: { code: 'CANCELLED', message: '前序步骤失败，pipeline 已停止' } });
      status.update(id, sid, {
        status: 'skipped',
        finishedAt: new Date().toISOString(),
        error: { code: 'CANCELLED', message: '前序步骤失败，pipeline 已停止' },
      }, { pipelineId, skill: s.skill });
      onEvent({ type: 'step_skipped', runId: id, pipelineId, stepId: sid, reason: 'CANCELLED' });
    }
  };

  for (let i = 0; i < order.length; i++) {
    const sid = order[i];
    const step = byId.get(sid);
    const badDeps = step.depends_on.filter((d) => results.get(d)?.status !== 'success');
    if (badDeps.length) {
      const error = { code: 'DEPENDENCY_FAILED', message: `依赖未成功: ${badDeps.join(', ')}` };
      results.set(sid, { status: 'skipped', error });
      status.update(id, sid, { status: 'skipped', finishedAt: new Date().toISOString(), error }, { pipelineId, skill: step.skill });
      runStatus = 'failed';
      onEvent({ type: 'step_skipped', runId: id, pipelineId, stepId: sid, reason: 'DEPENDENCY_FAILED' });
      continue;
    }

    let inputFile;
    try {
      inputFile = prepareInput({ root, runId: id, step, results });
    } catch (e) {
      const env = syntheticFailure(step, e);
      results.set(sid, env);
      status.update(id, sid, taskPatchFromEnvelope(env), { pipelineId, skill: step.skill });
      runStatus = 'failed';
      onEvent({ type: 'step_end', runId: id, pipelineId, stepId: sid, status: 'failed', error: env.error });
      if (!step.continue_on_error) { skipRemaining(i + 1); break; }
      continue;
    }

    const startedStepAt = new Date().toISOString();
    status.update(id, sid, { status: 'running', startedAt: startedStepAt, error: null }, { pipelineId, skill: step.skill });
    onEvent({ type: 'step_start', runId: id, pipelineId, stepId: sid, skill: step.skill });

    let env;
    try {
      env = await exec.executeWithRetry(step, ctx, inputFile);
    } catch (e) {
      env = syntheticFailure(step, e);
    }
    results.set(sid, env);
    status.update(id, sid, taskPatchFromEnvelope(env), { pipelineId, skill: step.skill });
    onEvent({ type: 'step_end', runId: id, pipelineId, stepId: sid, status: env.status, error: env.error ?? null });

    if (env.status !== 'success') {
      runStatus = 'failed';
      if (!step.continue_on_error) { skipRemaining(i + 1); break; }
    }
  }

  // 任何未执行到的步骤（理论上 skipRemaining 已处理）兜底标 skipped
  for (const sid of order) {
    if (!results.has(sid)) {
      const s = byId.get(sid);
      results.set(sid, { status: 'skipped', error: { code: 'CANCELLED', message: '未执行' } });
      status.update(id, sid, { status: 'skipped', finishedAt: new Date().toISOString(), error: { code: 'CANCELLED', message: '未执行' } }, { pipelineId, skill: s.skill });
    }
    if (results.get(sid)?.status !== 'success') runStatus = 'failed';
  }

  const finishedAt = new Date().toISOString();
  const runFile = path.join(runDir, 'run.json');
  writeJsonAtomic(runFile, {
    schemaVersion: 1,
    runId: id,
    pipelineId,
    status: runStatus,
    startedAt,
    finishedAt,
    steps: order.map((sid) => {
      const s = byId.get(sid);
      const env = results.get(sid);
      return {
        id: sid,
        skill: s.skill,
        status: env?.status ?? 'skipped',
        attempt: env?.attempt ?? null,
        output: env?.output?.path ?? null,
        error: env?.error ?? null,
        tokens: env?.usage?.totalTokens ?? 0,
        costUsd: env?.usage?.costUsd ?? 0,
      };
    }),
  });
  onEvent({ type: 'run_end', runId: id, pipelineId, status: runStatus, runFile });
  return { runId: id, pipelineId, status: runStatus, steps: order.map((sid) => ({ id: sid, ...results.get(sid) })), runFile, taskStatusFile: status.file };
}
