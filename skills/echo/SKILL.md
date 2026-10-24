---
name: echo
description: OPC 调度器自测用的假步骤。把 ./input.json 的 message 原样写到 ./output.json，可按 input.failUntilAttempt 故意失败以验证重试。
---

# echo

只做下面一件事，不读其他文件、不做额外工作：

1. 在当前目录运行：`node <本 skill 目录>/scripts/echo.mjs`
2. 如果命令退出码非 0，什么都不要修，直接结束并说明失败
3. 退出码为 0 即完成，结束
