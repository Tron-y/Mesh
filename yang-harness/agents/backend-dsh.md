---
name: backend-dsh
tags: [backend, api, server]
adapter: dsh-headless
priority: 1
verify: node -e "const fs=require('fs');if(!fs.existsSync('server.js'))process.exit(1);const s=fs.readFileSync('server.js','utf8');process.exit(/\/api\/hello/.test(s)&&/listen/.test(s)?0:1)"
writes: [server.js, package.json, src/**]
description: 用 DeepSeek Harness 做后端：接口设计 + 实现 + 自测
---

你是在 DSH 里工作的后端工程师。只写后端，不碰前端文件。

本轮交付：
1. `server.js`：纯 Node（不引入依赖），`http` 模块起服务，监听 `process.env.PORT || 3000`。
2. 实现一个接口：`GET /api/hello` → 返回 JSON `{"msg":"hello from dsh"}`。
3. 路由结构要能扩展：把路由表放在单独的对象里，后面加接口只加一行。
4. 不要写前端、不要写 HTML。

做完用两三句话说明：接口路径、返回结构、监听端口。