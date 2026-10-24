# OPC 运营动画程序设计文档

## 一、项目概述

### 1.1 项目定位
OPC (Operational Production Center) 是一个基于 AI 的动画媒体创作工作台，以"像游戏一样运营动画媒体"为理念，实现从数据分析、主题策划到内容创作、自动发布的全流程自动化。

### 1.2 核心特点
- **可扩展性**：基于 pi 的 skill 插件体系，支持任意工作流扩展
- **定点触发**：cron 定时 + 事件驱动的混合调度
- **自动化**：端到端无人值守，仅发布环节保留人工审核点
- **上下文隔离**：每步骤独立进程、独立工作区、独立日志
- **数据驱动**：全流程数据可追溯、可分析、可优化

### 1.3 技术栈
- **调度层**：Node.js + node-cron + child_process
- **执行层**：pi coding agent + custom skills
- **数据层**：JSON 文件存储 + SQLite（可选）
- **创作层**：remotion / hyperframes / hypit
- **发布层**：Playwright / Puppeteer + 扫码交互

---

## 二、架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                       调度控制中心                            │
│  (Scheduler: cron + queue + process manager)                │
└──────────────┬──────────────────────────────────────────────┘
               │
       ┌───────┴────────┐
       │   步骤隔离层    │
       │ (每步新终端+pi)  │
       └───────┬────────┘
               │
    ┌──────────┼──────────┐
    │          │          │
┌───▼───┐  ┌──▼───┐  ┌──▼───┐
│步骤 1  │  │步骤 2 │  │步骤 N │
│新终端  │  │新终端 │  │新终端 │
│新 pi   │  │新 pi  │  │新 pi  │
│新 cwd  │  │新 cwd │  │新 cwd │
└───┬───┘  └──┬───┘  └──┬───┘
    │         │         │
    └─────────┼─────────┘
              │
    ┌─────────▼─────────┐
    │   数据交换层       │
    │ (input/output.json)│
    └───────────────────┘
```

### 2.2 模块设计

#### 模块 0：调度与隔离
**职责**：流程编排、定时触发、进程隔离

**核心组件**：
```javascript
// scheduler/core.js
class TaskScheduler {
  // 定时任务注册
  registerCronJob(schedule, pipeline)
  
  // 单步执行：新终端 + 新 pi 进程
  async executeStep(step, inputFile, outputFile)
  
  // 失败重试策略
  retryPolicy(step, error, attempt)
  
