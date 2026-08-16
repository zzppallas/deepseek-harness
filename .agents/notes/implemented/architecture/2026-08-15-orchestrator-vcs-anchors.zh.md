# Agent Note：编排管线绑定版本控制锚

Status: implemented

[English](2026-08-15-orchestrator-vcs-anchors.md) | 中文

## 问题

封印后的管线行无法追溯到它执行时所对应的代码。持久化 schema 不含版本字段；candidate 的 `subjectHash` 对服务不透明（试跑中用 artifact 正文哈希作 subjectHash，全部门禁照常放行）；唯一取证路径跨越存储系统——派发 `agentId` 进会话日志，再用 `git log --since/--until` 夹逼时间窗。该路径在窗口内零提交时能精确证明 HEAD，但脏区内容只能到路径清单级，且会随历史改写而失效。

两个内容级机制在一次性仓库中实测后被否决：`git stash create` 静默漏掉未跟踪文件（恰是编码管线改动的文件）；`git add -N` + `write-tree` 静默丢弃 intent-to-add 条目，产物与 HEAD 树同哈希——看似坚固、实无信息的锚。临时索引全量 `write-tree` 快照忠实，但无 ref 时被 `git prune`/`gc` 回收，而往用户仓库写 ref 是管线不应静默承担的副作用。

## 决策

锚是管线行上的元数据，由显式的模型面工具采样，由机械门禁排序：

- `OrchestratorVcsAnchor { head, dirty[], capturedAt }`——HEAD sha（40-hex sha1 或 64-hex sha256，随被采样仓库的对象格式）加 `git status --porcelain` 行。行字段：`vcsBaseline`（goal 冻结时或之前捕获；先于创建采样是文档化顺序）与 `vcsCandidate`（暂存，由下一次 `freezeCandidate` 消费并绑定到冻结的 candidate 上）。回退到 S3 丢弃已暂存锚：下一代 candidate 必须重新采样，陈旧快照永远无法附着到新一代。
- 门禁 G9 对两者做时序约束：基线 `capturedAt <= goal.frozenAt`，candidate 锚 `capturedAt <= frozenAt`；未来时间戳采样在捕获处即被拒绝。服务只校验结构（git 对象 id head、1..4096 条非空 dirty 行、安全整数的捕获时间）与顺序，不校验采样真实性——保真属于执行 git 的工具层；持久化 zod schema 在读取时重申同样的界。G10 使「离开 S0 前必须冻结目标」成为前置条件。
- `orchestrator_capture_vcs`（工具层）经无 shell 的 `NativeCommandRunner` 边界采样（先 `git -C <projectRoot> rev-parse HEAD`，后 `git -c core.quotePath=false status --porcelain` 取字面路径），项目非 git 工作树时带 stderr 响亮失败，且成功扫描中 git 发出警告（不可扫描子树）同样响亮失败——绝不把不完整清单记成干净锚。按 `purpose` 分派到 `captureVcsBaseline` 或 `stageCandidateVcs`；candidate 暂存带相位门禁（仅 S3/S4、采样不早于编码阶段起始、尚无已冻结 candidate）。采样是显式动作而非自动：非 git 项目是合法环境，因此系统提示引导模型在后续审计需要时捕获锚，而不是让管线创建硬失败。
- `orchestrator_state` 与浏览器管线面板在目标哈希旁展示两个锚的 HEAD，审计者不触存储文件即可读出代码版本。

这使服务保持 storage-only（`dsh-orchestrator` 不引入子进程），git 知识留在消费者边界，且整条关系可仅凭持久化行回放。

## 备选方案

内容级 git 快照（`stash create`、`add -N` + `write-tree`、临时索引全量树）——依上文实测失效方式否决：静默漏未跟踪文件、静默丢 intent-to-add、无 ref 时被 gc 回收。在 `dsh-orchestrator` 内采样——否决：会给 storage-only 服务引入子进程与 git 知识。在 `create` 时自动采样——否决：非 git 项目是合法环境，管线创建不得因此失败；由工具呈现选择、系统提示引导。

## 后果

已提交代码可按管线精确追溯到 HEAD（基线与 candidate 双锚）；未提交工作可追溯到有界、带时间戳的路径清单，其捕获时刻受门禁排序。锚的诚实性停留在工具边界：服务无法察觉伪造的 HEAD，因此审计者信任锚，即是信任会话日志中与之相伴的工具调用。锚的增长有界（4096 条 dirty 行）；被 gitignore 的文件依 `git status --porcelain` 语义不可见——密钥卫生保留，但被忽略的生成物无锚。旧行（锚出现之前）保持有效：两个字段皆可选，无门禁强制要求。

## 验证

服务套件：创建期基线接受（含先于创建的采样）与 summary 投影、冻结后与畸形拒绝、暂存锚在 `freezeCandidate` 绑定及回退丢弃、相位/新鲜度门禁、捕获处未来时间戳拒绝。工具套件：真实插件组合（system-prompt、tool runtime、LLM 与 subagent 定义、storage 栈、服务），git 命令边界经认可的 runner 缝隙伪造，外加一次对真实仓库的端到端捕获（生产 execFile runner、40-hex sha1 HEAD 被接受）回归 sha256-only 缺陷。被否决的 git 机制连同其实测失效方式记录于上。
