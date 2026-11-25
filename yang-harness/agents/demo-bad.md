---
name: demo-bad
tags: [demo-bad]
adapter: exec
priority: 1
command: node -e "console.error('TypeError: cannot read properties of undefined (reading user)');console.error('  at src/api/user.js:42');process.exit(1)"
verify: node -e "process.exit(0)"
writes: [src/bad/**]
description: 演示用会报错的工人（stderr + 非 0 退出）
---

演示用失败工人：往 stderr 写错误并 exit 1，用来验证报错回显到对话。