  // 进程隔离配置
  isolationConfig(step) {
    return {
      cwd: `/workspace/${step.id}`,
      env: { ...process.env, STEP_ID: step.id },
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  }
}
```

**关键设计**：
- 每步骤创建独立工作目录：`workspace/{pipeline_id}/{step_id}/{timestamp}/`
- 通过 `AppleScript` (macOS) 或 `gnome-terminal` (Linux) 拉起新终端
- 步骤间通过文件传递：`{step_id}/output.json` → `{next_step_id}/input.json`
- 日志独立：`logs/{pipeline_id}/{step_id}/{timestamp}.log`

#### 模块 1：外部数据接口
**职责**：热门数据采集、竞品分析、合规过滤

**数据源插件**：
```javascript
// plugins/data-sources/
├── youtube-trends.js       // YouTube 热门
├── bilibili-hot.js         // B站热门
├── tiktok-trends.js        // TikTok 热门
├── competitor-analyzer.js  // 同领域博主数据
└── internal-metrics.js     // 自有数据统计
```

**统一 Schema**：
```json
{
  "dataSource": "youtube",
  "timestamp": "2024-01-15T10:00:00Z",
  "items": [
    {
      "id": "abc123",
      "title": "主题标题",
      "views": 1000000,
      "likes": 50000,
      "comments": 2000,
      "tags": ["AI", "动画"],
      "publishDate": "2024-01-14",
      "channel": {
        "name": "优秀博主",
        "subscribers": 500000
      },
      "metrics": {
        "engagement": 0.052,
        "velocity": "rising"
      }
    }
  ]
}
```

**Pi Skill 示例**：
```javascript
// skills/fetch-youtube-trends.js
export default {
  name: 'fetch-youtube-trends',
  async execute({ input, output }) {
    const api = new YouTubeAPI(process.env.YOUTUBE_API_KEY);
    const trends = await api.getTrending({
      category: input.category,
      region: input.region,
      limit: input.limit || 50
    });
    
    await output.write({
      dataSource: 'youtube',
      timestamp: new Date().toISOString(),
      items: trends.map(transformToSchema)
    });
  }
}
```

#### 模块 2：数据看板
**职责**：指标可视化、趋势分析、成本统计

**看板文件结构**：
```
dashboard/
├── external_trends.json      # 外部热门数据汇总
├── competitor_analysis.json  # 竞品分析
├── internal_performance.json # 自有内容表现
├── token_usage.json          # Token 消耗统计
└── task_status.json          # 任务执行状态
```

**关键指标**：
```json
{
  "dashboard": {
    "externalTrends": {
      "topTopics": [
        { "topic": "AI绘画", "heat": 95, "growth": "+25%" }
      ],
      "flowDirection": {
        "youtube": 45,
        "tiktok": 35,
        "bilibili": 20
      }
    },
    "internalPerformance": {
      "episodes": [
        {
          "id": "ep_001",
          "title": "主题A",
          "views": 50000,
          "engagement": 0.045,
          "roi": 2.3
        }
      ],
      "avgEngagement": 0.038,
      "topPerformers": ["ep_005", "ep_012"]
    },
    "tokenUsage": {
      "today": 150000,
      "thisWeek": 850000,
      "budget": 2000000,
      "utilizationRate": 0.425
    }
  }
}
```

**Pi Skill 示例**：
```javascript
// skills/generate-dashboard.js
export default {
  name: 'generate-dashboard',
  async execute({ input, output }) {
    // 读取多数据源
    const external = await readJSON('data/external_trends.json');
    const internal = await readJSON('data/internal_performance.json');
    const tokens = await readJSON('data/token_usage.json');
    
    // AI 分析
    const analysis = await aiAnalyze({
      external,
      internal,
      tokens,
      prompt: '分析流量趋势，找出高ROI主题特征'
    });
    
    // 输出看板文件
    await output.write({
      ...analysis,
      generatedAt: new Date().toISOString()
    });
  }
}
```

#### 模块 3：主题引擎
**职责**：AI 主题推荐、创作计划生成

**输入**：看板分析结果
**输出**：主题列表 + 创作计划

**主题推荐流程**：
```
看板数据 → AI 分析 → 主题候选 → 人工审核（可选）→ 创作计划
```

**主题存储格式**：
```json
{
  "themes": [
    {
      "id": "theme_001",
      "title": "AI动画制作教程",
      "source": "external",
      "confidence": 0.85,
      "reason": "YouTube 热度上升25%，竞品平均播放量100万+",
      "targetPlatform": ["youtube", "bilibili"],
      "estimatedCost": {
        "tokens": 50000,
        "time": "2小时",
        "budget": "$15"
      },
      "creationPlan": {
        "steps": [
          {
            "step": "script",
            "tool": "gpt-4",
            "duration": "10分钟"
          },
          {
            "step": "storyboard",
            "tool": "midjourney",
            "duration": "30分钟"
          },
          {
            "step": "animation",
            "tool": "remotion",
            "duration": "1小时"
          }
        ]
      }
    }
  ]
}
```

**Pi Skill 示例**：
```javascript
// skills/recommend-themes.js
export default {
  name: 'recommend-themes',
  async execute({ input, output }) {
    const dashboard = await readJSON(input.dashboardFile);
    
    // AI 推荐外部主题
    const externalThemes = await aiRecommend({
      data: dashboard.externalTrends,
      count: 3,
      prompt: '基于热门趋势推荐3个主题，带理由和置信度'
    });
    
    // AI 推荐内部优化主题
    const internalThemes = await aiRecommend({
      data: dashboard.internalPerformance,
      count: 3,
      prompt: '基于历史表现推荐3个改进主题'
    });
    
    await output.write({
      themes: [...externalThemes, ...internalThemes],
      generatedAt: new Date().toISOString()
    });
  }
}
```

#### 模块 4：创作引擎
**职责**：脚本生成、素材制作、动画渲染

**支持工具**：
- **remotion**：React 组件式动画
- **hyperframes**：AI 驱动的视频生成
- **hypit**：文本到视频
- **自定义 skill**：FFmpeg、ImageMagick 等

**创作流程**：
```
主题 → 脚本 → 分镜 → 素材 → 动画 → 渲染 → 成片
```

**工作目录结构**：
```
workspace/creation/{theme_id}/
├── input.json           # 主题和计划
├── script.md            # AI 生成脚本
├── storyboard.json      # 分镜配置
├── assets/              # 素材目录
│   ├── images/
│   ├── audio/
│   └── video/
├── remotion-project/    # Remotion 项目
└── output/
    ├── draft.mp4        # 草稿
    └── final.mp4        # 成片
```

**Pi Skill 示例**：
```javascript
// skills/create-animation.js
export default {
  name: 'create-animation',
  async execute({ input, output }) {
    const theme = await readJSON(input.themeFile);
    
    // 1. 生成脚本
    const script = await aiGenerate({
      prompt: `为主题"${theme.title}"生成90秒动画脚本`,
      model: 'gpt-4'
    });
    await writeFile('script.md', script);
    
    // 2. 生成分镜
    const storyboard = await aiGenerate({
      prompt: `基于脚本生成分镜：${script}`,
      model: 'gpt-4',
      format: 'json'
    });
    await writeJSON('storyboard.json', storyboard);
    
    // 3. 调用 remotion 渲染
    await exec(`
      cd remotion-project &&
      npm run build -- --props='${JSON.stringify(storyboard)}'
    `);
    
    await output.write({
      status: 'success',
      files: {
        script: 'script.md',
        storyboard: 'storyboard.json',
        video: 'output/final.mp4'
      }
    });
  }
}
```

#### 模块 5：发布引擎
**职责**：多平台发布、扫码登录、数据回写

**发布流程**：
```
成片 → 预检 → 平台登录（扫码）→ 上传 → 填写信息 → 发布 → 记录回写
```

**平台适配**：
```javascript
// plugins/publishers/
├── youtube-publisher.js
├── bilibili-publisher.js
├── tiktok-publisher.js
└── base-publisher.js
```

**发布记录格式**：
```json
{
  "publishId": "pub_001",
  "themeId": "theme_001",
  "platform": "youtube",
  "status": "published",
  "publishedAt": "2024-01-15T18:00:00Z",
  "url": "https://youtube.com/watch?v=xxx",
  "metadata": {
    "title": "AI动画制作教程",
    "description": "...",
    "tags": ["AI", "动画", "教程"],
    "thumbnail": "thumbnail.jpg"
  },
  "initialMetrics": {
    "views": 0,
    "likes": 0
  }
}
```

**Pi Skill 示例**：
```javascript
// skills/publish-to-youtube.js
export default {
  name: 'publish-to-youtube',
  async execute({ input, output }) {
    const video = input.videoFile;
    const metadata = input.metadata;
    
    // 1. 启动浏览器
    const browser = await launchBrowser({ headless: false });
    const page = await browser.newPage();
    
    // 2. 导航到 YouTube Studio
    await page.goto('https://studio.youtube.com');
    
    // 3. 等待扫码登录（保留人工节点）
    await page.waitForSelector('#upload-button', { timeout: 300000 });
    
    // 4. 上传视频
    await page.click('#upload-button');
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(video);
    
    // 5. 填写信息
    await page.type('#title', metadata.title);
    await page.type('#description', metadata.description);
    
    // 6. 发布
    await page.click('#publish-button');
    await page.waitForSelector('.success-message');
    
    // 7. 获取发布 URL
    const url = await page.url();
    
    await output.write({
      status: 'published',
      url,
      publishedAt: new Date().toISOString()
    });
  }
}
```

---

## 三、数据流设计

### 3.1 步骤间数据传递

```
Step 1: fetch-data
  output.json → { dataSource, items[], timestamp }
                     ↓
Step 2: generate-dashboard
  input.json ← Step 1 output
  output.json → { dashboard, analysis }
                     ↓
Step 3: recommend-themes
  input.json ← Step 2 output
  output.json → { themes[], creationPlans[] }
                     ↓
Step 4: create-animation
  input.json ← Step 3 output
  output.json → { videoFile, metadata }
                     ↓
Step 5: publish-video
  input.json ← Step 4 output
  output.json → { publishRecord }
                     ↓
Database / Dashboard Update
```

### 3.2 文件组织结构

```
opc2/
├── scheduler/              # 调度器
│   ├── core.js
│   ├── cron-jobs.js
│   └── pipeline-configs/
├── skills/                 # Pi skills
│   ├── fetch-data/
│   ├── analyze-data/
│   ├── recommend-themes/
│   ├── create-animation/
│   └── publish-video/
├── plugins/                # 数据源和发布平台插件
│   ├── data-sources/
│   └── publishers/
├── workspace/              # 每步骤独立工作区
│   ├── {pipeline_id}/
│   │   └── {step_id}/
│   │       ├── input.json
│   │       ├── output.json
│   │       └── ...
├── data/                   # 持久化数据
│   ├── external_trends.json
│   ├── internal_performance.json
│   ├── themes.json
│   └── publish_records.json
├── logs/                   # 日志
│   └── {pipeline_id}/
│       └── {step_id}/
└── config/
    ├── pipeline.yaml       # 流程配置
    └── schedule.yaml       # 定时任务配置
```

---

## 四、调度与隔离实现

### 4.1 新终端拉起

调度器不把命令拼进 AppleScript 字符串，而是为每步生成一个 `run.sh`，终端只执行这个脚本路径，避免引号注入。`run.sh` 结束时写 `exit_code` 文件，调度器靠它判断完成，不靠终端窗口状态。

```javascript
// scheduler/terminal.js
import { execFile } from 'node:child_process';

export function launchInNewTerminal(runScript) {
  if (process.platform === 'darwin') {
    // runScript 由调度器生成，路径只含 [a-zA-Z0-9_/-.]
    const as = `tell application "Terminal" to do script "bash ${runScript}"`;
    execFile('osascript', ['-e', as]);
  } else {
    execFile('gnome-terminal', ['--', 'bash', runScript]);
  }
}
```

无图形界面（服务器、CI）时退化为 `tmux new-window` 或直接 `spawn` 后台进程，隔离语义不变。

### 4.2 Pi 进程隔离

pi 没有 `execute-skill` 子命令。单步执行用 pi 的一次性模式：`-p`（跑完退出）+ `--mode json`（事件流可解析 token）+ `--no-session`（不留会话，不跨步带上下文）+ `-ns --skill <dir>`（只加载本步 skill，屏蔽全局 skill）。

生成的 `run.sh`：

```bash
#!/usr/bin/env bash
# workspace/{run_id}/{step_id}/attempt-{n}/run.sh
set -uo pipefail
cd "$(dirname "$0")"
export OPC_STEP_ID="theme-recommend" OPC_RUN_ID="20240115-0900"

pi -p --mode json --no-session \
   -ns --skill /path/to/opc2/skills/recommend-themes \
   --tools read,write,bash \
   "/skill:recommend-themes 读取 ./input.json，按 skill 要求把结果写到 ./output.json，完成后退出" \
   > events.jsonl 2> stderr.log
echo $? > exit_code
```

调度器侧：

```javascript
async function executeStepInIsolation(step, inputFile, attempt) {
  const cwd = path.join(ROOT, 'workspace', step.runId, step.id, `attempt-${attempt}`);
  await fs.mkdir(cwd, { recursive: true });
  await fs.copyFile(inputFile, path.join(cwd, 'input.json'));
  await fs.writeFile(path.join(cwd, 'run.sh'), renderRunScript(step), { mode: 0o755 });

  launchInNewTerminal(path.join(cwd, 'run.sh'));
  const code = await waitForFile(path.join(cwd, 'exit_code'), step.timeout);

  // 退出码 0 不够，还要校验 output.json 符合 schema
  const output = await validateJson(path.join(cwd, 'output.json'), step.outputSchema);
  const usage = sumUsage(path.join(cwd, 'events.jsonl')); // 汇总 message_end 的 usage.totalTokens / cost.total
  await appendTokenLedger(step, usage);
  return { code, output };
}
```

要点：
- 每次重试用新的 `attempt-n` 目录，失败现场保留，可复盘
- 判定成功 = 退出码 0 且 `output.json` 通过 schema 校验
- token 消耗从 `events.jsonl` 解析，写入 `data/token_ledger.jsonl`，供看板 2.3 使用

### 4.3 失败重试策略

```javascript
const retryPolicy = {
  maxAttempts: 3,
  backoff: 'exponential', // 1s, 2s, 4s
  retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'API_RATE_LIMIT']
};

