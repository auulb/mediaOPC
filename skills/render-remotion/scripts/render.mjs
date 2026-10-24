#!/usr/bin/env node
// render-remotion 确定性渲染脚本（C-media）
// 用法：
//   node render.mjs --input ./input.json --output ./output.json
//   node render.mjs --props <storyboard.json> --out <dir>      # 仅渲染，调试模板用
// 环境：OPC_ROOT（仓库根，缺省按脚本位置推断）、OPC_STEP_ID、OPC_RUN_ID
// 退出码：0 成功；1 失败（失败原因写入 ./error.json，业务 output.json 不写入）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(process.env.OPC_ROOT || path.resolve(SKILL_DIR, '../..'));
const TEMPLATE_DIR = path.join(ROOT, 'templates/remotion');
const COMPOSITION = { 'remotion/explainer-30s': 'explainer-30s' };

// remotion 依赖装在 templates/remotion 下，从那里解析
const tplRequire = createRequire(path.join(TEMPLATE_DIR, 'package.json'));
const ajvRequire = createRequire(path.join(ROOT, 'package.json'));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const now = () => new Date().toISOString();
const stamp = () => now().slice(0, 10).replace(/-/g, '');
const safeId = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'manual';

function loadValidator() {
  const Ajv = ajvRequire('ajv/dist/2020.js').default;
  const addFormats = ajvRequire('ajv-formats').default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  ajv.addSchema(read(path.join(SKILL_DIR, 'schemas/storyboard.schema.json')), 'storyboard.schema.json');
  return {
    input: ajv.compile(read(path.join(SKILL_DIR, 'schemas/input.schema.json'))),
    storyboard: ajv.getSchema('storyboard.schema.json'),
    production: ajv.compile(read(path.join(ROOT, 'contracts/production.schema.json'))),
    fmt: (errs) => ajv.errorsText(errs, { separator: '; ' }),
  };
}

class StepError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

async function renderVideo({ storyboard, template, outDir }) {
  const compositionId = COMPOSITION[template];
  if (!compositionId) throw new StepError('TEMPLATE_UNKNOWN', `未知模板 ${template}`);
  const { bundle } = await import(tplRequire.resolve('@remotion/bundler'));
  const { selectComposition, renderMedia, renderStill } = await import(tplRequire.resolve('@remotion/renderer'));

  fs.mkdirSync(outDir, { recursive: true });
  const serveUrl = await bundle({ entryPoint: path.join(TEMPLATE_DIR, 'src/index.ts') });
  const composition = await selectComposition({ serveUrl, id: compositionId, inputProps: storyboard });

  const videoPath = path.join(outDir, 'final.mp4');
  let lastPct = -1;
  await renderMedia({
    serveUrl, composition, inputProps: storyboard,
    codec: 'h264', outputLocation: videoPath,
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 10) * 10;
      if (pct !== lastPct) { lastPct = pct; process.stderr.write(`[render] ${pct}%\n`); }
    },
  });

  // 封面：取第一个场景入场动画完成后的一帧
  const coverPath = path.join(outDir, 'cover.jpg');
  await renderStill({
    serveUrl, composition, inputProps: storyboard,
    output: coverPath, frame: Math.min(45, composition.durationInFrames - 1), imageFormat: 'jpeg', jpegQuality: 90,
  });
  return { videoPath, coverPath, composition };
}

function probe(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name:format=duration,size',
    '-of', 'json', videoPath,
  ]);
  const j = JSON.parse(out.toString());
  const s = j.streams[0];
  const [n, d] = s.r_frame_rate.split('/').map(Number);
  return {
    durationSec: Math.round(Number(j.format.duration) * 100) / 100,
    width: s.width, height: s.height, fps: d ? n / d : n,
    sizeBytes: Number(j.format.size), codec: s.codec_name,
  };
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function runStep(args, v) {
  const outputFile = path.resolve(args.output || './output.json');
  const outputDir = path.dirname(outputFile);
  fs.mkdirSync(outputDir, { recursive: true });
  const writeOutput = (data) => fs.writeFileSync(outputFile, JSON.stringify(data, null, 2) + '\n');
  const writeFailure = (error) => {
    // A-core 的 executor 优先读取 error.json；失败时不伪造一份不符合 production 契约的 output.json。
    fs.writeFileSync(path.join(outputDir, 'error.json'), JSON.stringify(error, null, 2) + '\n');
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(args.input || './input.json'), 'utf8'));
    // 兼容：上一步 envelope 原样传入时取 data
    const input = raw && typeof raw === 'object' && 'data' in raw && 'stepId' in raw ? raw.data : raw;
    if (!v.input(input)) throw new StepError('INPUT_INVALID', v.fmt(v.input.errors));

    const runSuffix = safeId(process.env.OPC_RUN_ID || `${Date.now()}`);
    const productionId = `prod_${stamp()}_${input.themeId}_${runSuffix}`;
    const outDir = path.join(ROOT, 'data/productions', productionId);
    const { videoPath, coverPath, composition } = await renderVideo({
      storyboard: input.storyboard, template: input.template, outDir,
    });
    fs.writeFileSync(path.join(outDir, 'storyboard.json'), JSON.stringify(input.storyboard, null, 2) + '\n');

    const meta = probe(videoPath);
    const production = {
      schemaVersion: 1, productionId, themeId: input.themeId, createdAt: now(),
      renderer: 'remotion', template: input.template,
      video: { path: rel(videoPath), ...meta, sha256: sha256(videoPath) },
      cover: { path: rel(coverPath), width: composition.width, height: composition.height },
      script: {
        ...(input.script?.path ? { path: input.script.path } : { path: rel(path.join(outDir, 'storyboard.json')) }),
        storyboardPath: rel(path.join(outDir, 'storyboard.json')),
      },
      metadataDraft: input.metadataDraft,
      targetPlatforms: input.targetPlatforms,
      sourceRef: input.sourceRef,
    };
    if (!v.production(production)) throw new StepError('OUTPUT_INVALID', v.fmt(v.production.errors));

    writeOutput(production);
    fs.writeFileSync(path.join(outputDir, 'artifacts.json'), JSON.stringify([
      { path: rel(videoPath), kind: 'video', contract: 'production', description: '成片' },
      { path: rel(coverPath), kind: 'image', description: '封面' },
      { path: rel(path.join(outDir, 'storyboard.json')), kind: 'json', description: '分镜' },
    ], null, 2) + '\n');
    process.stderr.write(`[render] ok ${production.video.path} ${meta.durationSec}s ${meta.sizeBytes}B\n`);
    return 0;
  } catch (e) {
    const code = e instanceof StepError ? e.code : 'RENDER_FAILED';
    const retryable = e instanceof StepError ? e.retryable : true;
    writeFailure({ code, message: String(e.message).slice(0, 2000), retryable });
    process.stderr.write(`[render] FAILED ${code}: ${e.message}\n`);
    return 1;
  }
}

async function runDebug(args, v) {
  const storyboard = JSON.parse(fs.readFileSync(path.resolve(args.props), 'utf8'));
  if (!v.storyboard(storyboard)) throw new Error(v.fmt(v.storyboard.errors));
  const r = await renderVideo({ storyboard, template: args.template || 'remotion/explainer-30s', outDir: path.resolve(args.out) });
  console.log(JSON.stringify(probe(r.videoPath)));
  return 0;
}

const args = parseArgs(process.argv.slice(2));
const v = loadValidator();
process.exit(args.props ? await runDebug(args, v) : await runStep(args, v));
