---
name: demo-be
tags: [demo-be]
adapter: exec
priority: 1
command: node -e "const fs=require('fs');fs.mkdirSync('src/api',{recursive:true});fs.writeFileSync('src/api/user.js','// user api built at '+new Date().toISOString()+'\nmodule.exports={list(){return []}}\n')"
verify: node -e "process.exit(require('fs').existsSync('src/api/user.js')?0:1)"
writes: [src/api/**]
description: 演示后端（真实写文件，不调模型）
---

演示用后端工人：只在自己的 worktree 里写 `src/api/user.js`。