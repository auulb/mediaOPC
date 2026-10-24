#!/usr/bin/env node
// generate-script 的确定性组装/校验部分（C-media）
// pi 负责写 ./draft.json（标题/标签/口播稿/分镜），本脚本负责：
//   1. 校验 draft 与 themes 输入
//   2. 校验分镜时长与主题 brief.durationSec 的偏差
//   3. 写 script.md + storyboard.json 到 data/scripts/{runId}/{themeId}/
//   4. 写 ./output.json（= render-remotion 的 input 契约）与 ./artifacts.json
// 用法：node assemble.mjs --input ./input.json --draft ./draft.json --output ./output.json
// 退出码：0 成功；1 失败（失败写 ./error.json）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(process.env.OPC_ROOT || path.resolve(SKILL_DIR, '../..'));
const ajvRequire = createRequire(path.join(ROOT, 'package.json'));

const PALETTES = {
  midnight: { primary: '#FF4D6D', background: '#0F1020', text: '#FFFFFF' },
  paper: { primary: '#1F6FEB', background: '#F7F4EC', text: '#1A1A1A' },
  mint: { primary: '#00C2A8', background: '#062A26', text: '#F2FFFC' },
  sunset: { primary: '#FFB020', background: '#2A0E1B', text: '#FFF6EC' },
};

// 分镜总时长与主题目标时长的允许偏差
const DURATION_TOLERANCE = 0.2;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

const now = () => new Date().toISOString();
const stamp = () => now().slice(0, 10).replace(/-/g, '');
const safeId = (v) => String(v).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'manual';
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

class StepError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadValidator() {
  const Ajv = ajvRequire('ajv/dist/2020.js').default;
  const addFormats = ajvRequire('ajv-formats').default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  // 先注册所有 schema（按 $id），再用 getSchema 取；重复 compile 同一 $id 会抛错
  const register = (file) => {
    const s = read(file);
    if (!ajv.getSchema(s.$id)) ajv.addSchema(s, s.$id);
    return ajv.getSchema(s.$id);
  };
  for (const f of fs.readdirSync(path.join(ROOT, 'contracts')).filter((f) => f.endsWith('.schema.json'))) {
    register(path.join(ROOT, 'contracts', f));
  }
  // render-remotion 的 input 契约依赖同 $id 命名空间下的 storyboard schema
  register(path.join(ROOT, 'skills/render-remotion/schemas/storyboard.schema.json'));
  return {
    themes: register(path.join(ROOT, 'contracts/themes.schema.json')),
    draft: register(path.join(SKILL_DIR, 'schemas/draft.schema.json')),
    renderInput: register(path.join(ROOT, 'skills/render-remotion/schemas/input.schema.json')),
    storyboard: register(path.join(ROOT, 'skills/render-remotion/schemas/storyboard.schema.json')),
    fmt: (errs) => ajv.errorsText(errs, { separator: '; ' }),
  };
}

/** 选择的主题：--theme-id 优先，否则取 confidence 最高的 */
function pickTheme(themes, themeId) {
  if (themeId) {
    const t = themes.find((x) => x.id === themeId);
    if (!t) throw new StepError('THEME_NOT_FOUND', `themes 中不存在 ${themeId}`);
    return t;
  }
  return [...themes].sort((a, b) => b.confidence - a.confidence)[0];
}

function buildStoryboard(draft, theme) {
  const total = draft.scenes.reduce((s, sc) => s + sc.durationSec, 0);
  const target = theme.brief.durationSec;
  const drift = Math.abs(total - target) / target;
  if (drift > DURATION_TOLERANCE) {
    throw new StepError(
      'DURATION_MISMATCH',
      `分镜总时长 ${total}s 与主题目标 ${target}s 偏差 ${Math.round(drift * 100)}%，超过 ${DURATION_TOLERANCE * 100}%`,
    );
  }
  return { theme: PALETTES[draft.palette], scenes: draft.scenes };
}

function run(args, v) {
  const outputFile = path.resolve(args.output || './output.json');
  const outputDir = path.dirname(outputFile);
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    const rawInput = JSON.parse(fs.readFileSync(path.resolve(args.input || './input.json'), 'utf8'));
    const input = rawInput && typeof rawInput === 'object' && 'data' in rawInput && 'stepId' in rawInput ? rawInput.data : rawInput;
    if (!v.themes(input)) throw new StepError('INPUT_INVALID', v.fmt(v.themes.errors));

    const draft = JSON.parse(fs.readFileSync(path.resolve(args.draft || './draft.json'), 'utf8'));
    if (!v.draft(draft)) throw new StepError('DRAFT_INVALID', v.fmt(v.draft.errors));

    const theme = pickTheme(input.themes, args['theme-id'] || process.env.OPC_THEME_ID);
    const storyboard = buildStoryboard(draft, theme);
    if (!v.storyboard(storyboard)) throw new StepError('DRAFT_INVALID', v.fmt(v.storyboard.errors));

    const runId = safeId(process.env.OPC_RUN_ID || `${stamp()}-manual`);
    const scriptDir = path.join(ROOT, 'data/scripts', runId, theme.id);
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'script.md');
    const storyboardPath = path.join(scriptDir, 'storyboard.json');
    // 固化上游主题文件作为溯源（attempt 目录可能出仓库，不能直接当 relPath 用）
    const themesPath = path.join(scriptDir, 'themes.json');
    fs.writeFileSync(themesPath, `${JSON.stringify(input, null, 2)}\n`);
    fs.writeFileSync(scriptPath, draft.scriptMarkdown.endsWith('\n') ? draft.scriptMarkdown : `${draft.scriptMarkdown}\n`);
    fs.writeFileSync(storyboardPath, `${JSON.stringify(storyboard, null, 2)}\n`);

    const out = {
      schemaVersion: 1,
      themeId: theme.id,
      template: 'remotion/explainer-30s',
      storyboard,
      script: { path: rel(scriptPath), storyboardPath: rel(storyboardPath) },
      metadataDraft: {
        title: draft.title,
        description: draft.description,
        tags: draft.tags,
        ...(theme.brief.keywords.length ? { category: theme.brief.keywords[0] } : {}),
      },
      targetPlatforms: theme.targetPlatform,
      sourceRef: { themesFile: rel(themesPath), themeId: theme.id },
    };
    if (!v.renderInput(out)) throw new StepError('OUTPUT_INVALID', v.fmt(v.renderInput.errors));

    fs.writeFileSync(outputFile, `${JSON.stringify(out, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, 'artifacts.json'), `${JSON.stringify([
      { path: rel(scriptPath), kind: 'markdown', description: '口播脚本' },
      { path: rel(storyboardPath), kind: 'json', description: '分镜（= Remotion inputProps）' },
    ], null, 2)}\n`);
    console.log(`[generate-script] ok ${theme.id} ${storyboard.scenes.reduce((s, x) => s + x.durationSec, 0)}s → ${rel(scriptDir)}`);
    return 0;
  } catch (e) {
    const code = e instanceof StepError ? e.code : 'ASSEMBLE_FAILED';
    fs.writeFileSync(path.join(outputDir, 'error.json'), `${JSON.stringify({ code, message: String(e.message).slice(0, 2000), retryable: code === 'ASSEMBLE_FAILED' }, null, 2)}\n`);
    console.error(`[generate-script] FAILED ${code}: ${e.message}`);
    return 1;
  }
}

process.exit(run(parseArgs(process.argv.slice(2)), loadValidator()));
