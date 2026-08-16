# @deepseek-ai/dsh-client-ui-orchestrator

English | [中文](README.zh.md)

Browser half of the orchestrator pipelines surface: one sidebar-footer action opens a modal browser over the orchestrator Host Remote. Every pipeline from every project appears with a lifecycle filter (All / Active / Sealed / Voided); selecting one shows its goal hash and version-control anchor heads, the S0–S6B stage timeline with per-stage status, verdict, rollback count, and the model each dispatch actually used, and every recorded artifact is a click away from its full body.

Pure presentation plugin: all data arrives through the `orchestrator` Remote (`list` / `get` / `artifact`); no host-side behavior.

## Registration

- Slot: `sidebar.footer.action` (list, id `orchestrator-pipelines`, order 20).
- Locale namespace: `orchestratorPipelines` (en/zh).
- Cordis inject: `slots`, `remote`, `remote.orchestrator`, `locale`.