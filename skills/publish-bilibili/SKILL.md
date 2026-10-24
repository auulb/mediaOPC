---
name: publish-bilibili
description: 读取 ./input.json 的成片清单，先做发布预检（时长/大小/分辨率/标题/标签/敏感词/封面），通过后用 Playwright 打开 B 站投稿页发布；未登录时停下等人工扫码。产出发布记录写入 ./output.json。
---

# 发布到 B 站

这是一个**只按命令执行**的步骤，不需要你做任何调研或排查。预检已内置在发布脚本里。

## 允许做的全部动作

只运行这一条命令（`<skill目录>` = 本 SKILL.md 所在目录，用绝对路径），然后等待它返回：

```bash
node <skill目录>/../../plugins/publishers/bilibili/publish.mjs --input ./input.json --output ./output.json
```

## 严格禁止

- 禁止浏览仓库，禁止 `ls`/`find`/`rg`/`cat` 查看本 skill 目录与 `./input.json` 之外的任何文件（包括 scheduler/、docs/、其他 skill、仓库根目录的 `p*.md`）
- 禁止读 `publish.mjs` / `precheck.mjs` / `platform.json` 的源码
- 禁止单独运行 `precheck.mjs`、禁止运行 `node bin/opc`（该 CLI 尚未实现）
- 禁止手写、修补或重排 `output.json`，禁止改 `input.json` 绕开预检
- 禁止用账号密码、Cookie 注入等任何方式代替人工扫码

## 判定与结束（照做即可，不要追加调查）

| 退出码 | 含义 | 动作 |
|---|---|---|
| 0 | 已发布/已提交 | 读 `./output.json`，把 `url` 和 `platformVideoId` 告诉用户，结束 |
| 2 | 预检未通过，**未上传** | 读 `./output.json` 的 `precheck.checks`，列出未通过项，结束。**不要重试** |
| 1 | 失败 | 读 `./error.json` 的 `code`，按下表处理 |

`code` 处理：

| code | 动作 |
|---|---|
| `LOGIN_TIMEOUT` | 用户没在时限内扫码。结束并提示需重新扫码，**不要重试** |
| `PRECHECK_FAILED` | 同退出码 2，列出未通过项，结束 |
| `SELECTOR_NOT_FOUND` | 页面可能改版，已留截图。结束并建议人工发布 |
| `UPLOAD_FAILED` / `NETWORK_ERROR` | 最多重跑上面这条命令 1 次，仍失败则结束 |
| `INPUT_INVALID` / `UNKNOWN` | 结束并原样转述 `message` |

无论成功失败，脚本都已写好 `output.json` 和/或 `error.json`，你不需要补写任何文件。

## 人工扫码节点

- 发布脚本会打开浏览器并打印“请扫码”。这是唯一的人工节点，**必须等用户扫码**，不要结束进程、不要 kill 浏览器。
- 用户扫码成功后脚本自动继续；超时会返回 `LOGIN_TIMEOUT`，按上表处理，不要重试、不要换登录方式。
