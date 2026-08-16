# @deepseek-ai/dsh-tool-orchestrator

English | [中文](README.zh.md)

Model-facing orchestrator pipeline tools over the central [dsh-orchestrator](../orchestrator/README.md) sidecar. The DSH plugin form of the orchestrator multi-role methodology: pipelines live entirely in the central store (never in the working tree), every stage verdict passes mechanical gates, and every role dispatch carries a deployment-configured, live-validated model route.

## Tools

| Tool | Purpose |
|---|---|
| `orchestrator_start` | Create a pipeline at S0 with goal/task drafts. |
| `orchestrator_freeze_goal` | Freeze the goal hash (immutable afterwards); FULL→S1, LITE→S3. |
| `orchestrator_dispatch` | Run one role child for the current stage; route evaluated and validated before start. |
| `orchestrator_stage_report` | Record artifacts + verdict; PASS advances, BLOCK/FAIL rolls back, COMPLETE seals. |
| `orchestrator_capture_vcs` | Sample git HEAD + dirty listing (no shell, literal paths via quotePath=off) and bind it: `baseline` before the goal freezes, `candidate` staged during S3/S4. Git stderr on success (unscannable trees) fails the capture loudly. |
| `orchestrator_freeze_candidate` | Freeze the 64-hex candidate at S3→S4; approvals bind to it; a staged anchor binds with it. |
| `orchestrator_lifecycle` | `revoke` (with repairs pipeline) or `supersede` (with successor). |
| `orchestrator_state` | Inspect one row or list a project's pipelines. |

## Model routing (per role)

Deployment config maps each role to `{ provider?, model? }`; a call may override either field. Before any child starts, the route is evaluated against the live catalog: a named provider must exist, a named model must be listed by its provider (or resolve to exactly one provider when unnamed), otherwise the dispatch fails loud with the available ids. The resolved model is recorded on the stage dispatch and visible in the UI.

## Config

| Key | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | Subagent provider for role dispatches. |
| `roles.<role>.provider` | — | Provider override for that role's children. |
| `roles.<role>.model` | — | Model override for that role's children. |
| `maxDispatchChars` | `16384` (min 64) | Cap on one child output returned to the parent. |
| `maxResultChars` | `16384` (min 64) | Cap on one tool result text; slicing is code-point safe. |
| `gitRunner` | execFile | No-shell git command boundary (`NativeCommandRunner`); tests inject a fake. |

## Model Experience

### System prompt

#### What the model sees

Every request while this plugin is active receives the fixed orchestrator guidance section (order 117, name `tool:orchestrator`).

##### Orchestrator guidance

```markdown
Orchestrator pipeline tools: use orchestrator_start + orchestrator_freeze_goal for complex multi-module tasks needing staged roles and review gates, orchestrator_dispatch to run one role child (per-role model routing is deployment-configured and validated at dispatch), orchestrator_stage_report to record artifacts and PASS/BLOCK verdicts through mechanical gates (BLOCK rolls back; the 4th rollback at one stage needs a human decision), orchestrator_capture_vcs to bind git HEAD + dirty anchors when later audits must trace a pipeline to code versions (baseline before freezing the goal; candidate before freeze_candidate), orchestrator_freeze_candidate before S4 PASS, and orchestrator_state to inspect. Pipeline state lives in the central store — never write pipeline files into the working tree.
```

#### Token effect

Small fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the guidance text and plugin scope are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schemas

#### What the model sees

Eight tool schemas when visible: the seven pipeline verbs plus `orchestrator_capture_vcs`; the generated catalog section carries each complete schema ([tool-orchestrator section](../../../docs/tool-catalog.md#deepseek-aidsh-tool-orchestrator)).

#### Token effect

Substantial fixed schema cost on each request where the family is visible.

#### KV Cache effect

Schema text is static per deployment; changes to any tool definition invalidate reuse from the family's schema region.