async function executeWithRetry(step, inputFile) {
  for (let i = 0; i < retryPolicy.maxAttempts; i++) {
    try {
      return await executeStepInIsolation(step, inputFile);
    } catch (error) {
      if (!retryPolicy.retryableErrors.includes(error.code)) {
        throw error;
      }
      await sleep(Math.pow(2, i) * 1000);
    }
  }
  throw new Error(`Step ${step.id} failed after ${retryPolicy.maxAttempts} attempts`);
}
```

---

## 五、定时任务配置

### 5.1 Cron 配置文件

```yaml
# config/schedule.yaml
schedules:
  - name: daily-trends-analysis
    cron: "0 9 * * *"  # 每天 9:00
    pipeline: trends-analysis
    enabled: true
    
  - name: theme-recommendation
    cron: "0 10 * * *"  # 每天 10:00
    pipeline: theme-recommendation
    enabled: true
    dependencies:
      - daily-trends-analysis
    
  - name: content-creation
    cron: "0 14 * * MON,WED,FRI"  # 每周一三五 14:00
    pipeline: content-creation
    enabled: true
    dependencies:
      - theme-recommendation
    
  - name: publish-video
    cron: "0 18 * * *"  # 每天 18:00
    pipeline: publish-video
    enabled: true
    manual_approval: true  # 需要人工确认
