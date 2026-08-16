# Agent Note：orchestrator 插件对抗性审查与修复批次

Status: implemented

[English](2026-08-15-orchestrator-adversarial-review-fixes.md) | 中文

## 问题

五路独立对抗审查（门禁绕过、git 边界、schema 耐久、并发生命周期、工具面）共报告并实测确认 25 项独立缺陷；其中 4 项 critical：S0 可经裁决关闭而跳过目标冻结（此后目标在任意阶段仍可改写、管道可无哈希封印）、无界名称可毒化持久化存储导致下次 domain open 砖死主目录下全部管线、VCS 锚特性拒绝所有 SHA-1 仓库（含本仓库）、orchestrator_dispatch 在 recordDispatch 拒绝时泄漏已启动的子代理。本周新增的 VCS 锚代码独占 4 个 critical 中的 3 个，外加 G9 基线下界判反。

## 决策

一个修复批次，按缺陷类别纵深防御：

- **目标不可变性机械化**：S0 不再接受任何裁决（`verdictAllowed('S0', *) = false`），S0 只能经 `freezeGoal` 关闭；S0 工件编辑例外额外要求管线仍处于 S0。新增 G10 拒绝任何越过 S0 而未冻结目标的行——即使服务已无法产生此类行，不变量仍由门禁兜底。
- **持久化 schema 双边界执行**：写侧每次 `commit()` 先过 strict 行 schema（未知字段响亮失败，不再于重开时静默剥离）再过门禁；读侧 domain open 保留既有解析。名称界（导出 `NAME_MAX = 200`）在 `create`/`buildArtifact` 给出精确早失败，模型不会看到 schema 转储。
- **git 锚接受仓库真实对象格式**：head 为 40-hex sha1 或 64-hex sha256（`GIT_OBJECT_ID_HEX`，服务校验与 zod 共享）。暂存带相位门禁（仅 S3/S4、无已冻结 candidate、采样不早于编码阶段起始）；未来时间戳采样在捕获处拒绝——G9 下界删除，因先于创建采样正是基线文档化顺序。git 在退出码 0 下发出 stderr 也响亮失败（不可扫描子树绝不记为干净锚），采样用 `core.quotePath=false` 取字面路径，并传推导出的 execFile `maxBuffer` 使 4096 行上限先于 Node 默认 1 MiB 缓冲触发。
- **派发结算精确且完备**：`settleDispatch` 按 agent id 精确结算单条派发，拒绝非 ACTIVE 行与重复结算，子代理基础设施故障时记 `failed: true`。工具把 `recordDispatch` 移入 dispose 保护的 try——启动中途 revoke 不再孤儿化子代理。
- **原子阶段上报**：新 `reportStage` 把工件+让步+裁决作为单次入队变更提交；工具先验全部输入（工件种类、block 级别/位置/描述）再写任何东西。回退裁决在服务层即要求至少一条 block 项。`freezeGoal` 保留冻结前 S0 工件。`registerConcession`/`settleDispatch` 补上所有兄弟变更都有的 ACTIVE 守卫；`revoke` 像 `supersede` 校验后继一样校验修复引用（存在、非空、非自指、ACTIVE）。
- **路由求真**：被多 provider 列出的模型 id 报歧义错而非静默先赢；目录查询失败如实传播而非伪装成 "model not listed"。`boundText` 按码点切片，两个字符上限设有 64 下限，截断结果必带截断标记。
- **死代码清理**：G5（债务裁决）不可达——闭枚举 verdict 不可能携带 DEBT 标记；第 4 次回退文案不再暗示不存在的让步解锁。落盘行深冻结，变更结果永不别名中央态。

## 备选方案

服务侧 git 采样（否决：sidecar 保持 storage-only）。替代逐动词方法的批量 API（否决：`reportStage` 为工具组合它们，动词保留）。200 字符界只留 zod（否决：毒药行失效模式证明校验必须落在写入侧）。

## 后果

审计记录在持久化层获得防篡改（每次 commit 过 strict schema）；目标完整性从礼貌变为结构；VCS 锚特性在它要审计的仓库上真正可用。既有存储行与 strict schema 匹配（服务是唯一写入者）；不匹配的行在 open 时响亮拒绝，pre-release 立场视其为正确行为。模型可见工具文案有变（capture_vcs stderr 语义、歧义错误），tool catalog 已重新生成。

## 验证

三个 orchestrator 套件共 51 项测试（原 27），每项修复由一条在旧代码上必败的回归测试承载：S0 裁决拒绝与冻结后目标编辑、名称界拒绝加 commit 级 schema 兜底（未知字段与 201 字符名）、对本 SHA-1 仓库用生产 runner 的真实端到端捕获、相位/新鲜度门禁、按 id 结算带失败标记、原子 reportStage、引用校验、歧义与目录失败如实报错、码点安全截断。门禁：vitest（51/51）、tsc -b host+client、oxlint、文档门禁、tool-catalog --check、note 格式/分类。
