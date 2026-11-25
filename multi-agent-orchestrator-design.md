# 多 Agent 调度：Team + Bridge + 闸门（v2）

> 修正版。v1 把方案想成"外部中台服务调度多个 CLI"。v2 按你的真实意图重做：**一个项目 = 一个 Lead agent（调度者），DSH / Codex / Claude / QA 都是它 roster 里的 teammate，你在 Lead 的界面里看它们互相发消息、互相唤醒、推进同一个任务板。**

---

## 0. 核心事实：这个原语 DSH 已经内置

在本机安装包 `app.asar` 里实测存在（不是猜的）：

| 包 | 说明（原文） |
|---|---|
| `dsh-experimental-agent-team` | "为一个会话提供 **Lead**、**具名 teammate**、**直接 inbox 消息**和**持久共享任务板**" |
| `dsh-experimental-tool-agent-team` | 给模型的工具：创建 teammate、发消息、领任务、改任务 |
| `dsh-experimental-client-ui-agent-team` | "Web **Agent Teams roster**、**task board**、**teammate navigation**" |

也就是说，你描述的这些东西**已经有实现**，而且是持久化 + 有 DAG + 有 Web 面板：

- **Lead**：每个会话天然是一个隐式 Team 的 Lead，`TeamId == SessionId`。
- **teammate**：具名、永不复用名字、可 `fresh`（无记忆）或 `fork`（继承 Lead 已完成轮次）。
- **消息**：任何成员都能发给任何成员或 Lead，投递到目标 **inbox**（`MessageId` 回执）；inactive 的目标会被**冷恢复唤醒**。
- **任务板**：任务带 `依赖`、`writeScopes`（写入范围提示）、owner claim/complete/reopen；**全部依赖完成才可 claim**；每次变更是 CAS（`expectedRevision`），过期写入被拒绝。
- **roster 状态**：`running` / `inactive` / `provisioning` / `failed`。
- **Web 面板**：roster + 任务板 + 点进某个 teammate 看它自己的会话。

所以**你不需要先做一个中台后台**，你需要做的是：把"外部 CLI agent 的身体"塞进 Teammate 这个槽位，再加一道证据闸门。

---

## 1. 你描述的流程 → DSH 语义映射

| 你的说法 | 落地成什么 |
|---|---|
| "新建一个项目，它才是调度 agent" | 一个 DSH 会话（Lead），cwd = 项目路径，Team 隐式存在 |
| "DSH 是子 agent" | teammate `backend`，类型可分 native（DSH 内部 spawned）或 bridge（外部进程） |
| "Codex 也是子 agent" | teammate `frontend`，body = `codex exec` 进程 |
| "DSH 通知 Codex：后端好了，开始前端" | `sendMessage(from: backend, to: frontend, ...)` → 进 frontend 的 inbox → 唤醒它 |
| "Codex 开发完再有个 agent 做联调" | teammate `qa`，任务 `T3 联调` 依赖 `T1, T2`，依赖满足后 qa 才可 claim |
| "我在调度 agent 里看到它们互相通信" | Lead 会话的 roster/任务板 + 各 teammate 会话；**跨成员的合并流水需要自己拼**（见 §6） |

---

## 2. 物理真相（别被"对话"的观感骗了）

**Codex / Claude 不是常驻在线的东西，它们是进程。**

所以"DSH 给 Codex 发消息"在物理上是这条链：

```
backend.sendMessage(to: frontend, ...)
   → Team 把消息写进 frontend 的 inbox，把 frontend 从 inactive 唤醒
   → frontend 这一轮跑起来，它的"身体"是：
        bridge.run(`codex exec "<prompt>" --json --cd <wt>`)
   → codex 进程启动、干活、退出
   → bridge 把 stdout 事件流解析成结构化回执，作为 frontend 的发言发出
```

观感 = 群聊；物理 = **事件驱动的进程调度**。这个区别决定了三件事：

1. **必须有 ack**：README 明说"成功表示 inbox 接收，**不表示模型已处理或已完成**"。所以每条 handoff 要 `inbox_id → started → finished(exit_code) → verified(gate)` 四态。
2. **必须幂等**：Team 不做发送重试、不去重。你的 bridge 自己维护 `(task_id, attempt)` 幂等键，否则重放会重复执行。
3. **冷启动成本是真的**：每次唤醒 = 一次进程启动（codex 冷启动几秒 + 无会话记忆）。要"真在线"，只有两条路：
   - Claude Code：`claude --bg`（后台会话，返回 id）+ `claude attach/logs/stop/agents` + `--input-format stream-json` → **可做成常驻、可持续投喂消息**（本机 `claude --help` 已确认这些 flag）；
   - Codex：需要 `codex app-server`（常驻 JSON-RPC）——本机未安装，装后验证；
   - DSH 自己：native teammate 本来就是常驻的，不需要 bridge。

**结论**：L1 = DSH native teammate（最拟真）；L2 = `claude --bg` 常驻；L3 = `codex exec` / `claude -p` 一次性（最便宜、最稳，但有冷启动与无记忆）。同一个 roster 里可以混用，按任务重要性选等级。

---

## 3. 关键硬约束（来自官方 README 的"已知限制"，会直接决定你的架构）

| 约束 | 后果 | 你的对策 |
|---|---|---|
| **单进程、共享 checkout**，不提供 worktree/远端成员/merge/文件锁 | 两个 teammate 同时改同一文件会互相踩 | ① 用任务板 `writeScopes` 分工 + 串行化；② 或让 bridge 自己 `git worktree add` 到子目录里干活，再交回（但 Team 层面看不到这个隔离） |
| **writeScopes 仅作提示**，不阻止写入 | 有 Bash/代码生成器就能绕过 | 靠闸门 + 最终 diff 检查兜底，别指望提示能防 |
| **owner 不会自动释放**（inactive/中断/进程退出/失败都不释放） | 任务板会卡在"某人手里" | 自己在 bridge 里做超时回收 + Lead 定期 reconcile |
| **不支持嵌套 Team**，扁平、只有 Lead 能建/中断 | 不能有"子团队"；分层要靠任务依赖表达 | 用任务 DAG 表达层级，不要想着套娃 |
| **无发送重试、不去重、不保证同目标顺序** | 消息可能丢/重 | 幂等键 + 事件日志重放 + 显式重发 |
| **markdown 消息上限 64KB** | 大 diff 塞不进去 | 消息只放"结论 + 路径"，大文件走文件系统（见 §5） |

**最重要的一条**：这个 Team 是"一个工作目录里的协作"，不是"并行隔离开发"。你原来设想的"DSH 做后端、Codex 做前端同时进行"，在 Team 模型里必须靠**目录/文件分区**（writeScopes）实现，不能靠 worktree 隔离。要真隔离并行，就得绕到外部进程层自己管 worktree——那就是 v1 的方案，会失去"一个地方看对话"的便宜。

---

## 4. 三条路线，选一条

### 路线 A：全 DSH 原生（最拟真、最快见效）
- Lead = 项目会话；`backend`/`qa` 是 native teammate（同进程、真常驻、真收消息）；`frontend` 是 bridge teammate（body = codex）。
- 你看的东西：现成的 roster + 任务板 + 点进每个 teammate 看对话。
- 代价：共享 checkout，不能并行改同一文件；codex 每次冷启动。
- **建议：第一版就走这条，1 天内能把"后端 → 通知前端 → 前端 → 联调"整条链路演出来。**

