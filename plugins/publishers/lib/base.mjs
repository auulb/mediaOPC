// 发布器公共逻辑：预检项构造 + 发布记录组装（设计文档 2.2 模块 5 / 6.1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPC_ROOT = process.env.OPC_ROOT
  ? path.resolve(process.env.OPC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const STATUS = {
  published: 'published',
  submitted: 'submitted',
  precheckFailed: 'precheck_failed',
  loginRequired: 'login_required',
  manualFallback: 'manual_fallback',
  failed: 'failed',
};

/** 预检结果：checks 顺序固定，便于测试断言 */
export function check(name, passed, detail) {
  return { name, passed, ...(detail ? { detail } : {}) };
}

export function readSensitiveWords(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** 平台规则裁剪：标签超限直接截断到上限，标题超限不裁剪（需人工改名） */
export function trimMetadata(metadata, limits) {
  return {
    title: metadata.title,
    description: (metadata.description || '').slice(0, limits.maxDescriptionLength),
    tags: [...new Set(metadata.tags)]
      .slice(0, limits.maxTags)
      .map((t) => t.slice(0, limits.maxTagLength)),
    thumbnail: metadata.thumbnail,
  };
}

export function buildRecord({ themeId, productionId, platform, status, metadata, precheck, publishedAt = null, url = null, platformVideoId = null, error = null, initialMetrics }) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // 同一天同一生产可能重发/整改，publishId 必须每次唯一：productionId 指纹 + 时间后缀
  const fingerprint = Array.from(String(productionId))
    .reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 7)
    .toString(36)
    .slice(0, 4);
  const seq = Date.now().toString(36).slice(-4);
  return {
    schemaVersion: 1,
    publishId: `pub_${day}_${platform}_${themeId}_${fingerprint}-${seq}`,
    themeId,
    productionId,
    platform,
    status,
    publishedAt,
    url,
    platformVideoId,
    metadata,
    precheck,
    ...(initialMetrics ? { initialMetrics } : {}),
    error,
  };
}

/** 从失败现场留证：截图相对仓库根目录 */
export async function saveFailureShot(page, productionId) {
  if (!page) return null;
  const dir = path.join(OPC_ROOT, 'logs', 'publish', String(productionId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `failure-${Date.now()}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    return path.relative(OPC_ROOT, file).split(path.sep).join('/');
  } catch {
    return null;
  }
}
