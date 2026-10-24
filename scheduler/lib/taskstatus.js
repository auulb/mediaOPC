// dashboard/task_status.json 读写（M2）。
// 结构：{ schemaVersion:1, updatedAt, tasks:[{runId,pipelineId,stepId,skill,status,...}] }
// B 的 build-dashboard 按 tasks[].status 统计 success/failed/running/pending，并取最后 10 条。
import fs from 'node:fs';
import path from 'node:path';

export const TASK_STATUS_FILE = 'dashboard/task_status.json';
export const TASK_STATUSES = ['pending', 'running', 'success', 'failed', 'skipped'];
const MAX_TASKS = 500;

const nowIso = () => new Date().toISOString();

function readJsonSafe(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && Array.isArray(v.tasks)) return v;
    if (Array.isArray(v)) return { schemaVersion: 1, updatedAt: nowIso(), tasks: v };
  } catch { /* 文件不存在或损坏：从空开始 */ }
  return { schemaVersion: 1, updatedAt: nowIso(), tasks: [] };
}

export class TaskStatusStore {
  constructor(root, file = TASK_STATUS_FILE) {
    this.root = path.resolve(root);
    this.file = path.isAbsolute(file) ? file : path.join(this.root, file);
  }

  read() {
    return readJsonSafe(this.file);
  }

  _write(doc) {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tasks = doc.tasks.slice(-MAX_TASKS);
    const out = { schemaVersion: 1, updatedAt: nowIso(), tasks };
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    return out;
  }

  /** 运行开始：为每个 step 建 pending 记录（已存在则复用） */
  initRun({ runId, pipelineId, steps }) {
    const doc = this.read();
    for (const s of steps) {
      const stepId = typeof s === 'string' ? s : s.id;
      const skill = typeof s === 'string' ? s : s.skill;
      if (!doc.tasks.some((t) => t.runId === runId && t.stepId === stepId)) {
        doc.tasks.push({
          runId, pipelineId, stepId, skill,
          status: 'pending',
          attempt: null,
          createdAt: nowIso(),
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          tokens: 0,
          costUsd: 0,
          output: null,
          error: null,
        });
      }
    }
    return this._write(doc);
  }

  /** 更新（或补建）某个 step 的记录 */
  update(runId, stepId, patch, { pipelineId, skill } = {}) {
    if (patch.status && !TASK_STATUSES.includes(patch.status)) {
      throw new Error(`非法 task status: ${patch.status}`);
    }
    const doc = this.read();
    let task = doc.tasks.find((t) => t.runId === runId && t.stepId === stepId);
    if (!task) {
      task = {
        runId, stepId,
        pipelineId: pipelineId ?? 'adhoc',
        skill: skill ?? stepId,
        status: 'pending',
        attempt: null,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        tokens: 0,
        costUsd: 0,
        output: null,
        error: null,
      };
      doc.tasks.push(task);
    }
    Object.assign(task, patch);
    return this._write(doc);
  }

  get(runId, stepId) {
    return this.read().tasks.find((t) => t.runId === runId && t.stepId === stepId) || null;
  }
}

/** 把 StepEnvelope 转成 task_status 的增量字段 */
export function taskPatchFromEnvelope(env) {
  return {
    status: env.status === 'success' ? 'success' : env.status === 'skipped' ? 'skipped' : 'failed',
    attempt: env.attempt ?? null,
    startedAt: env.startedAt ?? null,
    finishedAt: env.finishedAt ?? null,
    durationMs: env.startedAt && env.finishedAt ? Date.parse(env.finishedAt) - Date.parse(env.startedAt) : null,
    tokens: env.usage?.totalTokens ?? 0,
    costUsd: env.usage?.costUsd ?? 0,
    output: env.output?.path ?? null,
    error: env.error ?? null,
  };
}