### 路线 B：外部中台（隔离强、拟真度自建）
- 每 agent 一进程一 worktree，消息总线自建，UI 自建。
- 代价：3 周起步，且"看他们互相发消息"要自己写。
- 只在你要跨机器/多人协作/大团队时才值得。

### 路线 C：A 的壳 + B 的里（推荐终局）
- **观感在 Lead（DSH Team）里**：roster、任务板、对话、审批都在一个界面。
- **执行在外部进程里**：bridge teammate 负责在 `worktrees/<task>` 里起 codex/claude，产出 `DIFF.patch` 后交回主 checkout（或直接提交到分支让人合并）。
- Team 层的 `writeScopes` 只用来防两台机器抢同一片文件；真隔离交给 worktree。
- 这样你既有一个地方看，又不怕互相踩。**A 跑通后，把 bridge 里加 worktree 就是 C，增量很小。**

---

## 5. 消息协议：只用 5 种类型，禁止自由闲聊

多 agent 系统最常见的死法：自由对话 → 互相客套 → 跑偏 → 循环烧钱。**消息必须是受限类型 + 结构化字段**，自然语言只放在 `note` 字段里。

```ts
type Msg =
  | { kind:'handoff';  taskId:string; from:string; to:string;
      summary:string;            // ≤ 200 字
      artifacts:string[];        // 路径，不放内容
      contract:{path:string; version:string};   // 契约版本，必须带
      gate:{name:string; exit:number; report:string};  // 由中台签，不是 agent 自称
      needs?:string[] }          // 对手方还要什么
  | { kind:'question'; taskId:string; q:string; blocking:boolean }
  | { kind:'blocked';  taskId:string; reason:string; needsHuman:boolean }
  | { kind:'review';   taskId:string; verdict:'pass'|'fail'; findings:string[] }
  | { kind:'done';     taskId:string; evidence:string[] }
```

硬规则（写进 Lead 的 system prompt / 角色卡）：

1. **`gate` 只能由中台/bridge 填**，agent 自述的"测试通过"一律丢弃。
2. **`handoff` 必须带 `contract.version`**，前端只认版本号，不认口头描述——否则后端改一版接口，前端照着旧的理解做 = 返工。
3. **消息里不放 diff 内容**，只放路径；对方需要就自己 `read`（省 token、避免幻觉转述）。
4. **`done` 必须附 evidence 路径**，没证据的 done 自动降级为 `blocked`。

---

## 6. UI：现成的是"导航"，不是"群聊流水"

- 现成（`client-ui-agent-team`）：**roster**（谁在跑/谁睡着了）、**task board**（DAG + owner + 状态）、**teammate navigation**（点进去看这个成员自己的会话）。
- 你想要的"一个地方看到 DSH 和 Codex 你一句我一句"——这个**没有合并视图**。要真实现在两个做法：
  1. **便宜**：让 Lead 转述（"frontend 报：… 我核验 gate exit 0"）。单流，够看懂，P0 就够。
  2. **正规**：加一个只读 transcript 页，从各 session 的持久事件里筛 `agent-message` 源（含真实 `senderSessionId`），按 `seq` 合并渲染成气泡，带 from/to 和消息 kind 标签。**这是纯读操作，工作量小**（事件本来就在 JSONL 里），但需要你写一个小投影。

建议：**P0 用 1，P1 补 2。**

---

## 7. 任务 DAG：把"契约冻结"拆成独立任务（这是提速的关键）

你原流程是串行：`后端完成 → 前端开始 → 联调`。改成：

```
T0 契约冻结   (Lead/backend, 产出 CONTRACT/openapi.yaml + DESIGN/design-spec.md)
   ├─→ T1 后端实现   (owner: backend,  depends: T0)
   └─→ T2 前端实现   (owner: frontend, depends: T0)      ← 与 T1 并行
             └─→ T3 联调 e2e (owner: qa, depends: T1, T2)
                     └─→ T4 视觉验收 (owner: qa/frontend, depends: T3)
```

好处：
- 前端不用等后端"讲清楚接口"——它读 `CONTRACT/openapi.yaml` + `mocks/user.json` 就能开工，Codex 慢不再拖累 DSH 快。
- 你的观感不变：你照样能看到 backend 发"后端完成，前端可以联调了"的消息（只是这条消息是 T1 完成 → 解锁 T3 的通知，而不是 T2 的启动信号）。
- 任务板是唯一的状态真相，**消息只是 DAG 边上的通知**。别用消息驱动状态。

---

## 8. 闸门：系统里唯一有资格说"完成"的东西

```
typecheck → lint → test → build → （后端）接口冒烟(OpenAPI 校验) → （前端）playwright 截图 + 视觉评分
```

- 由 bridge/中台**自己执行命令**，exit code + 报告落盘为证据。
- 全绿才允许 `task.complete()` 并生成 `handoff`；红了把**失败日志片段**回给原 agent，最多 3 轮，超了 `blocked(needsHuman)`。
- 视觉闸门：截图 → 与设计稿/上一版对比 → 视觉模型打分，低于阈值打回 `frontend`。

---

## 9. 落地步骤（第一条链路，半天到一天）

```bash
# 1) 在 web profile 里挂上 Team（这两个包本机 app.asar 里已存在；实验性，先在副本 profile 试）
#    方式二选一：profile 的 patch yaml 里加 name，或 dsh plugin --profile <p> add <pkg>
#    最小组合（官方原文）：
#      - '@deepseek-ai/dsh-session-persistence-jsonl'
#      - '@deepseek-ai/dsh-experimental-agent-team'
#      - '@deepseek-ai/dsh-experimental-tool-agent-team'

# 2) 写三张角色卡：agents/backend.md, agents/frontend.md, agents/qa.md
#    每张只写：职责 / 可改范围(writeScopes) / 验收命令 / 禁止事项 / 消息格式

# 3) 写 bridge（frontend 的"身体"）
#    收 inbox 消息 → 组 prompt（消息 + 契约路径 + 角色卡 + 上轮 diff 摘要）
#                → spawn: claude -p ... --output-format stream-json   （或 codex exec --json）
#                → 解析事件流 → 跑闸门 → 回 postMessage(handoff/done)
#    claude 常驻版：claude --bg --input-format stream-json --output-format stream-json

# 4) 建任务板：T0 契约 → T1 后端 / T2 前端（并行）→ T3 联调 → T4 视觉

# 5) 跑，然后在 Lead 的 roster/任务板上看：谁在 running、谁 inactive 被唤醒、T3 什么时候解锁
```

**验收标准**：一条指令启动后，你能在 Lead 界面看到
`backend: handoff(T1, gate green)` → `frontend 被唤醒` → `frontend: handoff(T2)` → `T3 解锁` → `qa: review(pass)`
中途把测试改红，能看到 `gate red → 打回 frontend → 重试 → blocked` 的完整过程。

---

## 10. 与 v1 的差异（为什么改）

| | v1（中台调度 CLI） | v2（Team + Bridge） |
|---|---|---|
| 谁在调度 | 外部服务 + LLM | DSH Team 的 Lead（原生） |
| agent 身份 | 进程 | roster 里的具名成员，有 inbox/状态/任务归属 |
| 你看什么 | 自建看板 | 现成 roster + 任务板 + 导航 |
| 状态真相 | 自建 DB | Team 的持久日志（`team/member`、`team/task`） |
| 隔离 | worktree（强） | 共享 checkout（弱，需自己补） |
| 工期 | 2–3 周 | 1 天出链路，1 周出稳定版 |

