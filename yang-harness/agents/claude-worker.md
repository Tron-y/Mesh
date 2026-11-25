---
name: claude-worker
tags: [general, refactor, 重构]
adapter: claude-print
priority: 5
verify: node -e "process.exit(0)"
writes: []
description: Claude 通用工人
---

Claude 通用工人。把上面的 verify 换成这个项目真实的验收命令，闸门才有效。