---
name: demo-slow
tags: [demo-slow]
adapter: exec
priority: 1
command: node -e "console.log('slow worker 开始');setTimeout(()=>{console.log('slow worker 结束')},25000)"
verify: node -e "process.exit(0)"
writes: [src/slow/**]
description: 演示用慢工人（跑 25 秒，用来试暂停）
---

演示用慢工人：故意跑 25 秒，方便在中台上点「暂停」。