**结论：先做 v2 拿"看得见的对话"，再把 v1 的 worktree/外部进程能力以 bridge 的形式注进去，得到路线 C。**

---

## 12. CLI / 声明式路线：GitHub 上的直接同类

| 项目 | 星 | 形态 | 关键设计（值得抄） | 短板 |
|---|---|---|---|---|
| **`buildoak/agent-mux`** | 36 | Go 单二进制，`agent-mux run --worker x` | **worker = 一个 md 文件 + YAML frontmatter**（"the prompt is the worker"）；**一个 JSON 结果契约**跨 codex/claude/gemini/agy/grok；每次 dispatch 必有 artifact 路径；"errors are steering signals"；"single-shot with curated context" | 定位是"工具不是编排器"，**没有 roster/会话视图**；引擎列表无 DSH（但有 adapter 边界可加） |
| **`rbinar/cli-dispatch`** | 12 | Claude Code 插件 | **每个任务跑在独立 git worktree，产物是 patch 等 Lead 批准**；**`--verify` 是内建参数**；run monitor 实时看 worker 步骤；**运行中可给 worker 发消息**（`→ sent` / `✉ delivered`）；**worker 中途反问 → 能路由给 Lead 或人** | Lead 绑死 Claude Code；后端列表里没有 DSH（但本质是 shell 调用，可加 wrapper） |
| `blackpaw-studio/leo` | 6 | supervisor + tmux 常驻 + web dashboard | 常驻 agent + cron + subagent dispatch | 抽象偏重 |
| `arczibdg/agentmesh` | 5 | "Docker Compose for AI agents" | YAML 定义 agent team，一条命令起 | 生态小 |
| `srijansk/agent-relay` | 7 | docker-compose + YAML workflow | 文件系统当状态机 | 同上 |
| `billy12151/agent-lane` | 0 | 声明式 YAML flow | output contracts + cross-review + durable recovery | 同上 |
| `machinemates-ai/dark-factory` | 1 | Codex App Server + Claude Agent SDK V2 | DAG-aware YAML + A2A bus + sqlite ledger | 太重 |
| `HeyAryaHere/claude-cursor-bridge` | 0 | Claude 编排、Cursor 执行 | **"the git diff is the contract"** | 依赖 Cursor headless |
| `hakan-gul/ai-orchestration-agents` | 0 | 成本感知编排 | Gemini 先做、Composer 兜底 | 同上 |

### 三条可选路线

1. **纯 CLI 派发层**（agent-mux 形状）：一个二进制 + 一堆 worker md + JSON 结果。今天就能用，不写 UI；代价是没有"看对话"的界面。
2. **宿主插件**（cli-dispatch 形状）：把 dispatch 做成 Lead 里的一个工具，Lead 自己决定派谁。这是最贴近你需求的形状——**而 DSH 是更好的宿主**，因为它有 team（roster + 任务板）而 Claude Code 没有。
3. **声明式 compose**：YAML 定义 DAG + 容器隔离。可复现、可版本化，但社区小、DSH 不在支持列表，成本最高。

### 推荐的最小 CLI 形状（1 天可写出来）

```bash
dispatch run --worker backend  --cwd . --verify "pnpm test && pnpm build" --json "实现 src/api/user.ts"
dispatch run --worker frontend --cwd . --verify "pnpm build && pnpm e2e"          "按 CONTRACT/openapi.yaml 做设置页"
dispatch watch <run>            # 尾部 NDJSON 事件，或转 SSE 给 UI
dispatch send  <run> "契约 v2 已冻结，改用 mocks/user.v2.json"
dispatch verdict <run>          # PASS/FAIL + 证据路径 + patch 路径
```

四个硬性设计（从 cli-dispatch / agent-mux 直接搬）：

- `--verify` **必填**，不是可选；没有 verify 的 run 只能是 `ask`（只读）。
- worker 一律跑在 `git worktree`，产出 patch 回主库由 Lead/人批准 → 绕开 Team "共享 checkout" 的限制。
- 每次 run 落 `runs/<id>/{events.ndjson, prompt.md, verify.log, verdict.json, out.patch}`。
- `send` 走 worker 的 stdin（claude 用 `--input-format stream-json`；codex 用 mailbox 文件轮询），实现"运行中插话"。

---

## 13. 一项目多会话：worktree 隔离 + 波次并行 + 自动合并（已实现）

代码：`yang-harness/yang.mjs`（`yang run` 默认开启 worktree）。

### 模型

```
base 分支
  └─ T0 契约冻结        worktree wt/T0   branch yang/<run>/T0   ──merge──▶ base
       ├─ T1 后端实现    wt/T1  branch yang/<run>/T1  ┐ 同一波
       └─ T2 前端实现    wt/T2  branch yang/<run>/T2  ┘ 并行   ──merge──▶ base
            └─ T3 联调   wt/T3  branch yang/<run>/T3           ──merge──▶ base
```

- **一个任务 = 一个 worktree = 一条分支**：`git worktree add -b yang/<run>/<task> wt/<task> <base>`。
- **同一波并行**：波次由依赖深度算出（`waves()`），波内并发数 `--parallel`。
- **波末合并**：按任务顺序 `git merge --no-ff`，合并后删 worktree 与分支。
- **闸门在 worktree 里跑**：verify 的 cwd 是该任务的 worktree，通过才允许提交。
- **冲突即停**：合并失败 → `merge --abort` → 写 `CONFLICT.md`（冲突文件 + 手工命令 + worktree 路径）→ 退出码 4，**保留**该任务的 worktree 与分支供排查。

### 为什么是 worktree 不是 clone 或切分支

| 方案 | 并行 | 磁盘 | 切换成本 | 结论 |
|---|---|---|---|---|
| 切分支（git checkout） | ✗ 同一目录只能一个 | 最省 | 每次都动主检出 | 不可用 |
| 独立 clone | ✓ | N 倍 | 无 | 太重，且 .git 不共享 |
| **worktree** | ✓ | 只多工作区文件 | 无（共享对象库） | **选它** |

### 关键约束：契约任务必须独立成一波

T1（后端）与 T2（前端）要能并行，就不能让 T2 依赖 T1。做法是把「接口冻结」拆成 T0：
T0 只写 `CONTRACT/**` → 合并进 base → T1/T2 各自从**含契约的 base** 开 worktree。
这样并行不破坏正确性，冲突面也被压缩到"同一文件"这一种情况。

### 写入范围（writeScopes）还是提示，不是锁

`writes` 只写在 prompt 里约束 agent，工具层不拦截。真正的保护是两条：
① 每任务独立 worktree（写不同目录自然不冲突）；② 合并不上就是冲突，停下等人/机处理。
要更强的可以加：合并前跑 `git diff --name-only` 与其它 in-progress 任务的 `writes` 比对，重叠就直接拒绝开工。

### 命令

```bash
yang run plan.json --cwd D:\proj --parallel 3      # 默认开 worktree + 自动合并
yang run plan.json --no-worktree                   # 共享目录（非 git 项目的退化模式）
yang run plan.json --no-merge                      # 只跑不开合并，留分支自己看
yang run plan.json --keep                          # 保留 worktree 与分支
yang run plan.json --base develop                  # 合并目标
yang run plan.json --retry 2                       # 单任务重试
```

产物：`runs/<run>/<task>/{prompt.md,agent.log,verify.log,verdict.json,handoff.md}`、`REPORT.md`、必要时 `CONFLICT.md` / `STOPPED.md`。

---

## 11. 还没有答案、需要你决策的三件事

