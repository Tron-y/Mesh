# Mesh 插件（DSH）· 开发计划

> 本文是「把 Mesh 做成 DeepSeek Harness 插件」的实施计划。
> 产品形态参考 [T3 Code](https://github.com/pingdotgg/t3code)，地基是现有 Mesh 引擎，
> 但交互模型和 T3 相反：**DSH 自己干活是常态，`@` 别的 agent 才是例外。**

---

## 0. 一句话

装完这个插件，DSH 就是那个驾驶舱：**默认自己干；想找人帮忙，就 `@codex` 派过去；派出去的活，在它自己的客户端里留得下痕迹。**

---

## 1. 已确认的设计决策

| # | 决策 | 具体做法 |
|---|---|---|
| 1 | **verify 两处都跑** | ① `@` 派活 → 硬闸门，不通过就判失败并返工；② DSH 自己干完 → 跑项目 verify，但**只提示不阻断**（在卡片上标 ✓/✗） |
| 2 | **`@` 支持并行** | `@codex @claude 各写一版` → 同一个任务派给两个 agent，各自 worktree，产出并排呈现 |
| 3 | **Codex 开着时排队补写** | 不做"提示你关掉"，而是写入队列；下次检测到 Codex 已关闭 → **自动补写留痕**，卡片状态从「留痕待补」变「已留痕」 |

第 3 条的理由：留痕写库要求 Codex 应用关闭（主进程 `ChatGPT.exe` 会覆盖我们写的状态）。
让人为了一次留痕去关应用，这个功能就不会有人用。**排队补写是唯一能活的方案。**

---

## 2. 定位：它和 T3、和现在的 Mesh 是什么关系

### 和 T3 Code 的关系

**参考产品骨架，不参考它的调度模型。**

| | T3 Code | Mesh 插件 |
|---|---|---|
| 一个线程 | 一个 agent | 一个线程，agent 可以换 |
| 谁选 agent | 人（开线程时选） | 人（`@` 指定）或调度者（模型自己判断） |
| 默认是谁 | 必须选 | **DSH 自己** |
| 留痕 | 不需要（它就是唯一界面） | **硬要求**（每个 agent 客户端里都要有） |

### 和现在的 Mesh 的关系

现在的 Mesh = 引擎 + 独立控制台。**引擎留，控制台退位。**

| 现有部件 | 去向 |
|---|---|
| `agents/*.md` 工人池 | ✅ 变成 `@` 菜单的数据源 |
| `adapterCommand`（codex/dsh/claude 命令） | ✅ 插件直接调用 |
| worktree 隔离 | ✅ 保留 |
| verify 闸门 | ✅ 保留（按决策 1 分两种用法） |
| 写 Codex/Claude 留痕（`linkCodexProject`、`makeCodexThreadVisible`） | ✅ **核心资产**，整个搬进插件 |
| `planByLLM`（LLM 拆活） | ⚠️ 降级：只在"一条消息多个 `@`"时用于拆分 |
| 波次 / 依赖图 | ⚠️ 降级：变成批量模式的内部机制 |
| 独立控制台 `orchestra/`（7788） | 📦 退役成调试台，不再作主界面 |

---

## 3. 架构：插件是遥控器，引擎是发动机

```
DSH 主进程（host）
 └─ Mesh 插件
     ├─ client 侧
     │    ├─ `@` 菜单：注册一组 agent 候选（codex / claude / dsh / cursor …）
     │    ├─ 派活卡片：工具调用的渲染器
     │    ├─ 右栏 tab：agent 池 / 当前任务 / 留痕入口
     │    └─ 会话流：每个 agent 的会话一行（仿 T3）
     └─ host 侧
          ├─ 工具：mesh_list_agents / mesh_dispatch / mesh_status / mesh_collect
          ├─ 留痕队列：~/.dsh/mesh/link-queue.json
          └─ spawn ──► node yang.mjs（子进程）
                          └─ adapter / worktree / verify / 留痕写入
```

### 三条硬原则

1. **零侵入**：不 `@` 的时候，插件完全不出场，DSH 的体验一点都不变。
2. **进程隔离**：2000 行引擎不进宿主进程。它卡死/崩溃，DSH 不受影响。调度器只做短操作 + 超时。
3. **插件薄、引擎厚**：插件的职责是「转达 + 呈现 + 留痕」，业务逻辑全在引擎里。

---

## 4. 扩展点对照（已在 DSH 包内核实）

| 要有能力 | 用哪个扩展点 | 依据 |
|---|---|---|
| `@` 里列出 agent | 输入触发流水线的 **已注册 source** | `dsh-client-ui-input-trigger`："光标处的 `/` 与 `@` 检测……把 pick 路由到已注册 source" |
| 模型能派活 | `defineTool` 注册类型化工具 | `dsh-tools`："工具作者使用 `defineTool` 声明类型化参数与输出" |
| 派活卡片怎么画 | 工具的自定义渲染 | `dsh-client-ui-tool` |
| 右栏面板 | `ctx.sidebarRightTabs` 注册 tab 类型 | `dsh-client-ui-sidebar-right` |
| 后台任务列表 | DSH 的 jobs 体系 | `dsh-client-ui-jobs` / `dsh-tool-jobs` |
| 新建会话选 agent | agent preset（Cordis YAML） | `dsh-agent-preset`："在 Cordis YAML 里声明 agent 能力组合" |
| 看改动 / diff | workspace changes | `dsh-workspace-changes` |
| 打包分发 | bundle + `engines.dsh` | `dsh-plugin-manager`：安装/启用/兼容性检查 |

> 以上都是 DSH `0.2.1-rc.3` 里实际存在的包，不是我推测的。

---

## 5. 接口契约

### 5.1 `@` 引用

用户在输入框里敲 `@` → 菜单出现「agent」组 → 选中后插入结构化引用：

```js
{ kind: 'agent', name: 'codex', label: 'codex', tags: ['前端'] }
```

发送时消息里同时带文本和引用。插件看到引用就直接派活，**不让模型猜**。

### 5.2 工具

```ts
mesh_list_agents(): { name, tags, available, adapter, reason? }[]
mesh_dispatch({ agent, task, cwd, worktree?, verify? }): { jobId, sessionHint }
mesh_status(jobId): { state, elapsedMs, verify, changedFiles }
mesh_collect(jobId): { output, changedFiles, diff, trace }
```

状态机：

```
queued → running → verifying → done
                      ↓
                   failed ──► (可一键退回同一 agent 重跑)
```

### 5.3 结果回灌

- 运行中：卡片上增量显示状态（跑了多久、当前在 verify 还是写文件）
- 结束：一次性工具结果，含改动文件、verify 结论、留痕位置

---

## 6. 留痕设计（本项目的核心机制）

### 6.1 目标

`@codex 写登录页` → 打开 Codex 客户端，侧边栏里有项目 `a`，里面有这条对话，标题是「写登录页 login.html」。

### 6.2 写什么

| 客户端 | 位置 | 关键动作 |
|---|---|---|
| Codex | `~/.codex/state_5.sqlite`（`threads` / `projects` / `project_roots`）+ `~/.codex/.codex-global-state.json` | 登记项目、把 thread 改成可见 |
| Claude | `~/.claude/projects/<encoded>/<uuid>.jsonl` | 会话文件本身就在，补项目归属 |
| DSH | `~/.dsh/sessions/<encoded>/` | 原生可见，只需给出跳转 |

Codex 的「可见三件套」（缺一样侧边栏就不显示）：

```sql
source         = 'vscode'
originator     = 'Codex Desktop'
has_user_event = 1
name = title = first_user_message = preview = <任务名>
```

### 6.3 排队补写（对应决策 3）

```
派活完成
  ├─ 检测 Codex 是否在运行（ChatGPT.exe 且路径含 OpenAI.Codex，或 codex.exe）
  │   ├─ 没运行 → 立刻写 → 标记 linked
  │   └─ 正在运行 → 写进队列 → 卡片显示「留痕待补（Codex 正开着）」
  └─ 队列 flush 时机（三个，取先到者）
      ① 插件启动时
      ② 插件发现 Codex 已退出（轻量轮询，30s 一次，只在队列非空时轮询）
      ③ 用户点卡片上的「现在补写」→ 若仍开着，提示先关
```

队列文件：

```json
// ~/.dsh/mesh/link-queue.json
[{ "family": "codex", "cwd": "D:\\project\\a", "threadId": "01a2…", "title": "写登录页 login.html", "at": "2026-11-26T12:00:00Z" }]
```

### 6.4 幂等与安全

- 以 `threadId` 为幂等键，已登记的直接跳过
- 每次写库前 `backupOnce()`（首次写时备份 sqlite + json，`.mesh-bak`）
- 写库失败不改数据、只报状态；**不允许半写**
- 队列文件损坏时按"空队列"处理并留日志，不阻断派活

---

## 7. 阶段划分

### P0 · 技术验证（1–2 天）

**做**：最小 host 插件（注册一个 `mesh_echo` 工具）+ 最小 client 插件（在 `@` 菜单加一组候选）。
**验收**：DSH 里输入 `@` 能看到 agent 组；模型能调用 `mesh_echo`。
**风险**：DSH 是 rc，文档不全（源码仓库的 docs 没随包发），约定要读 lib 反推。
**止损**：2 天内摸不通 → 改走 MCP 方案（工具面一致，只是挂载方式不同），不阻塞后续阶段。

### P1 · `@agent` 派活（2–3 天）

**做**：`@` → dispatch → 引擎在 worktree 跑 → 结果回灌；支持多个 `@` 并行（决策 2）。
**验收**：`@codex 写登录页` 真跑、真回结果；`@codex @claude 各写一版` 产生两份产出。
**风险**：流式输出回灌的粒度（是逐行回还是完成后一次性回）。

### P2 · 留痕（1–2 天）

**做**：快照 → diff 出新会话 → 可见化 → 队列补写（6.3）。
**验收**：打开 Codex 侧边栏，项目和对话都在；标题是任务名；排队场景能在关闭后自动补上。
**风险**：Codex 内部结构可能随版本变（这是唯一可能被上游打破的部分，必须容错）。

### P3 · 派活卡片 + verify 呈现（2 天）

**做**：卡片（徽标/任务/状态/耗时/verify/改动文件）+ 失败一键重跑 + 自己干时的 verify 提示。
**验收**：一眼能看出"派给谁、跑到哪、过没过"。

### P4 · T3 式会话流（3–4 天）

**做**：左栏每个 agent 的会话一行（徽标/状态/分支），右栏 Mesh tab（agent 池/任务/留痕）。
**验收**：像 T3 那样"列表即工作台"。
**风险**：这是纯前端活，占整个项目 1/3 时间。

### P5 · 打包（1 天）

**做**：bundle、`engines.dsh`、README、可选发市场。
**验收**：别人能一键装。

---

## 8. 里程碑

| 里程碑 | 时间 | 能干什么 |
|---|---|---|
| **M1** | 5–7 天 | `@` 派活 + 留痕可查（界面朴素，但核心价值成立） |
| M2 | 8–9 天 | 派活卡片，状态一眼可见 |
| M3 | 12–15 天 | T3 式会话流 + 可分发 |

**M1 是分水岭**：到那时它已经比"现在的 Mesh 控制台 + 手工开 Codex"有用。

---

## 9. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| DSH rc 版本 API 变动 | 插件可能要改 | 声明 `engines.dsh`；把 DSH 相关代码集中在一个 `dsh-adapter.ts` 里，改一处 |
| 插件跑在 host 进程 | 卡死拖挂 DSH | 所有 spawn 带超时；引擎走子进程 |
| Codex 库结构变化 | 留痕失效 | 容错 + 显式报错，绝不让它阻断派活 |
| `@` 解析歧义（`@codex` 是文件还是 agent） | 误派活 | 菜单插入结构化引用，不靠正则猜文本 |
| worktree 占磁盘 | 磁盘满 | 沿用 `yang` 的清理；插件显示占用 |
| verify 假阳性 | 假"完成" | 默认用项目真实命令；卡片显示退出码，不只显示 ✓ |

---

## 10. 未决问题（做到对应阶段再定）

1. 会话流是**改造 DSH 现有会话列表的行渲染**，还是**新开一个 Mesh tab**？（倾向后者，改动面小）
2. 并行两版怎么呈现：两条会话并排？还是一张卡片里左右两栏？
3. 插件叫什么：`dsh-mesh` / `mesh-plugin` / 别的？
4. 独立控制台退役后，`runs/` 里的历史数据要不要迁移到插件侧？

---

## 11. 下一步

P0 第一件事不是写代码，而是**花半天把两个约定读透**：

- `defineTool` 的参数/输出/超时/权限声明
- 输入触发的 source 注册接口（怎么让 `@` 菜单出现 agent 组）

读完立刻写最小插件验证。跑不通就按 P0 的止损条款改 MCP 方案。
