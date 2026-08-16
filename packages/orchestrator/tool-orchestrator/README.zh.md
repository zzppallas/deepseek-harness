# @deepseek-ai/dsh-tool-orchestrator

[English](README.md) | 中文

中央 [dsh-orchestrator](../orchestrator/README.md) sidecar 之上的模型面编排管线工具：orchestrator 多角色方法论的 DSH 插件形态。管线状态完全存放在中央存储（绝不落入工作树），每个阶段 verdict 都过机械门禁，每次角色派发都携带部署配置、经实时校验的模型路由。

## 工具

| 工具 | 用途 |
|---|---|
| `orchestrator_start` | 在 S0 创建管线并起草 goal/task。 |
| `orchestrator_freeze_goal` | 冻结目标哈希（此后不可变）；FULL→S1，LITE→S3。 |
| `orchestrator_dispatch` | 为当前阶段派发一个角色子 Agent；启动前评估并校验路由。 |
| `orchestrator_stage_report` | 登记工件 + verdict；PASS 推进、BLOCK/FAIL 回退、COMPLETE 封印。 |
| `orchestrator_capture_vcs` | 无 shell 采样 git HEAD + 脏区清单（quotePath=off 取真实路径）并绑定：`baseline` 限 goal 冻结前，`candidate` 限 S3/S4 暂存。成功路径上的 git stderr（不可扫描子树）使捕获响亮失败。 |
| `orchestrator_freeze_candidate` | 在 S3→S4 边界冻结 64-hex Candidate；审批绑定于它；已暂存的版本锚随之绑定。 |
| `orchestrator_lifecycle` | `revoke`（附修复管线）或 `supersede`（附后继管线）。 |
| `orchestrator_state` | 查看单条管线或按项目根列出全部。 |

## 模型路由（按角色）

部署配置把每个角色映射为 `{ provider?, model? }`；调用可覆盖任一字段。子 Agent 启动前先对着实时目录评估路由：指定的 provider 必须存在，指定的 model 必须被其 provider 列出（未指定 provider 时必须唯一可解析），否则带可用 id 列表响亮失败。解析出的模型记录在阶段派发上，UI 可见。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 角色派发所用子 Agent provider。 |
| `roles.<role>.provider` | — | 该角色子 Agent 的 provider 覆盖。 |
| `roles.<role>.model` | — | 该角色子 Agent 的 model 覆盖。 |
| `maxDispatchChars` | `16384`（最小 64） | 返回给父级的单次子输出上限。 |
| `maxResultChars` | `16384`（最小 64） | 单个工具结果文本上限；切片按码点安全处理。 |
| `gitRunner` | execFile | 无 shell git 命令边界（`NativeCommandRunner`）；测试注入假实现。 |

## Model Experience

### System prompt

#### What the model sees

插件激活期间的每个请求都收到固定的 orchestrator 指引段（order 117，名称 `tool:orchestrator`）；逐字正文如下。

##### Orchestrator guidance

```markdown
Orchestrator pipeline tools: use orchestrator_start + orchestrator_freeze_goal for complex multi-module tasks needing staged roles and review gates, orchestrator_dispatch to run one role child (per-role model routing is deployment-configured and validated at dispatch), orchestrator_stage_report to record artifacts and PASS/BLOCK verdicts through mechanical gates (BLOCK rolls back; the 4th rollback at one stage needs a human decision), orchestrator_capture_vcs to bind git HEAD + dirty anchors when later audits must trace a pipeline to code versions (baseline before freezing the goal; candidate before freeze_candidate), orchestrator_freeze_candidate before S4 PASS, and orchestrator_state to inspect. Pipeline state lives in the central store — never write pipeline files into the working tree.
```

#### Token effect

插件激活期间每请求固定的小额指引开销。

#### KV Cache effect

指引文本与插件作用域不变则前缀稳定；激活或停用可能使本段的前缀复用失效。

### Tool schemas

#### What the model sees

可见时呈现八个工具 schema：七个管线动词加 `orchestrator_capture_vcs`；完整 schema 见生成目录的 [tool-orchestrator 小节](../../../docs/tool-catalog.md#deepseek-aidsh-tool-orchestrator)。

#### Token effect

工具族可见的每个请求承担可观的固定 schema 开销。

#### KV Cache effect

Schema 文本在部署内静态；任一工具定义变更都会使该族 schema 区域的前缀复用失效。
