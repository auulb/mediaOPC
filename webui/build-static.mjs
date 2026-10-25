#!/usr/bin/env node
// 把本地运行中的制作台导出成纯静态站点（gh-pages / Vercel / 任意静态托管）。
// 用法：node webui/build-static.mjs [--base http://127.0.0.1:4180] [--out webui/dist]
//
// 产物：
//   index.html app.js style.css static-mode.js
//   static-data/{data,topics,productions,bootstrap}.json   只读快照
//   media/<data/...>                                       成片与封面
// 说明：静态站只读（不能 spawn 进程），按钮会提示回本地运行。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = arg('base', `http://127.0.0.1:${process.env.OPC_WEB_PORT || 4180}`);
const OUT = path.resolve(ROOT, arg('out', 'webui/dist'));

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

async function getJson(p) {
  const r = await fetch(`${BASE}${p}`);
  if (!r.ok) die(`${p} → HTTP ${r.status}（本地服务没起？先 ./webui/start.sh）`);
  return r.json();
}

console.log(`→ 从 ${BASE} 抓取快照`);
const [data, topics, productions, bootstrap, schedule] = await Promise.all([
  getJson('/api/data'),
  getJson('/api/topics'),
  getJson('/api/productions'),
  getJson('/api/bootstrap'),
  getJson('/api/schedule'),
]);

// 静态站不展示「正在运行」的历史态
bootstrap.active = null;
bootstrap.runs = (bootstrap.runs || []).slice(0, 8).map((r) => ({ ...r, active: false }));

// 静态站没有调度器：标成未启动、不排下次执行
schedule.server = { ...(schedule.server || {}), schedulerActive: false, staticDemo: true };
if (schedule.job) schedule.job.nextRunAt = null;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'static-data'), { recursive: true });

const snapshots = { data, topics, productions, bootstrap, schedule };
for (const [name, body] of Object.entries(snapshots)) {
  fs.writeFileSync(path.join(OUT, 'static-data', `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`  · static-data/${name}.json  ${(JSON.stringify(body).length / 1024).toFixed(0)} KB`);
}

// 前端资源
const PUB = path.join(ROOT, 'webui/public');
for (const f of ['app.js', 'style.css', 'static-mode.js']) {
  fs.copyFileSync(path.join(PUB, f), path.join(OUT, f));
}

let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
html = html
  .replace('href="/style.css"', 'href="style.css"')
  .replace('src="/app.js"', 'src="app.js"')
  .replace(
    '<script type="module" src="app.js"></script>',
    '<script src="static-mode.js"></script>\n  <script type="module" src="app.js"></script>',
  );
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// 媒体：只拷成片与封面，保留原始相对路径（app.js 静态模式用 media/<path>）
const media = new Set();
for (const p of productions.productions || []) {
  for (const ref of [p.video?.path, p.cover?.path, p.coverPortrait?.path]) {
    if (ref) media.add(ref);
  }
}
let bytes = 0;
for (const rel of media) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    console.warn(`  ! 跳过缺失媒体 ${rel}`);
    continue;
  }
  const dst = path.join(OUT, 'media', rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  bytes += fs.statSync(src).size;
  console.log(`  · media/${rel}  ${(fs.statSync(src).size / 1024).toFixed(0)} KB`);
}
console.log(`  媒体合计 ${(bytes / 1048576).toFixed(2)} MB，${media.size} 个文件`);

fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(
  path.join(OUT, 'README.md'),
  `# OPC 制作台 · 静态演示站

这个分支（\`gh-pages\`）只放构建好的静态站点，供 GitHub Pages / Vercel 托管。

- 数据快照生成时间：${data.dashboard?.generatedAt || '—'}
- 静态站构建时间：${new Date().toISOString()}
- 只读演示：选题、看板、成片、预检结果、数据接口与定时定点设置都是快照；写稿/渲染/真实投稿/Cookie/抓取需要本地运行
- 数据接口与定时定点**不使用 AI**：静态站只展示最近一次抓取结果，抓取本身必须本地跑确定性脚本
- 源码与完整功能：https://github.com/auulb/mediaOPC （main 分支）
- 本地运行：\`git clone\` 后 \`./webui/start.sh\` → http://127.0.0.1:4180

重新生成：\`node webui/build-static.mjs\`

## 在线地址

- Vercel: https://mediaopc.vercel.app
- GitHub Pages: https://auulb.github.io/mediaOPC/
`,
);

console.log(`\n✓ 静态站已生成：${path.relative(ROOT, OUT)}/  （直接双击 index.html 也能看）`);
