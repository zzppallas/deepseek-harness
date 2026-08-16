# Agent Note: Orchestrator pipelines bind version-control anchors

Status: implemented

English | [中文](2026-08-15-orchestrator-vcs-anchors.zh.md)

## Problem

A sealed pipeline row could not be traced to the code it was executed against. The durable schema carries no version fields; the candidate `subjectHash` is opaque to the service (a trial run hashed an artifact body and every gate stayed green); and the only forensic path crossed storage systems — dispatch `agentId` into session logs, then `git log --since/--until` bracketing. That path proves the committed HEAD exactly when the window contains no commits, but dirty content only to path-listing level, and it decays as history rewrites the bracket.

Two content-level mechanisms were tested in a throwaway repository and rejected on evidence: `git stash create` silently omits untracked files (the very files a coding pipeline changes), and `git add -N` + `write-tree` silently drops intent-to-add entries, producing a hash identical to the HEAD tree — an anchor that looks strong and carries no information. A full temp-index `write-tree` snapshot is faithful but `git prune`/`gc` collects it without a ref, and writing refs into the user's repository is a side effect the pipeline must not take silently.

## Decision

Anchors are metadata on the pipeline row, sampled by an explicit model-facing tool, and ordered by a mechanical gate:

- `OrchestratorVcsAnchor { head, dirty[], capturedAt }` — HEAD sha (40-hex sha1 or 64-hex sha256, per the sampled repo's object format) plus `git status --porcelain` lines. Row fields: `vcsBaseline` (captured at or before the goal freeze; a pre-creation sample is the documented order) and `vcsCandidate` (staged, consumed by the next `freezeCandidate`, which binds it onto the frozen candidate). A rollback to S3 discards a staged anchor: the next candidate must sample afresh, so a stale snapshot can never attach to a new generation.
- Gate G9 orders both in time: baseline `capturedAt <= goal.frozenAt`, candidate anchor `capturedAt <= frozenAt`; future-dated samples are rejected at capture time instead. The service verifies structure (git object-id head, 1..4096 non-empty dirty lines, safe-integer capture time) and ordering, never sampling truth — fidelity belongs to the tool that ran git, and the durable zod schema re-asserts the same bounds on read. G10 makes a frozen goal a precondition for leaving S0.
- `orchestrator_capture_vcs` (tool layer) samples through the no-shell `NativeCommandRunner` boundary (`git -C <projectRoot> rev-parse HEAD`, then `git -c core.quotePath=false status --porcelain` for literal paths), fails loudly with git's stderr when the project is not a work tree AND when git emits warnings on a successful scan (an unscannable subtree must never record as a clean anchor), and dispatches by `purpose` to `captureVcsBaseline` or `stageCandidateVcs`. Candidate staging is phase-guarded (S3/S4 only, sample not older than the coding stage's start, no frozen candidate yet). Sampling is explicit, not automatic: a non-git project is a legitimate environment, so the system prompt directs the model to capture anchors when a later audit needs them instead of hard-failing pipeline creation.
- `orchestrator_state` and the browser pipelines panel surface both anchor heads next to the goal hash, so an auditor reads the code versions without touching the store file.

This keeps the service storage-only (no subprocess in `dsh-orchestrator`), keeps the consumer boundary where git knowledge lives, and makes the whole relationship replayable from the persisted row alone.

## Alternatives considered

Content-level git snapshots (`stash create`, `add -N` + `write-tree`, temp-index full tree) — rejected on the measured failure modes above: silent untracked omission, silent intent-to-add drop, and gc collection without a repository-side ref. VCS sampling inside `dsh-orchestrator` — rejected: it would put a subprocess and git knowledge into the storage-only service. Automatic sampling at `create` — rejected: a non-git project is a legitimate environment and pipeline creation must not fail on one; the tool surfaces the choice and the system prompt directs it.

## Consequences

Committed code traces to an exact HEAD per pipeline (baseline and candidate anchors); uncommitted work traces to a bounded, timestamped path listing whose capture moment the gate orders. Anchor honesty remains at the tool boundary: the service cannot detect a forged HEAD, so an auditor trusting an anchor trusts the tool call recorded in the session log alongside it. Anchor growth is bounded (4096 dirty lines); ignored files remain invisible by `git status --porcelain` semantics — secret-hygiene is preserved, but ignored generated files carry no anchor. Old rows (pre-anchor) stay valid: both fields are optional and no gate requires them.

## Verification

Service suite: baseline create-time acceptance (including pre-creation samples) and summary projection, post-freeze and malformed rejection, staged-anchor binding at `freezeCandidate` plus rollback discard, phase/freshness guards, and future-dated refusal at capture. Tool suite: a real plugin composition (system-prompt, tool runtime, LLM and subagent definitions, storage stack, service) with the git command boundary faked through the sanctioned runner seam, PLUS one end-to-end capture against the real repository (production execFile runner, 40-hex sha1 HEAD accepted) that regresses the sha256-only bug. The rejected git mechanisms are recorded above with their observed failure modes.
