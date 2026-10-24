// schedule.yaml cron 解析与触发（M2）。
// 支持标准 5 段 cron：分 时 日 月 周；*、a-b、a,b、*/n、a-b/n、月份/星期英文缩写。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { runPipeline } from './pipeline.js';
import { StepExecutor, newRunId } from './executor.js';

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

const pad = (n) => String(n).padStart(2, '0');
export const formatMinute = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function parseValue(token, min, max, names) {
  const upper = token.toUpperCase();
  const n = names && names[upper] !== undefined ? names[upper] : Number(token);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`cron 取值越界: ${token}`);
  return n;
}

function parseField(field, min, max, names, { dow = false } = {}) {
  const set = new Set();
  const parts = field.split(',');
  if (parts.some((p) => p === '')) throw new Error(`cron 字段非法: ${field}`);
  for (const part of parts) {
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`cron 字段非法: ${part}`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长非法: ${part}`);
    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      if (b === undefined) throw new Error(`cron 范围非法: ${part}`);
      start = parseValue(a, min, max, names);
      end = parseValue(b, min, max, names);
    } else {
      start = parseValue(rangePart, min, max, names);
      end = stepPart === undefined ? start : max;
    }
    if (start > end) throw new Error(`cron 范围起止非法: ${part}`);
    for (let v = start; v <= end; v += step) set.add(dow && v === 7 ? 0 : v);
  }
  return set;
}

/** @returns {{raw:string,minute:Set,hour:Set,dayOfMonth:Set,month:Set,dayOfWeek:Set,domWildcard:boolean,dowWildcard:boolean}} */
export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('cron 必须是字符串');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 必须是 5 段: ${expr}`);
  const [min, hour, dom, month, dow] = parts;
  return {
    raw: expr,
    minute: parseField(min, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(month, 1, 12, MONTHS),
    dayOfWeek: parseField(dow, 0, 7, DAYS, { dow: true }),
    domWildcard: dom === '*',
    dowWildcard: dow === '*',
  };
}

export function cronMatches(expr, date) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!c.minute.has(date.getMinutes())) return false;
  if (!c.hour.has(date.getHours())) return false;
  if (!c.month.has(date.getMonth() + 1)) return false;
  const domMatch = c.dayOfMonth.has(date.getDate());
  const dowMatch = c.dayOfWeek.has(date.getDay());
  if (c.domWildcard && c.dowWildcard) return true;
  if (c.domWildcard) return dowMatch;
  if (c.dowWildcard) return domMatch;
  // 标准 cron：日与周都限定时取“或”
  return domMatch || dowMatch;
}

export function loadSchedules(root, file = 'config/schedule.yaml') {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(abs)) throw new Error(`schedule 配置不存在: ${abs}`);
  const doc = YAML.parse(fs.readFileSync(abs, 'utf8'));
  const list = doc?.schedules;
  if (!Array.isArray(list)) throw new Error(`${file}: 缺少 schedules 数组`);
  const names = new Set();
  return list.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`${file}: 第 ${i + 1} 条 schedule 非法`);
    if (typeof s.name !== 'string' || !s.name) throw new Error(`${file}: schedule.name 必填`);
    if (names.has(s.name)) throw new Error(`${file}: schedule.name 重复: ${s.name}`);
    names.add(s.name);
    if (typeof s.pipeline !== 'string' || !s.pipeline) throw new Error(`${file}/${s.name}: pipeline 必填`);
    if (typeof s.cron !== 'string') throw new Error(`${file}/${s.name}: cron 必填`);
    parseCron(s.cron); // 配置期就报错
    const dependencies = s.dependencies === undefined ? [] : Array.isArray(s.dependencies) ? s.dependencies : [s.dependencies];
    if (dependencies.some((d) => typeof d !== 'string')) throw new Error(`${file}/${s.name}: dependencies 必须是字符串数组`);
    return {
      ...s,
      name: s.name,
      pipeline: s.pipeline,
      cron: s.cron,
      enabled: s.enabled === true,
      dependencies,
      manual_approval: s.manual_approval === true,
    };
  });
}