```

### 5.2 Pipeline 配置文件

```yaml
# config/pipeline.yaml
pipelines:
  trends-analysis:
    steps:
      - id: fetch-youtube
        skill: fetch-youtube-trends
        timeout: 300
        
      - id: fetch-bilibili
        skill: fetch-bilibili-hot
        timeout: 300
        
      - id: fetch-competitors
        skill: analyze-competitors
        timeout: 600
        
      - id: generate-dashboard
        skill: generate-dashboard
        depends_on: [fetch-youtube, fetch-bilibili, fetch-competitors]
        timeout: 300
        
  theme-recommendation:
    steps:
      - id: recommend
        skill: recommend-themes
        input: data/dashboard.json
        timeout: 600
        
  content-creation:
    steps:
      - id: generate-script
        skill: generate-script
        timeout: 300
        
      - id: create-animation
        skill: create-animation-remotion
        depends_on: [generate-script]
        timeout: 7200
        
  publish-video:
    steps:
      - id: publish-youtube
        skill: publish-to-youtube
        manual_approval: true
        timeout: 1800
        
      - id: publish-bilibili
        skill: publish-to-bilibili
        manual_approval: true
        timeout: 1800
```

---

## 六、扩展性设计

### 6.1 插件系统

**数据源插件接口**：
```javascript
// plugins/data-sources/base.js
export class DataSourcePlugin {
  constructor(config) {
    this.config = config;
  }
  
