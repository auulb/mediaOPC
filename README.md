# OPC 制作台 · 静态演示站

这个分支（`gh-pages`）只放构建好的静态站点，供 GitHub Pages / Vercel 托管。

- 数据快照生成时间：2026-10-24T09:45:46.145Z
- 只读演示：选题、看板、成片、预检结果都是快照；写稿/渲染/真实投稿需要本地运行
- 源码与完整功能：https://github.com/auulb/mediaOPC （main 分支）
- 本地运行：`git clone` 后 `./webui/start.sh` → http://127.0.0.1:4180

重新生成：`node webui/build-static.mjs`

## 在线地址

- Vercel: https://mediaopc.vercel.app
- GitHub Pages: https://auulb.github.io/mediaOPC/