1. **隔离强度**：接受"共享 checkout + 文件分区"（简单）还是要"每任务 worktree"（复杂但能真并行）？
2. **codex 常驻还是按需**：装 `codex` 后先试 `codex app-server`；不行就只能 `codex exec` 冷启动，那前端任务尽量合并成"一次大任务"而不是多次小唤醒。
3. **群聊视图要不要自己写**：只看 roster + 点进各自会话（零成本），还是要合并流水（写一个只读投影，半天）。


---

## 12. v3 现状：现在实际怎么用（2026-11-24）

v2 讨论的是"要不要照 DSH 的 Team 原语重做"。最终没重做，而是在现有 orchestra + yang-harness 上把入口改成了 DSH 的样子：**一句话就是会话**。

### 用户在界面上看到的

- 左侧项目行右侧的 `＋` → **不弹表单**，直接在这个项目下开一个"新会话"（底部一个输入框）。
- 敲一句话回车，例如：`创建一个 html 页面，dsh 做格式设计，codex 做内容填充`
- 主区变成对话流：你的话 → `yang` 说"收到，先拆活" → 任务卡（T0 → qa-dsh 已完成 之类）→ 派活/交接/完成，全部在一条时间线里。
- 需要调模型/并行度/分支隔离，点会话右上角 `⚙`，按项目记在 localStorage。
- 可折叠的「流转图」保留，作为进度面板。

### 背后的链路

```
浏览器  POST /api/session {cwd, message, models?, parallel?, worktree?}
          ↓ orchestra/server.mjs  spawn(detached)
        node yang.mjs chat "<message>" --cwd <dir> [--models dsh=a,codex=b] [--parallel n] [--no-worktree]
          ↓ ① 立刻写占位 state.json（status=planning，界面显示"正在拆活"）
          ↓ ② busMsg：user 的话 + yang 的"收到/拆好了 N 个任务"
          ↓ ③ planByLLM：用桌面端同款路由调 dsh headless，按话里的分工拆任务
                 · 用户点名"用 dsh / 用 codex" → 任务里写 agent，点名优先于 tag
                 · 规划失败自动回退 RULE_PLAN（契约→后端∥前端→联调），state.plannerNote 里留原因
          ↓ ④ runPlan(plan, {id, dir})：复用占位目录，走原来的波次执行
```

### 这次一并修的坑

| 问题 | 修法 |
|---|---|
| `planByLLM` 用裸 `dsh headless`，没路由没 key，必失败 | 改用 `dshLauncher()`（桌面端同款 patch + 凭据） |
| LLM 输出 JSON 后面还跟解释文字，贪婪正则解析失败 | `extractJson()` 按括号深度扫描取第一个完整对象 |
| Windows 上 npm 装的 `claude.cmd` / `opencode.cmd` 被 `spawn` 直接 ENOENT | `resolveBin()` 解开 shim：`.exe` 直接跑，node 脚本用 `process.execPath` 跑，不走 shell（避免几千字 prompt 的引号/8191 限制） |
| 没装的 CLI 也被派活，白跑一轮 | `agentAvailable()` + `liveRegistry()`，不可用的工人不进池；`yang registry` 会标 ✅/✗ |
| LLM 把真实需求派给 `demo-*` 夹具（verify 恒真，假装成功） | 规划池默认排除 `demo-*`；`yang run plan.json` 仍放行（显式计划要能跑） |
| 工人卡的 verify 是给 demo 项目写死的，任意任务必挂 | 规划器为每个任务生成 `verify`（针对本次产出物），任务级 verify 优先于工人卡 |
| codex/claude 的 `{"type":"turn.completed","usage":...}` 混进交接摘要 | `cleanOut()` 丢掉纯 JSON 行 |
| 页面 2.5 秒轮询重建 DOM，输入框被打断 | 会话页加数据签名，没变就不重绘；重绘时保留输入内容/光标/滚动 |
| yang 在规划阶段崩了，界面永远"正在拆活" | `listRuns` 给 planning 3 分钟超时，转 failed 并给提示 |

### 一句话总结

**点 `＋` → 说一句话 → 看它拆活、派活、交付。** 想控制怎么拆，就在那句话里写"谁做什么"；想换模型，右上角 `⚙`。

### 调度用的 LLM 是怎么接的

**不需要单独配 key**：yang 的规划器是一个 headless DSH 进程，走桌面端同一条路由——

```
yang dsh-model
provider : xftech
model    : deepseek-v4-pro
来源     : 桌面端 agent-default-model
注入的key: XFTECH_API_KEY, TEN_API_KEY
```

它读 `~/.dsh/profiles/desktop/cordis.patch.yml` 拿 provider/模型，从 `~/.dsh/.credentials.yaml`
取 key 注入子进程环境。所以你在 DSH 里能聊天，yang 就能拆活。

会话级可以单独指定"调度模型"，和干活的工人模型分开（省钱套路：调度用 flash、干活用 pro）：

```
⚙ 设置 → 调度模型             # 界面上选，按项目记忆
yang chat "..." --models planner=deepseek-flash
```

实测：`deepseek-v4-pro` 拆一句"创建 hello.txt"约 77 秒，`deepseek-flash` 约 5 秒。

### 为什么以前会弹黑框

Windows 上 `spawn`/`spawnSync` 不设 `windowsHide` 就会给它开控制台窗口。逐个补上：

| 位置 | 以前的表现 |
|---|---|
| `server.mjs` 发消息时 `spawn(..., {detached:true})` | **每发一条消息弹一个黑框**（最主要） |
| `yang.mjs` 每次 `git` 调用 | 执行任务时不停闪 |
| `yang.mjs` 每个任务的 verify（`shell:true`） | 每任务闪一次 |
| `yang.mjs` `where` / `taskkill` | 偶发闪 |
| 规划器 spawnSync（Electron as node） | 拆活时闪 |
| `启动中台.cmd` 的 `start /min cmd /c` | 启动时一个最小化窗口，且脚本不退出 |

现在：全部 `windowsHide: true`；`启动中台.cmd` 改为
`powershell -NoProfile -WindowStyle Hidden -Command "Start-Process ... -WindowStyle Hidden"`，
3 秒内返回、服务在后台跑、日志由 server 自己写进 `runs\server.log`（`Start-Process` 带
`-RedirectStandardOutput` 会等子进程退出，所以不要在脚本里重定向）。

### 第二轮修的问题（真实跑"做个登录注册页"时暴露的）

