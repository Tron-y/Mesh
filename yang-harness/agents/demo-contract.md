---
name: demo-contract
tags: [demo-contract]
adapter: exec
priority: 1
command: node -e "const fs=require('fs');fs.mkdirSync('CONTRACT',{recursive:true});fs.writeFileSync('CONTRACT/openapi.yaml','openapi: 3.0.0\npaths:\n  /user:\n    get: {}\n')"
verify: node -e "process.exit(require('fs').existsSync('CONTRACT/openapi.yaml')?0:1)"
writes: [CONTRACT/**]
description: 演示契约冻结（只写 CONTRACT/openapi.yaml）
---

演示用契约工人：只写 `CONTRACT/openapi.yaml`，供后端与前端并行读取。
