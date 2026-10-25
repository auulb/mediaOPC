// 数据源插件基类：统一限速 + 文件缓存 + 输出组装（设计文档 6.1）
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const OPC_ROOT = process.env.OPC_ROOT
  ? path.resolve(process.env.OPC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带 code 的错误，code 与 step-envelope 中调度器保留码对齐 */
export class DataSourceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class DataSourcePlugin {
  /**
   * @param {object} config
   * @param {string} config.id            插件 id（raw-items.dataSource）
   * @param {string} config.platform      raw-items.platform
   * @param {number} [config.minIntervalMs=1000] 同一插件两次真实请求的最小间隔（跨进程，基于文件）
   * @param {number} [config.cacheTtlSec=3600]  缓存有效期，默认 1 小时（设计文档 8.2）
   * @param {string} [config.cacheDir]          默认 data/cache/{id}
   */
  constructor(config) {
    this.config = { minIntervalMs: 1000, cacheTtlSec: 3600, ...config };
    this.id = config.id;
    this.platform = config.platform;
    this.cacheDir = config.cacheDir || path.join(OPC_ROOT, 'data', 'cache', this.id);
  }

  /** 子类实现：返回原始数据 */
  async fetch(_params) {
    throw new Error('Must implement fetch()');
  }

  /** 子类实现：原始数据 → raw-items.items[] */
  transform(_rawData, _params) {
    throw new Error('Must implement transform()');
  }

  /** 跨进程限速：记录上次真实请求时间，不足间隔则等待 */
  async rateLimit() {
    const file = path.join(this.cacheDir, '_ratelimit.json');
    await fs.mkdir(this.cacheDir, { recursive: true });
    let last = 0;
    try {
      last = JSON.parse(await fs.readFile(file, 'utf8')).lastRequestAt || 0;
    } catch { /* 首次调用 */ }
    const wait = last + this.config.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    await fs.writeFile(file, JSON.stringify({ lastRequestAt: Date.now() }));
  }

  /** 由参数生成稳定缓存 key（忽略控制类参数；Cookie 既不进 key 也不落盘） */
  cacheKey(params) {
    const rest = stripControl(params);
    const sorted = JSON.stringify(rest, Object.keys(rest).sort());
    return `${this.id}-${crypto.createHash('sha1').update(sorted).digest('hex').slice(0, 12)}`;
  }

  async readCache(key, ttlSec) {
    try {
      const entry = JSON.parse(await fs.readFile(path.join(this.cacheDir, `${key}.json`), 'utf8'));
      if (Date.now() - Date.parse(entry.fetchedAt) < ttlSec * 1000) return entry;
    } catch { /* 无缓存或损坏 */ }
    return null;
  }

  async writeCache(key, entry) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const file = path.join(this.cacheDir, `${key}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry));
    await fs.rename(tmp, file); // 原子替换，避免并发读到半个文件
  }

  /**
   * 带缓存的完整流程，返回 raw-items v1 对象
   * @param {object} params 抓取参数；noCache=true 跳过缓存读取；cacheTtlSec 覆盖默认 TTL
   */
  async run(params = {}) {
    const ttl = params.cacheTtlSec ?? this.config.cacheTtlSec;
    const key = this.cacheKey(params);
    let entry = params.noCache ? null : await this.readCache(key, ttl);
    const hit = Boolean(entry);
    if (!entry) {
      await this.rateLimit();
      const raw = await this.fetch(params);
      entry = { fetchedAt: new Date().toISOString(), raw };
      await this.writeCache(key, entry);
    }
    const { items, warnings = [] } = this.transform(entry.raw, params, entry.fetchedAt);
    const out = {
      schemaVersion: 1,
      dataSource: this.id,
      platform: this.platform,
      timestamp: entry.fetchedAt,
      params: stripControl(params),
      cache: {
        hit,
        key,
        expiresAt: new Date(Date.parse(entry.fetchedAt) + ttl * 1000).toISOString(),
      },
      items,
    };
    if (warnings.length) out.warnings = warnings;
    return out;
  }
}

// Cookie 只用于请求头：不能出现在 output.json 的 params 回显里，也不参与缓存 key
const CONTROL_PARAMS = ['noCache', 'cookie', 'cookieFile'];

function stripControl(params) {
  const rest = { ...(params || {}) };
  for (const k of CONTROL_PARAMS) delete rest[k];
  return rest;
}

/** (likes+comments+shares+favorites)/views，保留 4 位 */
export function engagementOf({ views, likes = 0, comments = 0, shares = 0, favorites = 0 }) {
  if (!views) return 0;
  return Math.round(((likes + comments + shares + favorites) / views) * 10000) / 10000;
}

/** 相对本批中位数判断趋势：>1.5x rising，<0.5x falling */
export function velocityByMedian(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 'unknown';
  const median = sorted[Math.floor(sorted.length / 2)];
  return (v) => {
    if (!(v > 0)) return 'unknown';
    if (v > median * 1.5) return 'rising';
    if (v < median * 0.5) return 'falling';
    return 'stable';
  };
}

/** 带超时的 JSON GET；HTTP 412/429 → API_RATE_LIMIT，其余网络问题 → NETWORK_ERROR */
export async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new DataSourceError('NETWORK_ERROR', `请求失败: ${e.message}`, { url });
  }
  if (res.status === 412 || res.status === 429) {
    throw new DataSourceError('API_RATE_LIMIT', `被限流 HTTP ${res.status}`, { url });
  }
  if (!res.ok) throw new DataSourceError('NETWORK_ERROR', `HTTP ${res.status}`, { url });
  return res.json();
}
