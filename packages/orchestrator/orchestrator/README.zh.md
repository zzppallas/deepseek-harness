# @deepseek-ai/dsh-orchestrator

[English](README.md) | 中文

DeepSeek Harness 的集中式编排管线 sidecar：orchestrator 多角色方法论的 DSH 插件形态。每条管线的状态——目标锚、各阶段记录、评审 BLOCK、Candidate/审批绑定、带已解析模型的派发记录，以及全部阶段工件正文——都存放在 DSH 存储主目录下的同一张 storage-domain 表中，绝不落在项目工作树里。浏览器经 Typert Remotes 读取；模型面工具经服务方法驱动。

本服务是源技能 `orchestrator-state-check` 的机械化继任者：同样的不变量（冻结目标哈希、各阶段必需工件、3 次回退上限、含债 verdict 必须登记让步、审批绑定 Candidate、阶段闭合）在 `src/gates.ts` 中以纯函数门禁求值，`commit()` 拒绝持久化任何会被门禁判 FAIL 的行。

## 词汇表

- **阶段** `S0..S6B` 固定顺序；`COMPLETE` 为封印终态。
- **模式** `FULL`（六角色评审主干）与 `LITE`（S1/S2 以 `LITE-MERGED` 收口，S3 要求更轻）。
- **生命周期** `ACTIVE → SEALED`，外加两种作废终态：`SUPERSEDED`（带 `supersededBy`）与 `REVOKED`（带 `repairsPipeline`）。
- **Verdict** `PASS`、`BLOCK`/`FAIL`（回退）、`LITE-MERGED`、`COMPLETE`（仅 S6B，封印）。
- **回退** S2 的 BLOCK/FAIL 重开 S1；S4/S5/S6A 的回退重开 S3 并作废 Candidate 与全部审批；BLOCK/FAIL 必须至少携带一条 block 项；同一阶段第 4 次回退被拒绝——必须由人工作废或 supersede 该管线。
- **版本锚** 可选的版本控制快照（git HEAD + 脏区清单；40-hex sha1 或 64-hex sha256 头）绑定到管线时刻：`vcsBaseline` 在 goal 冻结时或之前捕获；candidate 锚仅在 S3/S4 窗口内、不早于编码阶段起始时暂存，由 `freezeCandidate` 随冻结绑定。门禁 G9 对两者做时序约束；未来时间戳采样在捕获处即被拒绝；回退到 S3 会丢弃已暂存锚，下一代 Candidate 必须重新采样。服务只校验结构与顺序，不校验采样真实性——保真属于执行 git 的工具层。

## Remote

| 方法 | 形状 |
|---|---|
| `list` | `{ projectRoot? } → { pipelines: OrchestratorPipelineSummary[] }`（按更新时间倒序，不含工件正文） |
| `get` | `{ id } → OrchestratorPipelineRow`（含工件正文的完整行） |
| `artifact` | `{ id, phase, name } → OrchestratorArtifactValue` |

## 服务方法（工具面）

`create`、`freezeGoal`、`recordArtifact`、`recordVerdict`、`reportStage`（工件+裁决的原子单次迁移）、`freezeCandidate`、`registerConcession`、`recordDispatch`、`settleDispatch`（按 agent id 精确结算单条派发，基础设施故障记 `failed`）、`captureVcsBaseline`、`stageCandidateVcs`、`revoke`、`supersede` —— 每个变更都在按管线串行的队列上执行并返回 `{ row, effect }`。S0 只能经 `freezeGoal` 关闭；每次 commit 先过持久化 schema（strict：越界或未知字段拒绝）再过 G1–G10 门禁，落盘行深冻结。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `maxArtifactBytes` | `262144` | 单个工件正文接受的最大 UTF-8 字节数。 |

源码：[`src/index.ts`](src/index.ts)（服务）、[`src/gates.ts`](src/gates.ts)（纯门禁 + 迁移）、[`src/spec.ts`](src/spec.ts)（持久化域）、[`src/types.ts`](src/types.ts)（客户端安全词汇）。

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-orchestrator` 中的 orchestrator 工具族——系统提示指引、工具 schema 与结果渲染均由该工具包在本 sidecar 服务方法之上持有。

#### KV Cache effect

本包不注册任何模型上下文；缓存行为随工具包的提示段与 schema 而定。
