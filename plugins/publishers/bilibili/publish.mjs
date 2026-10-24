#!/usr/bin/env node
// 发布到 B 站（C-media）：预检 → 复用浏览器 profile → 需要时停下等人工扫码 → 上传 → 填写信息 → 投稿 → 写发布记录。
// 用法：
//   node publish.mjs --input ./input.json --output ./output.json
//   node publish.mjs --input ./input.json --dry-run        # 只跑预检，本地调试用，不写记录
// 环境：OPC_ROOT、OPC_PUBLISH_HEADLESS=1（调试用，正式发布必须 headful）、OPC_QR_TIMEOUT_SEC
// 退出码：0 成功；1 失败（写 ./error.json）；2 预检未通过
//
// 安全边界：登录只能由人工扫码完成。本脚本不读取、不迁移、不注入任何 Cookie，
// 扫码超时即停（status=login_required），不重试、不绕过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPC_ROOT, STATUS, buildRecord, saveFailureShot, trimMetadata } from '../lib/base.mjs';
import { precheck } from './precheck.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, 'platform.json'), 'utf8'));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    a[k] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1];
  }
  return a;
}

const now = () => new Date().toISOString();

class PublishError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

async function firstMatch(page, selectors, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) return { loc, sel };
    }
    await page.waitForTimeout(250);
  }
  throw new PublishError('SELECTOR_NOT_FOUND', `找不到选择器: ${selectors.join(' | ')}`);
}

function isLoggedIn(context) {
  return context.cookies().then((cs) => cs.some((c) => c.name === CFG.login.loggedInCookie && c.value));
}

/** 打开上传页；未登录时提示人工扫码并等待，超时即停 */
async function openUploadPage(context) {
  const page = await context.newPage();
  await page.goto(CFG.uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  if (await isLoggedIn(context)) return page;

  const timeoutSec = Number(process.env.OPC_QR_TIMEOUT_SEC || CFG.login.qrTimeoutSec);
  process.stderr.write(
    `\n[发布] 需要登录 B 站。\n` +
      `  浏览器窗口已打开，请在 ${timeoutSec} 秒内用手机 B 站 App 扫码登录。\n` +
      `  登录状态会保存在 ${CFG.login.profileDir}，7 天内免扫码。\n` +
      `  超时将停止本步（不会自动重试）。\n\n`,
  );

  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await isLoggedIn(context)) {
      await page.goto(CFG.uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      process.stderr.write('[发布] 已登录，继续。\n');
      return page;
    }
    await page.waitForTimeout(2000);
  }
  throw new PublishError('LOGIN_TIMEOUT', `等待扫码 ${timeoutSec}s 超时`);
}