  async fetch(params) {
    throw new Error('Must implement fetch()');
  }
  
  transform(rawData) {
    // 转换为统一 schema
    throw new Error('Must implement transform()');
  }
  
  async rateLimit() {
    // 限速逻辑
  }
}
```

**发布平台插件接口**：
```javascript
// plugins/publishers/base.js
export class PublisherPlugin {
  async login(credentials) {}
  async upload(video, metadata) {}
  async publish(uploadId) {}
  async getMetrics(videoId) {}
}
```

### 6.2 自定义 Skill 开发

> 说明：前文各模块中的 `export default { execute() }` 是逻辑示意。实际落地时，pi skill 是一个含 `SKILL.md` 的目录（Agent Skills 规范），确定性逻辑放进 `scripts/`，由 pi 用 bash 调用；AI 判断（选题、写脚本、填标签）留给 pi 本身。

```text
skills/recommend-themes/
├── SKILL.md
├── schemas/
│   ├── input.schema.json
│   └── output.schema.json
└── scripts/
    └── validate.mjs        # node scripts/validate.mjs output.json
```

```markdown
---
name: recommend-themes
description: 读取看板文件，推荐 3 个外部主题和 3 个内部主题。用于 OPC 主题引擎步骤。
---

# 主题推荐

1. 只读 ./input.json 及其中列出的文件，不读其他目录
2. 外部主题 3 个、内部主题 3 个，每个含 reason / confidence(0-1) / targetPlatform / estimatedCost
3. 结果写入 ./output.json，结构见 schemas/output.schema.json
4. 运行 `node <skill目录>/scripts/validate.mjs ./output.json`，不通过则修正后重跑
5. 校验通过后结束，不做额外工作
```

规则：
- 每个 skill 必须自带 `input/output.schema.json` 和 `validate` 脚本
- 调用外部 API 的代码写在 `scripts/` 里，API Key 由调度器按步注入 env，不写进 skill
- 新增步骤 = 新增 skill 目录 + 在 `pipeline.yaml` 登记，调度器无需改代码

---

## 七、监控与运维

### 7.1 日志系统

**日志级别**：
- `ERROR`: 步骤失败、重试耗尽
- `WARN`: 重试、超时、限速
- `INFO`: 步骤开始/结束、数据同步
- `DEBUG`: 详细执行信息

**日志格式**：
```json
{
  "timestamp": "2024-01-15T10:05:32Z",
  "level": "INFO",
  "pipelineId": "trends-analysis-20240115",
  "stepId": "fetch-youtube",
  "message": "Step completed successfully",
  "duration": 45.3,
  "metadata": {
    "itemsFetched": 50,
    "tokensUsed": 1200
  }
}
```

### 7.2 监控指标

**关键指标**：
- Pipeline 成功率
- 平均执行时间
- Token 消耗速率
- 失败重试次数
- 发布成功率

**告警规则**：
- Pipeline 连续失败 3 次
- Token 消耗超预算 80%
- 单步骤执行超时 2 倍阈值

---

## 八、成本控制

### 8.1 Token 预算管理

```javascript
// config/token-budget.js
export const tokenBudget = {
  daily: 500000,
  weekly: 3000000,
  monthly: 10000000,
  
  alertThresholds: {
    warning: 0.8,  // 80%
    critical: 0.95 // 95%
  },
  
  stepLimits: {
    'fetch-data': 5000,
    'generate-dashboard': 10000,
    'recommend-themes': 50000,
    'generate-script': 100000,
    'create-animation': 200000
  }
}
```

### 8.2 成本优化策略

- **缓存机制**：热门数据缓存 1 小时
- **模型选择**：分析用 gpt-3.5，创作用 gpt-4
- **批量处理**：多主题打包推荐
- **增量更新**：仅拉取变化数据

---

## 九、安全与合规

### 9.1 数据安全

- API Key 存储于环境变量或密钥管理服务
- 敏感数据加密存储
- 日志脱敏处理

### 9.2 内容合规

- 发布前 AI 审核（敏感词、版权）
- 人工审核节点（扫码发布）
- 内容溯源记录

---

## 十、迭代路线图

### Phase 1：核心框架（2周）
- [ ] 调度器实现
- [ ] 步骤隔离机制
- [ ] 数据流设计
- [ ] 基础 skill 开发

### Phase 2：数据模块（1周）
- [ ] 外部数据接口集成
- [ ] 看板生成
- [ ] 主题推荐引擎

### Phase 3：创作模块（2周）
- [ ] Remotion 集成
- [ ] 脚本生成 skill
- [ ] 素材管理

### Phase 4：发布模块（1周）
- [ ] YouTube 发布器
- [ ] Bilibili 发布器
- [ ] 数据回写

### Phase 5：优化迭代（持续）
- [ ] 监控告警
- [ ] 性能优化
- [ ] 成本控制
- [ ] 新平台接入

---

## 附录

### A. 参考资料
- [Remotion 文档](https://remotion.dev)
- [Hyperframes GitHub](https://github.com/heygen-com/hyperframes)
- [Hypit GitHub](https://github.com/hypit-ai/hypit)
- Pi 文档：本机 `@earendil-works/pi-coding-agent/docs`（cli.md、skills.md、json.md）

### B. 术语表
- **Pipeline**: 完整的自动化流程（如趋势分析 pipeline）
- **Step**: Pipeline 中的单个步骤
- **Skill**: Pi 可执行的技能单元
- **Isolation**: 进程、工作区、上下文的物理隔离
- **Dashboard**: 数据看板，汇总各类指标
- **Theme**: 创作主题，由 AI 推荐生成

### C. FAQ
**Q: 为什么每步都要新终端？**
A: 物理隔离确保上下文完全独立，避免状态污染，失败不影响其他步骤。

**Q: 文件传递会不会很慢？**
A: JSON 文件极小（KB 级），传递开销可忽略；好处是可追溯、可调试。

**Q: 如何处理长时间任务？**
A: 设置合理 timeout，超时自动重试；对于渲染等耗时任务，可拆分为多步。

**Q: 扫码环节如何自动化？**
A: 首次扫码后保存 cookie/session，7-30 天有效期内免扫码；过期需人工介入。
