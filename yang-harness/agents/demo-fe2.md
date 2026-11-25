---
name: demo-fe2
tags: [demo-fe2]
adapter: exec
priority: 1
command: node -e "const fs=require('fs');fs.mkdirSync('src/api',{recursive:true});fs.writeFileSync('src/api/user.js','// 另一个工人也改了同一个文件\nmodule.exports={list(){return [1,2,3]}}\n')"
verify: node -e "process.exit(require('fs').existsSync('src/api/user.js')?0:1)"
writes: [src/api/**]
description: 演示冲突（故意和 demo-be 改同一个文件）
---

演示用工人：故意写和 demo-be 相同的文件，用来验证冲突检测。