async function upload(page, production) {
  const videoFile = path.resolve(OPC_ROOT, production.video.path);
  const meta = trimMetadata(production.metadataDraft, CFG.limits);

  // 投稿页初期只有一个“上传视频”按钮，file input 可能要点击后才出现
  let fileInput = page.locator(CFG.selectors.uploadInput.join(',')).first();
  if (!(await fileInput.count())) {
    const btn = page.locator('button:has-text("上传视频")').first();
    if (await btn.count()) await btn.click();
    fileInput = page.locator(CFG.selectors.uploadInput.join(',')).first();
    await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  }
  await fileInput.setInputFiles(videoFile);

  // 等标题输入框出现，说明上传已开始
  const { loc: title } = await firstMatch(page, CFG.selectors.titleInput, { timeout: 60000 });
  await title.fill(meta.title);

  const { loc: desc } = await firstMatch(page, CFG.selectors.descriptionEditor);
  await desc.click();
  await desc.fill(meta.description);

  if (meta.tags.length) {
    try {
      const { loc: tag } = await firstMatch(page, CFG.selectors.tagInput, { timeout: 5000 });
      for (const t of meta.tags) {
        await tag.fill(t);
        await tag.press('Enter');
      }
    } catch (e) {
      if (!(e instanceof PublishError)) throw e;
      process.stderr.write(`[发布] 标签输入框未找到，跳过标签（${e.message}）\n`);
    }
  }

  // 等待上传转码完成（提交按钮可用）
  const { loc: submit } = await firstMatch(page, CFG.selectors.submitButton, { timeout: 600000 });
  await submit.waitFor({ state: 'visible', timeout: 600000 });
  await page.waitForTimeout(2000);
  await submit.click();

  // 投稿后可能是“立即投稿”确认弹窗，也可能直接跳转稿件页
  await page.waitForTimeout(5000);
  const url = page.url();
  const bv = (await page.content()).match(/BV[0-9A-Za-z]{10}/)?.[0] ?? url.match(/BV[0-9A-Za-z]{10}/)?.[0] ?? null;

  let status = STATUS.submitted;
  if (bv) status = STATUS.published;
  return { status, url, platformVideoId: bv };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = path.resolve(args.input || './input.json');
  const outputFile = path.resolve(args.output || './output.json');
  const outputDir = path.dirname(outputFile);
  fs.mkdirSync(outputDir, { recursive: true });

  let production;
  try {
    const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    production = raw && typeof raw === 'object' && 'data' in raw && 'stepId' in raw ? raw.data : raw;
  } catch (e) {
    fs.writeFileSync(path.join(outputDir, 'error.json'), JSON.stringify({ code: 'INPUT_INVALID', message: `input.json 读取失败: ${e.message}`, retryable: false }, null, 2));
    return 1;
  }

  // 1. 预检：不通过就直接停，绝不进入上传
  const pre = precheck(production);
  const base = {
    themeId: production.themeId,
    productionId: production.productionId,
    platform: 'bilibili',
    metadata: pre.metadata,
    precheck: { passed: pre.passed, checks: pre.checks },
  };
  const failRecord = (status, error, extra = {}) =>
    buildRecord({ ...base, status, error, ...extra });

  if (!pre.passed) {
    process.stderr.write(`[发布] 预检未通过：${pre.checks.filter((c) => !c.passed).map((c) => `${c.name}(${c.detail || ''})`).join(', ')}\n`);
    if (args['dry-run']) return 2;
    fs.writeFileSync(outputFile, `${JSON.stringify(failRecord(STATUS.precheckFailed, { code: 'PRECHECK_FAILED', message: '预检未通过', }), null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, 'error.json'), JSON.stringify({ code: 'PRECHECK_FAILED', message: pre.checks.filter((c) => !c.passed).map((c) => c.name).join(','), retryable: false }, null, 2));
    return 2;
  }

  if (args['dry-run']) {
    process.stdout.write(`${JSON.stringify({ passed: true, checks: pre.checks }, null, 2)}\n`);
    return 0;
  }

  // 硬开关：预检通过也不等于可以发。真实投稿必须显式开启，避免调试/联调时误发到真实账号。
  // 未开启不算故障：预检已通过，产出 manual_fallback + PUBLISH_DISABLED，退出码 0（调度器显示绿色）
  if (process.env.OPC_PUBLISH_ENABLED !== '1') {
    const msg = '预检通过，但未启用真实投稿（OPC_PUBLISH_ENABLED≠1）：本次未上传、未提交';
    process.stderr.write(`[发布] WARN ${msg}\n`);
    fs.writeFileSync(outputFile, `${JSON.stringify(failRecord(STATUS.manualFallback, { code: 'PUBLISH_DISABLED', message: msg }), null, 2)}\n`);
    return 0;
  }

  // 2. 浏览器：持久化 profile，扫码由人工完成
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    const msg = '未安装 playwright（在 plugins/publishers 下 npm install）';
    fs.writeFileSync(outputFile, `${JSON.stringify(failRecord(STATUS.failed, { code: 'UNKNOWN', message: msg }), null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, 'error.json'), JSON.stringify({ code: 'UNKNOWN', message: msg, retryable: false }, null, 2));
    return 1;
  }

  const profileDir = path.resolve(OPC_ROOT, CFG.login.profileDir);
  fs.mkdirSync(profileDir, { recursive: true });
  const headless = process.env.OPC_PUBLISH_HEADLESS === '1';
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
  });

  let page = null;
  try {
    page = await openUploadPage(context);
    const r = await upload(page, production);
    const record = buildRecord({
      ...base,
      status: r.status,
      publishedAt: now(),
      url: r.url,
      platformVideoId: r.platformVideoId,
      error: null,
      initialMetrics: { views: 0, likes: 0, comments: 0 },
    });
    fs.writeFileSync(outputFile, `${JSON.stringify(record, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, 'artifacts.json'), `${JSON.stringify([
      { path: production.video.path, kind: 'video', description: '已发布成片' },
      { path: production.cover.path, kind: 'image', description: '封面' },
    ], null, 2)}\n`);
    process.stderr.write(`[发布] ${r.status} ${r.platformVideoId ?? ''} ${r.url}\n`);
    return 0;
  } catch (e) {
    const code = e instanceof PublishError ? e.code : 'UPLOAD_FAILED';
    const shot = await saveFailureShot(page, production.productionId);
    const status = code === 'LOGIN_TIMEOUT' ? STATUS.loginRequired : code === 'SELECTOR_NOT_FOUND' ? STATUS.manualFallback : STATUS.failed;
    const error = { code, message: String(e.message).slice(0, 1000), ...(shot ? { screenshot: shot } : {}) };
    fs.writeFileSync(outputFile, `${JSON.stringify(failRecord(status, error), null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, 'error.json'), JSON.stringify({ code, message: error.message, retryable: code === 'NETWORK_ERROR' || code === 'UPLOAD_FAILED' }, null, 2));
    process.stderr.write(`[发布] FAILED ${code}: ${e.message}\n`);
    return 1;
  } finally {
    await context.close().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
