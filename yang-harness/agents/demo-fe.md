---
name: demo-fe
tags: [demo-fe]
adapter: exec
priority: 1
command: node -e "const fs=require('fs');fs.mkdirSync('src/web',{recursive:true});fs.writeFileSync('src/web/page.html','<h1>todo</h1>\n')"
verify: node -e "process.exit(require('fs').existsSync('src/web/page.html')?0:1)"
writes: [src/web/**]
description: 演示前端（真实写文件，不调模型）
---

演示用前端工人：只在自己的 worktree 里写 `src/web/page.html`。
