---
name: demo-codex
tags: [demo-codex]
adapter: codex-exec
priority: 1
verify: node -e "process.exit(require('fs').existsSync('src/web/hello.txt')?0:1)"
writes: [src/web/**]
description: 真 Codex 工人（调 codex exec，做一个人能验收的小改动）
---

你是前端工程师，用 Codex 干活。

本轮任务很小：在 `src/web/` 下创建 `hello.txt`，内容就是一行 `hello from codex`。
不要改别的文件，不要跑构建。做完用一句话说明即可。
