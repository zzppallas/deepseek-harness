# @deepseek-ai/dsh-client-ui-orchestrator

[English](README.md) | 中文

编排管线浏览器半插件：侧栏底部一个入口打开经 orchestrator Host Remote 驱动的模态浏览器。跨项目的每条管线按生命周期筛选展示（全部 / 进行中 / 已完成 / 已作废）；选中一条即可看到目标哈希、S0–S6B 阶段时间线（各阶段状态、verdict、回退次数、每次派发实际使用的模型），每个已登记工件点击即看全文。

纯展示插件：全部数据经 `orchestrator` Remote（`list` / `get` / `artifact`）到达；host 半无行为。

## 注册

- 槽位：`sidebar.footer.action`（list，id `orchestrator-pipelines`，order 20）。
- 语言命名空间：`orchestratorPipelines`（en/zh）。
- Cordis inject：`slots`、`remote`、`remote.orchestrator`、`locale`。