function statePath(root, file) {
  if (!file) return path.join(root, 'data', 'schedule_state.json');
  return path.isAbsolute(file) ? file : path.join(root, file);
}

function readState(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && typeof v === 'object' && v.schedules && typeof v.schedules === 'object') return v;
  } catch { /* 从空开始 */ }
  return { schemaVersion: 1, schedules: {} };
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...state, schemaVersion: 1 }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * 跑当前分钟到期的 schedule。同一 schedule 同一分钟只跑一次；dependencies 未成功的跳过。
 * runner 可注入（测试用），返回 {status, runId}。
 */
export async function runDue(root, now = new Date(), {
  schedules,
  config,
  executor,
  stateFile,
  runner,
  onEvent = () => {},
} = {}) {
  const list = schedules || loadSchedules(root);
  const file = statePath(root, stateFile);
  const state = readState(file);
  const minute = formatMinute(now);
  const results = [];
  let exec = executor;
  if (!runner && !exec) exec = new StepExecutor({ root });

  for (const schedule of list) {
    if (!schedule.enabled) continue;
    if (!cronMatches(schedule.cron, now)) continue;
    const prev = state.schedules[schedule.name];
    if (prev?.lastRunMinute === minute) continue; // 本分钟已处理

    const base = { name: schedule.name, pipeline: schedule.pipeline, at: now.toISOString() };
    if (schedule.manual_approval) {
      state.schedules[schedule.name] = { ...base, lastRunMinute: minute, lastStatus: 'pending_approval', lastRunAt: now.toISOString() };
      writeState(file, state);
      results.push({ ...base, status: 'pending_approval' });
      onEvent({ type: 'schedule_pending_approval', ...base });
      continue;
    }
    const badDeps = schedule.dependencies.filter((d) => state.schedules[d]?.lastStatus !== 'success');
    if (badDeps.length) {
      state.schedules[schedule.name] = { ...base, lastRunMinute: minute, lastStatus: 'dependency_failed', lastRunAt: now.toISOString(), error: `依赖未成功: ${badDeps.join(', ')}` };
      writeState(file, state);
      results.push({ ...base, status: 'dependency_failed' });
      onEvent({ type: 'schedule_dependency_failed', ...base, dependencies: badDeps });
      continue;
    }

    try {
      const r = runner
        ? await runner({ schedule, now, config })
        : await runPipeline(root, schedule.pipeline, { config, executor: exec, runId: newRunId(now) });
      state.schedules[schedule.name] = {
        ...base,
        lastRunMinute: minute,
        lastStatus: r.status,
        lastRunId: r.runId,
        lastRunAt: now.toISOString(),
      };
      writeState(file, state);
      results.push({ ...base, status: r.status, runId: r.runId });
      onEvent({ type: 'schedule_run', ...base, status: r.status, runId: r.runId });
    } catch (e) {
      state.schedules[schedule.name] = {
        ...base,
        lastRunMinute: minute,
        lastStatus: 'failed',
        lastRunAt: now.toISOString(),
        error: e.message,
      };
      writeState(file, state);
      results.push({ ...base, status: 'failed', error: e.message });
      onEvent({ type: 'schedule_run', ...base, status: 'failed', error: e.message });
    }
  }
  return results;
}

/** opc start 的循环体：每 intervalMs 检查一次，runDue 内部按分钟去重 */
export async function startScheduler(root, {
  intervalMs = 30_000,
  once = false,
  config,
  executor,
  stateFile,
  log = console,
} = {}) {
  const tick = async () => {
    const results = await runDue(root, new Date(), { config, executor, stateFile });
    for (const r of results) log.log(`[${new Date().toISOString()}] ${r.name} ${r.status}${r.runId ? ` ${r.runId}` : ''}${r.error ? `: ${r.error}` : ''}`);
    return results;
  };
  if (once) {
    await tick();
    return;
  }
  log.log(`OPC scheduler started (every ${intervalMs}ms, Ctrl-C to stop)`);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopped) {
    try {
      await tick();
    } catch (e) {
      const msg = `tick 失败: ${e.message}`;
      if (typeof log.error === 'function') log.error(msg);
      else log.log(msg);
    }
    if (stopped) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  log.log('OPC scheduler stopped');
}
