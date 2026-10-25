// B 站 Cookie：只能由人手动粘贴。
//   - 禁止 AI / 脚本自动获取、猜测或生成 Cookie（数据接口页有明确标注）。
//   - 落盘 data/secrets/bilibili-cookie.txt（目录 0700 / 文件 0600），只在本机读取。
//   - 永不写入 logs、output.json、artifacts.json、缓存 key，也不通过 /api 返回原文。
import fs from 'node:fs';
import path from 'node:path';
import { OPC_ROOT } from './base.mjs';

export const SECRETS_DIR = path.join(OPC_ROOT, 'data', 'secrets');

/** Cookie 文件路径；OPC_COOKIE_FILE 仅用于测试隔离 */
export function cookieFile() {
  return process.env.OPC_COOKIE_FILE
    ? path.resolve(process.env.OPC_COOKIE_FILE)
    : path.join(SECRETS_DIR, 'bilibili-cookie.txt');
}

/** 允许粘贴 "Cookie: SESSDATA=..; bili_jct=..;" / 多行 / 带换行；统一成单行 name=value 序列 */
export function sanitizeCookie(input) {
  return String(input ?? '')
    .replace(/^\s*cookie\s*:\s*/i, '')
    .split(/[;\r\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('; ');
}

/** 至少要有 name=value；B 站登录态关键字段是 SESSDATA */
export function validateCookie(input) {
  const s = sanitizeCookie(input);
  if (!s) return { ok: false, error: 'Cookie 为空' };
  if (s.length > 8000) return { ok: false, error: 'Cookie 太长（>8000 字符），请只粘贴 bilibili.com 的 Cookie' };
  if (!/^[A-Za-z0-9_\-%.]+\s*=\s*[^;]*/.test(s)) return { ok: false, error: 'Cookie 格式不对，应为 SESSDATA=...; bili_jct=...;' };
  if (!/(^|;\s*)SESSDATA\s*=/.test(s)) return { ok: false, error: '缺少 SESSDATA（B 站登录态必需字段）' };
  return { ok: true, cookie: s };
}

export function readCookie() {
  try {
    return sanitizeCookie(fs.readFileSync(cookieFile(), 'utf8'));
  } catch {
    return '';
  }
}

/** 原子写入；失败时返回 {ok:false,error}，调用方决定如何提示 */
export function writeCookie(input) {
  const checked = validateCookie(input);
  if (!checked.ok) return checked;
  const file = cookieFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${checked.cookie}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 忽略 */ }
  return { ok: true, cookie: checked.cookie };
}

export function clearCookie() {
  try { fs.rmSync(cookieFile(), { force: true }); } catch { /* 忽略 */ }
  return { ok: true };
}

/** 给前端/日志用的状态，永远不含 Cookie 原文 */
export function cookieStatus() {
  const file = cookieFile();
  const cookie = readCookie();
  let savedAt = null;
  try { savedAt = fs.statSync(file).mtime.toISOString(); } catch { /* 未配置 */ }
  return {
    configured: Boolean(cookie),
    savedAt,
    bytes: cookie.length,
    hasSessdata: /(^|;\s*)SESSDATA\s*=/.test(cookie),
    file: path.relative(OPC_ROOT, file) || file,
    hint: cookie ? 'SESSDATA=***（已配置，仅本机可读）' : '未配置：B 站风控（-352）时在数据接口页手动粘贴',
    manualOnly: true, // 前端据此显示「禁止 AI」标记
  };
}

/** 供插件拼请求头；没有 Cookie 返回空对象 */
export function cookieHeaders(cookie) {
  const c = sanitizeCookie(cookie ?? readCookie());
  return c ? { Cookie: c } : {};
}
