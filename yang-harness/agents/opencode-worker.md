---
name: opencode-worker
tags: [coder, general]
adapter: opencode-run
priority: 5
verify: node -e "process.exit(0)"
writes: []
description: OpenCode 通用工人
---

OpenCode 通用工人。把上面的 verify 换成这个项目真实的验收命令，闸门才有效。