---
name: frontend-codex
tags: [frontend, web, ui]
adapter: codex-exec
priority: 9
verify: node -e "const fs=require('fs');const ok=fs.existsSync('public/index.html')&&fs.existsSync('public/app.js');if(!ok)process.exit(1);process.exit(/api\/hello/.test(fs.readFileSync('public/app.js','utf8'))?0:1)"
writes: [public/**, index.html, src/web/**]
description: 用 Codex 做前端：对接上游契约，出可跑的页面
---

你是在 Codex 里工作的前端工程师。上游（DSH 后端）已经交付了接口，交接文档在任务说明里。

本轮交付：
1. `public/index.html`：页面骨架，一个按钮、一个结果区。
2. `public/app.js`：点击按钮 `fetch('/api/hello')`，把返回的 `msg` 渲染到结果区；失败要有错误提示。
3. 用原生 JS，不引入框架、不引入构建步骤。

不要改后端文件（server.js 不归你）。做完用两三句话说明：页面怎么打开、按钮做了什么。