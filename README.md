# Loom · 多 agent 编排器

> 织造：把 codex / dsh / claude 这些各自独立的 agent 拧成一条产线。
> 你说一句话，它拆活、派活、验收、交接，并且每个 agent 在自己客户端里都留下真实会话。

仓库：<https://github.com/Tron-y/Loom>

调度者是一个 agent，叫 **Trony harness**（跑在 DSH 模型上，自己不写代码，只负责拆活/派活/验收/交接）。

## 一句话怎么用

1. 打开控制台 `http://127.0.0.1:7788`
2. 左边 `＋` 选一个项目目录 → 点 `＋` 新建会话
3. 在底部输入框说人话，例如：

   > 做一个纯 HTML 三页站点，后端用 dsh 写接口，前端用 codex 做注册页，最后 claude 验收

发出去就开工了。它会自己拆任务、按 tag 挑人、并行跑、跑完验收，再合并。

## 它怎么"控制"别的 agent

**走 CLI，不操作界面、不模拟点击。** 每个 agent 就是一个 `yang-harness/agents/*.md` 文件，
`adapter` 字段决定起哪条命令：

| adapter | 实际命令 |
|---|---|
| `codex-exec` | `codex exec "<prompt>" --json --skip-git-repo-check -s workspace-write` |
| `dsh-headless` | `"DeepSeek Harness.exe" --expose-internals <cli.js> headless "<prompt>"` |
| `claude-print` | `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode acceptEdits` |
| `cursor-agent` / `opencode-run` / `gemini-print` | `cursor-agent -p` / `opencode run` / `gemini -p` |
| `exec` / `shell` | 任意命令（演示、纯脚本） |

统一只有一层：

```js
spawn(cmd, args, { cwd: 项目目录 })   // cwd = 在哪个项目干活，args = 开新会话 + prompt
```

- **"新建目录"** = 进程的 `cwd`
- **"新建对话"** = 每次 `exec` 都是全新会话（不是 resume）
- **"发送内容"** = prompt 作为命令行参数

之后文件改动、会话日志、退出码都由各 CLI 自己落盘；Loom 只看文件改动 + 验收命令的退出码。

## 换一台电脑怎么用（安装路径不一样的问题）

每台机器上 codex / dsh / claude 装在哪都不一样，所以**没有任何路径写死在代码里**。解析顺序：

1. **`loom.config.json`**（自己填的，最优先）
2. **环境变量**：`LOOM_DSH_BIN` / `LOOM_CODEX_BIN` / `LOOM_CLAUDE_BIN` / `LOOM_DSH_HOME`（也兼容 `CODEX_BIN`、`DSH_BIN`）
3. **自动探测**：
   - dsh → 找 `%LOCALAPPDATA%\Programs\deepseek harness`、`C:\Program Files\deepseek harness` 等几个常见位置，看里面有没有 `DeepSeek Harness.exe` / `resources\runtime\cli\bin\dsh.cmd`
   - codex → 扫 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`（桌面端就装在这，多个版本取最新）
   - claude / cursor-agent / opencode / gemini → 走 `PATH`

三步上手：

```bash
# 1. 先看它认到了什么（换机器第一件事）
node yang-harness/yang.mjs doctor

# 2. 有没认到的，生成一份模板，把路径填进去
node yang-harness/yang.mjs init-config
#    或者手写：cp loom.config.example.json loom.config.json

# 3. 再自检一次，全绿就开工
node yang-harness/yang.mjs doctor
```

`doctor` 输出长这样，缺什么、该填什么一眼能看到：

```
agent     状态        来源              解析到
dsh       ✅ 可用      自动探测          D:\develop\deepseek harness\resources\runtime\cli\bin\dsh.cmd
codex     ✅ 可用      自动探测          C:\Users\...\OpenAI\Codex\bin\1cb21d4e\codex.exe
claude    ✅ 可用      自动探测          claude
cursor    ❌ 没找到    missing           —
  · cursor：装 cursor-agent，或写 "cursor": "<路径>"
```

`loom.config.json` 里就是一张路径表：

**界面上也能看**：控制台右上角有个「环境」按钮，缺几个 agent 就显示红色数字（如 `环境 2`）。
点开就是上面这张表 + 每个缺失项的修法；`?doctor=1` 可以直接打开（截图/远程排查用），Esc 关闭。
```json
{
  "bins": { "codex": "", "claude": "", "dsh": "" },
  "dsh": { "root": "你的 DeepSeek Harness 安装目录" },
  "defaults": { "planner": "deepseek-flash", "parallel": 3 }
}
```

留空 = 用自动探测。这个文件已加进 `.gitignore`，不会把你的本机路径提交出去；
分发时给别人 `loom.config.example.json` 当模板。

## 目录

```
orchestra/            控制台（零依赖 Node HTTP + 单页，端口 7788）
  index.html          会话界面（对话流 / 流转图）
  workflow.html       辅助画布（可收起）
yang-harness/
  yang.mjs            编排引擎（CLI）
  agents/*.md         agent 池：frontmatter 里写 adapter / tags / verify / writes
runs/                 每次任务的产物：state.json、bus.ndjson、日志、handoff
```

## 留痕：每个 agent 的真实会话在哪

| agent | 位置 |
|---|---|
| dsh | `~/.dsh/sessions/<编码后的项目路径>/`（并登记进 DSH 的项目列表） |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，同时写进 Codex 应用的 `state_5.sqlite`（自动挂到项目下、侧栏可见） |
| claude | `~/.claude/projects/<编码后的路径>/<session>.jsonl` |

会话标题取"任务名"，所以你在 Codex 侧栏看到的就是人话，不是一整段 prompt。

## 自检

```bash
# 界面回归（headless Edge 也能跑，结果写进 title）
msedge --headless=new --dump-dom "http://127.0.0.1:7788/?selftest=1"   # → <title>PASS 5/5</title>

# 编排引擎
node yang-harness/yang.mjs --help
```

## 加一个 agent

复制 `agents/` 里任意一个 md，改四行就可用，不用改代码：

```yaml
---
name: frontend-codex
tags: [frontend, web, ui]        # 派活时按这个匹配
adapter: codex-exec              # 用哪个 CLI
priority: 9
verify: node -e "..."            # 验收命令，不过闸不算完
writes: [public/**, index.html]  # 可写范围
---
你是在 Codex 里工作的前端工程师……
```
