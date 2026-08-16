# @deepseek-ai/dsh-orchestrator

English | [中文](README.zh.md)

Central orchestrator pipeline sidecar for the DeepSeek Harness: the DSH plugin form of the orchestrator multi-role methodology. Every pipeline's state — goal anchor, per-stage records, review BLOCKs, candidate/approval bindings, dispatches with their resolved model, and every stage artifact body — lives in ONE storage-domain table under the DSH storage home, never in the project working tree. The browser reads it through Typert Remotes; model-facing tools drive it through service methods.

The service is the mechanical successor of the source skill's `orchestrator-state-check`: the same invariants (frozen goal hash, required artifacts per stage, 3-rollback cap, debt verdicts requiring registered concessions, candidate-bound approvals, phase closure) are evaluated as pure gates in `src/gates.ts`, and `commit()` refuses to persist any row a gate would fail.

## Vocabulary

- **Phases** `S0..S6B` in canonical order; `COMPLETE` is the sealed terminal.
- **Modes** `FULL` (six-role review spine) and `LITE` (S1/S2 close as `LITE-MERGED`, lighter S3 requirements).
- **Lifecycle** `ACTIVE → SEALED`, plus `SUPERSEDED` (with `supersededBy`) and `REVOKED` (with `repairsPipeline`) as the two voided endings.
- **Verdicts** `PASS`, `BLOCK`/`FAIL` (rollback), `LITE-MERGED`, `COMPLETE` (S6B only, seals).
- **Rollbacks** BLOCK/FAIL at S2 reopens S1; at S4/S5/S6A reopens S3 and invalidates the candidate plus approvals; BLOCK/FAIL requires at least one block item; the 4th rollback at one stage is rejected — the human must revoke or supersede the pipeline.
- **VCS anchors** optional version-control snapshots (git HEAD + dirty listing; 40-hex sha1 or 64-hex sha256 heads) bound to pipeline moments: a `vcsBaseline` captured at or before the goal freeze, and a candidate anchor staged during S3/S4 — never older than the coding stage's start — before `freezeCandidate` binds it. Gate G9 orders both in time; future-dated samples are rejected at capture; a rollback to S3 discards a staged anchor so the next candidate samples afresh. The service verifies structure and ordering, never sampling truth — the tool that ran git owns fidelity.

## Remotes

| Method | Shape |
|---|---|
| `list` | `{ projectRoot? } → { pipelines: OrchestratorPipelineSummary[] }` (newest first, no artifact bodies) |
| `get` | `{ id } → OrchestratorPipelineRow` (full row with artifact bodies) |
| `artifact` | `{ id, phase, name } → OrchestratorArtifactValue` |

## Service methods (tool-facing)

`create`, `freezeGoal`, `recordArtifact`, `recordVerdict`, `reportStage` (one atomic artifacts+verdict transition), `freezeCandidate`, `registerConcession`, `recordDispatch`, `settleDispatch` (targets one dispatch by agent id, records `failed` on infrastructure faults), `captureVcsBaseline`, `stageCandidateVcs`, `revoke`, `supersede` — every mutation runs on a per-pipeline serialized queue and returns `{ row, effect }`. S0 closes only through `freezeGoal`; every commit first validates against the durable schema (strict; out-of-bound or unknown fields reject), then against gates G1–G10, and the committed row is deep-frozen.

## Config

| Key | Default | Meaning |
|---|---|---|
| `maxArtifactBytes` | `262144` | Maximum UTF-8 byte length accepted for one artifact body. |

Sources: [`src/index.ts`](src/index.ts) (service), [`src/gates.ts`](src/gates.ts) (pure gates + transitions), [`src/spec.ts`](src/spec.ts) (durable domain), [`src/types.ts`](src/types.ts) (client-safe vocabulary).

## Model Experience

Indirectly, through the orchestrator tool family in `@deepseek-ai/dsh-tool-orchestrator`, which owns the system-prompt guidance, tool schemas, and result rendering over this sidecar's service methods.

#### KV Cache effect

No model context is registered by this package, so cache behavior follows the tool plugin's prompt section and schemas.
