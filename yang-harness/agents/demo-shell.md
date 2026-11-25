---
name: demo-shell
tags: [demo]
adapter: exec
priority: 1
command: node -e "const p=process.env.YANG_PROMPT||'';console.log('demo worker 收到 prompt '+p.length+' 字符');console.log('含上游交接: '+/上游交接/.test(p))"
verify: node -e "process.exit(0)"
writes: []
description: 演示用工人（真实执行、真实闸门，不调用任何模型）
---

你是一个演示用工人：只验证 yang 的派发、交接注入与闸门机制是否工作。