| 现象 | 根因 | 修法 |
|---|---|---|
| T0 直接失败：`--output-format=stream-json requires --verbose` | claude adapter 少传参数 | 加 `--verbose`（实测 6 秒返回） |
| T1（dsh）声称"岗位说明禁止写 HTML"，交回一段解释就收工 | 工人卡正文写死了上一个项目的交付内容（`backend-dsh.md`："只写后端，不要写 HTML"），和本轮任务冲突时 agent 会选择遵守禁令 | `buildPrompt` 给岗位说明加优先级声明：历史约束与本轮任务冲突时以任务为准 |
| T1 完全跑不了命令：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\project\a)` | 该目录缺 `WRITE_OWNER`，DSH 沙箱无法给命令会话授权 | 用 `diagnose-windows-sandbox-acl` 修：备份 DACL → 给当前用户加完全控制 → 重读验证。恢复命令在 `D:\project\acl-recovery-a\` |
| 交接摘要变空 | claude/codex 的输出每行都是 JSON，`cleanOut()` 全丢了 | `extractSpeech()` 按各家事件格式（`assistant.message.content[].text` / `item.completed.item.text`）取正文 |
| 非 git 目录显示"改动 0 个文件"、甚至把 `fatal: not a git repository` 当成"改动了 1 个文件" | `git()` 把 stderr 并进 out，`changedIn()` 没看退出码 | 按 `r.code !== 0` 直接返回空，文案改成"（非 git 目录，改动未统计）" |
| 拆一句话要等 77 秒 | 默认用 pro | 调度默认 `deepseek-flash`（实测 5 秒），⚙ 里可逐项目改回 pro |

### 第三轮：动态流转图（照 fashitianxia.xyz 那张图）+ DSH 留痕

**1）流转图从"折叠脚注"变成主视图**

会话头部现在是 `对话 | 流转图 3/4` 两个标签（`&view=graph` 可深链）。图的样子照参考站：

- 列 = 波次（`第 1 波 · 3 个 agent`），第一列是「你的任务」节点
- 每条依赖一条边；上游完成 → 边变实线，下游在跑 → 边上跑两个光点（`animateMotion`）
- 节点状态用参考站的说法：`等待依赖 T1、T2` / `进行中 · 54.7s`（每 0.5 秒刷） / `完成 · 验收 0` / `失败`
- 顶部汇总 `完成 1/4 · 进行中 2 · 排队 1 · 总耗时 5m59s`，底部一行 `编排：第 1 波（1）→ 第 2 波（2）→ 第 3 波（1）`
- 节点上带 `DSH 会话 abcd1234` 徽标（见下）；点节点开右侧抽屉看该 agent 的实时日志

坑：`runId` 里的时间是 **UTC**（`run-2026-11-24T12-10-44` = 本地 20:10:44），而且用连字符分隔，`Date.parse` 解析不了 —— 必须正则取出后按 `Date.UTC()` 算，否则总耗时会差 8 小时。

**2）子 agent 在 DSH 里留痕，并且在 App 里看得见**

`dsh headless` 每跑一次其实都会写一个真实会话：

```
~/.dsh/sessions/--D-project-a--/session-<uuid>/session.v4.jsonl.zstd    完整日志
~/.dsh/storages/session_projcache/sessions/session-<uuid>.json          标题（如"创建 hello.txt 并完成验收"）
```

但 **DSH App 的左侧项目列表来自 `~/.dsh/storages/workspace.json` 的 `tables.workspaces`**，
没登记的项目在 App 里根本不出现 —— 这就是"子 agent 看不到痕迹"的原因。

yang 现在做了两件事（`linkDshProject()`）：

1. 目录编码规则照 DSH：`D:\project\a` → `--D-project-a--`（分隔符折成 `-`，两边包 `--`）
2. 跑完 diff 出新会话 → 项目没登记就登记（并把该项目已有会话一起带进去）→ 会话 id 挂到 `sessionIds`

写入前 `copyFileSync` 备份成 `workspace.json.yang-bak-<时间戳>`，原子 rename，失败只打日志不影响执行。
任务状态里多一个 `dshSessions` 字段，界面上显示成 `🗂 DSH 留痕 93f2e940`。

手动导入某个项目（连带历史会话）：`yang dsh-link --cwd D:\project\a`。

注意：DSH App 需要重开（或刷新项目列表）才看得到新项目；App 自己也会写这个文件，
万一我的登记被它覆盖，重跑一次 `yang dsh-link` 即可。

### 第四轮：编排方不再是"一个 agent" + 过程自动铺开

**1）yang 只是这个项目的名字，不是工人**

工人池里从来没有 yang 的卡（`agents/*.md` 里只有 qa-dsh / backend-dsh / frontend-codex / …），
但界面把它画成了和 dsh、codex 平级的一个 agent（紫色「阳」头像 + 加粗 yang），容易误读。
现在编排方统一渲染成 **`<项目名> · 编排`**，灰底中性头像、正文照旧：

```
a  编排  拆好了，4 个任务：
a  →  派活 T2：注册页 register.html            dispatch
```

工人才有彩色首字母头像（OD/BA/FC…）和 `→ 派活` 方向箭头。

**2）过程图自动铺开 + 动效补全**

- 一开工（status=planning/running）自动切到「流转图」，每个 run 只切一次；
  用户自己点过标签页就 `viewPinned`，不再抢
- 活跃波次：列标题 `第 N 波 x 个 agent · 正在跑` 变蓝，底部一条流动渐变线
- 新节点依次入场（`--delay = idx*55ms`），只对**新出现**的节点做，否则每次轮询整图都会闪；
  已画过的 id 记在 `state.graphSeen`，换 run 时清空
- 光点三层：实心点 + 半透明光晕 + 延迟半拍的暗点，沿 `animateMotion` 走分叉曲线
- 边的"活"判定改成 **上下游任一在跑** 就算活（以前只看下游，上游在干活时线是死的）
- 完成/失败的节点显示 `完成 · 用时 20s · 验收 0`

坑：`sysBubble()` 这类拼 HTML 的辅助函数一定要把 `.yt` 留在 `.yb` 里面。放到外面会变成
flex 的独立项，中文被挤成一行一个字竖着排（踩过一次）。

### 第五轮：让 agent 之间直接对话（圆桌）+ 交接自带文档原文

**1）圆桌：`yang talk`，界面上是「模式 → 圆桌」**

原来的交接是"上游写完 → yang 把摘要塞给下游"。你要的是更彻底的一步：
**后端 agent 和前端的那个 agent 直接说话，人在旁边看，不转述、不递文件。**

```
yang talk "待办列表要不要分页？后端性能和前端体验各自怎么看，定一个就开工" --with backend-dsh,claude-worker --rounds 2
```

机制：每一轮把**之前的全部发言**拼进 prompt，参与者轮流说；谁写出 `[一致]` 就算同意，
全部同意就提前收敛。每轮 = 一波，参与者在流转图上就是节点，对话本身进总线（界面上就是 agent 之间的你来我往）。
产物 `runs/talk-<时间>/transcript.md`。

实测（backend-dsh ↔ claude-worker，40 秒 4 次发言）真的把方案谈定了：
游标翻页 vs offset、`order` 参数只允许两个值、`X-Total-Count` 不回、`meta.limit` 要回、
`status=done|pending` 走单值索引、索引建在 `(user_id,status,created_at desc,id desc)`、
以及分工（后端接口+索引+游标编解码，前端无限滚动+按 id 去重，qa 出验收用例）。

成本：`参与者 × 轮次` 次模型调用（dsh 十几秒，codex 1–3 分钟）。默认挑两个不同 CLI。

**2）交接里直接带上游文档原文**

以前下游只拿到 `产出文件：docs/api.md`，还得自己去开文件——也就是你说的"我再打开那份 md 去对接"。
现在 `makeHandoff()` 会把上游写的说明文档**原文**（md/txt/json/yaml，最多 2 份 × 2400 字）拼进交接，
下游的 prompt 里直接有：

```
───── 上游文档 · docs/spec.md（T0 写的，原文，直接按它对标准实现）─────
# Todo 服务接口契约（v1）
…
```

坑：文件清单来自 `git status`，**非 git 目录下是空的**，所以加了 `freshDocs()` 兜底——浅层遍历按 mtime 找出
上游刚写的文档。不然这条链在不是 git 仓库的项目里是断的。

**3）顺手修掉的**

- 非 git 目录下 `git diff --stat` 会返回 usage 帮助全文，被当成 diffstat 塞进交接（上百行垃圾）→ 按退出码+内容过滤
- `.yt` 是 `white-space:pre-wrap`，卡片 HTML 的换行被当成空行渲染，每张任务卡被撑高 → 包一层 `.cards{white-space:normal}`
- 已完成的历史会话不做入场动画（`animIn` 只在 running/planning 时为真），
  否则动画被冻结在半透明状态，整张图发虚

**4）DSH App 会覆盖 workspace.json**

实测：我 21:21:00 登记了 `a2a-test`，文件在 21:21:30 被 App 重写，那条登记没了；
而 `D:\project\a` 因为你在 App 里打开过，反而被 App 保留下来（现在 10 条会话）。
**结论：登记新项目后要重开 App（或先在 App 里打开该项目），否则 App 保存自己状态时会把它丢掉。**

### 第六轮：工作流画布（可拖可连）+ 作为会话的辅助浮层

用户要的不是"看一张已经跑完的图"，而是**自己画**：拖 agent 当节点、连线决定并行/先后、有个起点，
再配一句话说明任务。所以做了 `orchestra/workflow.html`（单文件，挂在 `http://127.0.0.1:7788/workflow`）。

**画布**
- 左侧工具盘拖进画布＝加节点；节点名字就是 agent 名（`backend-dsh` / `qa-dsh`），第二行小字才是这一步做什么
- 从节点右侧圆点拖到另一个节点＝连依赖；**从左圆点拖也行**（方向反过来：我要一个上游）
- 拖线时目标节点亮绿框；边上带箭头，方向不用猜
- 一个节点连出多条＝并行（同波），串成链＝先后；不允许成环、不允许连回「开始」、「交付」不能有下游
- 右侧实时把图翻译成波次：起点 / 第 N 波（几个工人 · 并行）/ 收尾，`JSON` 按钮给出
  `{tasks:[{id,agent,title,depends}]}` —— 和 `yang run plan.json` 吃的是同一个结构
- `▶ 模拟运行` 按波次跑：上游变绿、下游亮蓝带扫光、连线跑电流点
- `按描述自动铺`：从话里认 agent（dsh/codex/claude/qa/测试/验收），有"并行/同时/一起"就横铺、
  否则串成链，并把描述里对应的**那半句**抠出来当节点说明，末端自动汇到「交付」

**自动接线**：拖进来的节点会自己接上"没有下游的末端"（其次按距离最近）。
不这么做，画布上全是孤岛，人还得先想该从哪儿拉线。拖「交付」则自动收拢所有末端。

**定位：辅助，不是主角**
用户明确说"主要的还是会话，画布可以隐藏"。所以：
- 会话正文占满主区，右上角只多一个「⧉ 画布」按钮
- 点开是右下角浮层（`#canvasDock`，iframe 载 `/workflow?embed=1`），可 `⤢` 放大、`✕` 收起、`Esc` 收起
- 开关记在 `localStorage['orchestra.canvasOpen']`；`?canvas=1` 是深链
- iframe 内是嵌入模式：隐藏标题栏和右侧计划面板、工具盘收窄到 158px、示例只放 3 个节点（`fitView` 才不会缩到 50%）

**自检**：`?selftest=1` 跑 7 条断言（开始不能有上游 / 正向连线 / 成环拒绝 / 交付无下游 /
起点可并行 / 自动接末端而不是硬插中间 / 交付收拢末端），用 `--dump-dom` 读 `document.title` 验证，全 PASS。

**坑**
- 之前只让 `out` 端口能拖线：用户把「交付」当普通节点往右拖，那个节点没有输出口，于是什么都没发生，
  以为"连不上"。**任何能画的地方都要给可见的失败反馈，或者干脆自动做对。**
- `svg.innerHTML = parts.join('')` 会把 `<defs>`（箭头 marker）一起清掉 → 改成写进 `<g id="eLayer">`
- `fitView()` 在 iframe 刚挂载时 `getBoundingClientRect()` 可能为 0 → 加空值早退 + `resize` 重新适配（用户手动缩放过就不动）

**修正（用户两次指出）**：节点上只写 agent 的名字，不要塞制作者的文案。
所以示例里的"做前端页面（首页/列表/新增）"、嵌入面板的"点左侧卡片加节点"、
开始/交付的"任务入口/汇总交付"、自动铺把描述半句写进节点的做法——全部撤掉。
`addNode(kind, agent, x, y, note)` 的 `note` 默认空，只有你双击节点填、或在右侧面板输入框里打字，
卡片上才会多一行说明。自动铺认出来的那半句只放在输入框的 **placeholder** 里（灰色提示，不算写死）。
节点高度固定 66px（无说明时也不空荡），名称右边那枚 `DSH / CODEX / CLAUDE` 是适配器事实标签，不是文案。

### 第七轮：调度 agent 定名 + 「在别人的客户端里留痕」对齐

用户纠正了两处理解偏差，并给出了这个项目的正确定位：

- **调度方是一个 agent，有自己的名字：Trony harness**（跑在 DSH 模型上，xftech 中转）。
  它不是"项目名"，也不是和 dsh/codex 并列的工人；它是你在对话里说话的那个对象，它自己不写代码，
  工具就是别的 agent。
- **留痕必须是"在对方客户端里"**：在调度台里说"用 codex 写一个前端登录页面"，codex 那边就该多出
  「这个项目 + 一条会话 + 这句话」。不是"在调度台里能看到痕迹"。

**已落地的三处对齐**

1. **prompt 第一行 = 任务名**（原来是"你是团队里的一个工人…"模板开头）。
   实测 codex 的 rollout 里，第一条 user 是 codex 自己塞的 `<environment_context>`，
   第二条才是我们的话，现在它开头就是`用 Codex 实现只有单个表单的登录页 login.html`。
   各 CLI 的会话标题/预览都取首条真实用户消息，这条不修，留痕等于没有。
2. **认领 codex / claude 的原生会话**：跑前给 `~/.codex/sessions`、`~/.claude/projects` 拍文件快照，
   跑完 diff 出新增文件，再读文件首行的 `"cwd"` 对上是哪个目录，把 id 记进 `state.json` 的
   `nativeSessions`（DSH 那边原本就有 `dshSessions`）。实测：
   - claude → `0b6bba23-360a-…`（`~/.claude/projects/D--project-tool-runs-native-test/….jsonl`）
   - codex → `01a210b7-1816-…`（`~/.codex/sessions/2026/11/25/rollout-….jsonl`）
3. **界面**：会话里的调度方气泡改成 `Trony harness` + `调度` 标签；任务卡下方一排小 chip
   `🗂 codex 留痕 01a210b7` / `🗂 dsh 留痕 …`，悬停给出 resume 命令。

**顺带修掉的三个真 bug**

- **planner 不知道项目目录**：它的 prompt 里根本没有 cwd，于是把调度器自己的 `<cwd>D:\project\tool</cwd>`
  （DSH 注入的）写进了任务说明——"在当前项目根目录（D:\project\tool）新建 hello.txt"。
  工人照做就被自己的权限拦住（claude 报 `Path is outside allowed working directories`），任务冤死。
  现在 planner prompt 带真实项目目录，并规定 brief 里只写相对路径。
- **没有声明工作目录**：原来只在开 worktree 时才说"工作目录"，不开隔离时工人靠猜。现在每份 prompt
  都有 `───── 工作目录 ─────` 段，写死绝对路径 + "不许跑出这个目录"。
- **验收不过没有终态**：`verifyCode !== 0` 时没人写 state，界面上任务永远"进行中"。现在落 `failed`。
- 还加了一层**页面级错误捕获**：轮询重建 DOM 时一个 `ReferenceError` 就会让整页只剩左边栏，
  而 async 抛错是静默的（unhandled rejection）。现在右下角直接把异常打出来——第一次用就抓到
  "`took is not defined`"（我自己改 taskCard 时漏了一行）。

**注意一个取舍**：默认不开 worktree，任务直接改项目目录，所以那条原生会话的项目就是你的项目；
开了隔离的话，会话会挂在工作树目录下（id 仍能 `codex resume` 打开，但项目分组是工作树）。

### 第八轮：为什么"Codex 里看不见"，以及怎么让它真的出现

用户截图：Codex 侧栏有 16 个项目（Nova AI / 狼人杀 / viedo / Twin / …），但看不到我们派出去的活。
**我上一轮只验了"rollout 文件里有这条会话"，没验"界面里点得到"，这是漏检。**

查到的真实机制（读 `~/.codex/state_5.sqlite`）：

- 我们的会话**在** `threads` 表里：`id=01a210b7-…`、`title=用 Codex 实现只有单个表单的登录页 login.html`、
  `source=exec`、`cwd=\\?\D:\project\tool\runs\native-codex` —— 说明"首行是任务名"的修复真的传到了 Codex 的标题。
- 但 **560 条线程的 `project_id` 全是 null**，所以分组不靠这个库。
- 侧栏的项目清单来自 `~/.codex/.codex-global-state.json`：
  `local-projects`（{uuid:{id,name,rootPaths,createdAt,updatedAt}}）、`project-order`（uuid 数组）、
  `thread-project-assignments`（{threadId:{projectKind:'local',projectId:uuid}}）。
  项目 uuid 同时是 sqlite 里 `project_idempotency_keys.key` —— 应用自己会把项目补进 sqlite。
- 那个目录从没在 Codex 里打开过 ⇒ 没有对应的 local-project ⇒ 线程没有归属 ⇒
  掉进 `projectless-thread-ids`，也就是侧栏底部那行灰字「暂无聊天」。

**做法**（用户批准 A 方案：自动登记项目 + 只在开新会话时登记一次）

- `linkCodexProject(cwd, threadIds)`：写 `local-projects` + `project-order` + `thread-project-assignments`，
  并往 `config.toml` 补 `[projects.'<小写路径>'] trust_level = "trusted"`。
  幂等（已存在就只补线程）；**先备份**成 `*.yang-bak`；**原子写**（临时文件 + rename）+ 写后 JSON 自检。
- `yang codex-link --cwd <项目>` / `--all`：补历史。`--all` 会跳过 `demo/`、`runs/`、`a2a-test*`、`native-*`，
  免得演示夹具污染用户的真实项目列表。
- `codexAppRunning()`（tasklist 查 codex.exe）：应用开着时明确警告——**它退出时会用内存状态覆盖这个 JSON**，
  所以"退出 Codex → 跑一次 → 重开"才是有效顺序。

**本轮对工作区外文件的改动（已批准，均留了备份）**：`~/.codex/.codex-global-state.json`、
`~/.codex/config.toml`。给 `D:\project\a` 建了项目并挂上 5 条 codex 会话；顺手清掉了误加的 3 个 demo 项目。

**教训**：留痕这件事有三个层次，只验第一层就会翻车——
① CLI 自己的落盘文件里有 → ② 应用的索引里有 → ③ **用户在界面里点得到**。要验到第三层。

**修正（第三次才对）**：Codex 桌面应用的写入口其实有三层，之前两次都写错层：

1. **应用主进程叫 `ChatGPT.exe`（MSIX 包 `OpenAI.Codex`）**，`codex.exe` 只是它拉起的 `app-server`，
   杀掉会被主进程重新拉起 —— 所以"杀进程"要杀主进程，否则永远"还在运行"。
2. **侧栏项目清单的真源是 `~/.codex/.codex-global-state.json` 的 `local-projects` / `project-order` /
   `thread-project-assignments`**。应用启动时会读它、退出时写它；**在它运行时写进去的，会被它用内存里的旧列表覆盖**
   （实测 12:39、12:49 两次被抹掉）。
3. `state_5.sqlite` 的 `projects` + `project_roots` 是"路径 → 项目"的另一半（会话靠 `threads.cwd`
   落在 `project_roots.path` 下归类），也该写；应用自己还会补一条幂等键。

**有效顺序**：完全退出 Codex（杀 `ChatGPT.exe` 主进程）→ 跑 `yang codex-link --cwd <项目>` → 打开 Codex。
实测按这个顺序写入后，启动 Codex，JSON 仍是 17 个项目、`a` 排第一、5 条会话挂在它下面，库 18 行。
`codexAppRunning()` 也改成认路径（`OpenAI.Codex` 下的 `ChatGPT.exe`）而不是进程名，应用开着时**拒绝写**并给出说明，
不再"假装成功"——这比写进去被覆盖更靠谱。

**教训升级**：跨应用的"留痕"要数清有几层存储，且必须知道**谁在什么时候覆盖谁**。
只验数据层（文件/DB 里有）而不验应用层（界面里点得到、且能活过一次重启），就会连续两次报"做好了"却看不到。

### 第九轮：侧栏里"看得见"的完整条件（实测通过）

终于把整条链路打通，并且用 PrintWindow 截了 Codex 自己的窗口确认（`runs/codex-print2.png`：
`a` 项目下 5 条会话，点开是第一棒 agent 的完整对话、`已编辑 register.html +93 -0`、用时 3m33s）。

**项目那一层**（侧栏出现 `a`）
- 真源是 `~/.codex/.codex-global-state.json` 的 `local-projects` / `project-order` / `thread-project-assignments`；
- **必须在 Codex 完全退出时写**，否则被它内存里的旧列表覆盖（这是前两次失败的根因）；
- `state_5.sqlite` 的 `projects` + `project_roots` 也写（会话按 `threads.cwd` 落在 `project_roots.path` 下归类）；
- "退出 Codex"= 结束 **`ChatGPT.exe`（MSIX 包 `OpenAI.Codex`）主进程**；`codex.exe` 只是它的 `app-server` 子进程，
  杀掉会被主进程重新拉起。

**会话那一层**（项目里出现那些对话）
`codex exec` 写的线程行会被侧栏隐藏，只要三个字段：
| 字段 | exec 的原值 | 应用认的值 |
|---|---|---|
| `has_user_event` | 0 | **1** |
| `originator` | `codex_exec` | **`Codex Desktop`** |
| `source` | `exec` | `vscode`（这列会被应用按 rollout 重建回 `exec`，**不影响可见性**） |

侧栏那一行显示的文字来自 **`first_user_message` / `preview`**（不是 `name`/`title`），所以想让标签是人话，
这四个字段都要写。已在 `makeCodexThreadVisible()` 里固化为派活后的自动动作，标题取我们的任务名。

**顺带修好的体验**：`a` 已经登记过，以后往 `a` 派 codex 活，即使 Codex 开着也能立刻看到；
只有"一个从没打开过的新目录"第一次需要让 Codex 关着登记一次。

**方法上的收获**：跨应用集成时，读它的二进制找 schema/字符串（`external_agent_migration/session_importer.rs`、
`CREATE TABLE threads … has_user_event`）+ 逐字段 diff「它能显示的」与「我们生成的」，比猜快得多；
验证一律截它自己的窗口，不看数据库就宣布成功。

### 第十轮：一个 TypeError 造成的"新建会话还是旧会话"

用户报：新建会话后界面还停在旧会话，左下角刷一片
`Uncaught TypeError: Cannot read properties of null (reading 'runId')`。

**根因**：`renderSession()` 里那段整屏流转图 `gview` 是无条件拼的字符串，
草稿态（新建会话，`run === null`）也会执行到 `esc(run.runId)` → 抛异常。
异常发生在 `#feed.innerHTML = ...` **之前**，所以 DOM 保持原样 —— 屏幕上永远是上一个会话的内容；
2.5 秒轮询每跳一次就再抛一次，于是错误刷成一片。**不是"没新开"，是"新会话的渲染挂了"。**

修了三处：
1. `gview` 只在 `!isDraft && run` 时构造（`orchestra/index.html`），根除空指针；
2. 发送成功后立刻把视图切到新会话（`state.draft = {cwd}` + 重绘），并修掉 `waitNew()` 找到新 run
   却因为 draft 没清而加载不到的问题；等不到新 run 时也回退到最新会话，不再卡在草稿态；
3. 页面级错误提示同一条只累计次数（`×6`）、可点关，不再盖住输入框。

并给 `index.html` 加了 `?selftest=1`（5 条断言，结果写进 `document.title`），
headless Edge 就能跑：

```
msedge --headless=new --dump-dom "http://127.0.0.1:7788/?selftest=1"
→ <title>PASS 5/5</title>
```

教训：**UI 里的异步/模板异常一定要有可见出口 + 可自动跑的断言**。
这次如果只有"页面看起来停在旧会话"，会被误判成"派活逻辑没新开会话"，实际是渲染异常。

### 定名：Loom（织造）

讨论了几轮备选（Trony / Baton / Loom / Maestro / Fugue），最终选 **Loom**：
多根线（并行任务）织成一块布（一次交付），而且"打结"本身就意味着交接点要牢——正好是 handoff + 依赖收束。

命名层级（对外只有一个名字）：

| 层 | 名字 | 落点 |
|---|---|---|
| 产品 / 项目 | **Loom**（多 agent 编排器 · 织造） | `README.md`、控制台标题 |
| 调度 agent | **Trony harness** | 会话里的 `T` 气泡 + 「调度」标签 |
| 控制台 | Loom 控制台（这个页面） | `orchestra/index.html` |
| 引擎 / CLI | `yang`（内部代号，保留） | `yang-harness/yang.mjs` |

代码里 `orchestra/`、`yang-harness/` 目录名暂时没动（路径被 server、脚本、文档引用），
展示名已全量切换：`<title>`、`<h1>`、副标题、画布页标题。

### 第十一轮：可移植性 —— 别人的电脑上怎么跑起来

用户提出的真问题：**这套东西靠 CLI 调度，那 CLI 装在哪台机器的什么目录都不一样，别人拿到项目怎么用？**

审计结果：确实有两处会卡住别人

| 位置 | 原来 | 问题 |
|---|---|---|
| `dshLauncher()` | `const root = 'D:/develop/deepseek harness'` | 写死作者机器 |
| `scan` 的候选列表 | `'D:\\develop\\deepseek harness\\...\\dsh.cmd'` | 同上 |
| `codexBin()` | 扫 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` + `CODEX_BIN` | 已可用，但只覆盖 Windows 桌面端 |
| claude / cursor / opencode / gemini | 直接 `resolveBin('claude')`（只在 PATH 上找） | 装了但不在 PATH 就找不到 |

**改成三级解析**（`resolveAgentBin(kind)`，一张 `BIN_SPECS` 表统管 6 个 agent）：

1. `loom.config.json` 里手填的路径（最优先）
2. 环境变量：`LOOM_DSH_BIN` / `LOOM_CODEX_BIN` / `LOOM_CLAUDE_BIN` / `LOOM_DSH_HOME`（兼容旧的 `CODEX_BIN`、`DSH_BIN`）
3. 自动探测：dsh 找几个常见安装目录（看 `DeepSeek Harness.exe` / `resources\runtime\cli\bin\dsh.cmd`）；
   codex 扫 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 取最新；其余走 PATH

配套两个命令：

- **`yang doctor`**：把"每个 agent 我是怎么找到的、可不可用、缺了怎么修"摊成一张表，
  还会打印 DSH 路由（provider/model/来源）和 git 是否可用。换机器第一件事就跑它。
- **`yang init-config`**：生成 `loom.config.json` 模板。**故意只钉 `dsh.root`，bins 全部留空**——
  codex 的目录名带版本 hash，钉死反而会被一次升级弄坏，留空走自动探测更耐用。

分发用 `loom.config.example.json`（全空模板），`loom.config.json` 进 `.gitignore`，
不会把作者的本机路径带出去。

实测：`doctor` → dsh/codex/claude/opencode 四个自动认到，cursor/gemini 提示"装它或写路径"；
`--dry-run` 打出来的命令已经是解析后的真实路径（`...\dsh.cmd headless --patch ...`、`...\codex.exe exec ...`），退出码 0。

### 第十二轮：把 doctor 搬进界面

`yang doctor --json` 输出结构化报告；`GET /api/doctor` 转发它（`spawnSync` 30s 超时）；
控制台右上角新增「环境」按钮：

- 缺 agent 时按钮上带红色数字（`环境 2`），一眼看出这台机器还没配好
- 点开是一张表：agent / 状态 / 来源（配置文件 / 环境变量 / 自动探测）/ 解析到的真实路径
- 缺的那几个下面直接给"装它 or 写路径"两种修法，并提示改完跑 `doctor` 或点刷新
- `?doctor=1` 深链直接展开（远程排查、截图用），Esc 关闭
- 页面打开 1.2 秒后静默查一次，只为了点亮红点，不打扰

自检项从 5 条加到 6 条（多了「环境检查按钮在」），`?selftest=1` → PASS 6/6。

顺带修的显示问题：「来源」列自动换行把"自动探测"拆成两行 → 加 `white-space:nowrap`。

### 第十三轮：定名 Mesh（原名 Loom 废弃）

用户否掉了两批名字：Loom / 织造（"有点捞"，太软、太手工）、以及后来的 Marshal / Foreman / Relay / Gantry / Sortie / Reins 那批（隐喻味太重）。

第三批走**纯技术词汇**路线，用户选定 **Mesh**。

为什么是 Mesh：
- 业内本来就叫 agent mesh / service mesh —— 「多个 agent 互相发现、互相发消息」正是本项目在干的事，不是硬套比喻
- 4 个字母，`mesh run` / `mesh doctor` / `mesh.config.json` 都顺
- 不软：没有编织、指挥、牧羊那套

改名清单（已执行）：
- 界面：`<title>Mesh · 多 agent 编排器`、`<h1>Mesh`、副标题 `多 agent 编排器 · agent mesh`；workflow.html 同步
- 配置：`loom.config.json` → `mesh.config.json`，模板 `mesh.config.example.json`
- 环境变量前缀：`LOOM_*` → `MESH_*`（`MESH_DSH_BIN` / `MESH_CODEX_BIN` / `MESH_CLAUDE_BIN` / `MESH_DSH_HOME` / `MESH_CONFIG`）
- `.gitignore` 与 `.git/info/exclude` 同步
- README 标语从"织造/拧成一条产线"改成"把孤岛连成一张网"

命名经验（记下来，省得再绕）：这个项目的名字不该从**工艺/军事**取材（Loom、Marshal 都被否），
而应该从**自己所在的技术领域**取材 —— 名字本身就是它的工作原理。
