# Agent Note: Adversarial review of the orchestrator plugin and the fix batch

Status: implemented

English | [中文](2026-08-15-orchestrator-adversarial-review-fixes.zh.md)

## Problem

Five independent adversarial reviewers attacked dsh-orchestrator and dsh-tool-orchestrator (gate bypass, git boundary, schema durability, concurrency/lifecycle, tool surface). 25 distinct defects were reported and probe-confirmed; four were critical: S0 could close by verdict without freezing the goal (the goal then stayed mutable at any phase and the pipeline could seal hash-less), an unbounded name could poison the durable store so the next domain open bricked every pipeline in the storage home, the VCS-anchor feature rejected every SHA-1 repository (including this one), and orchestrator_dispatch leaked a started child when recordDispatch rejected. The VCS-anchor code added the same week carried three of the four criticals plus the inverted G9 baseline bound.

## Decision

One fix batch, defense in depth per defect class:

- **Goal immutability is mechanical**: no verdict is reportable at S0 (`verdictAllowed('S0', *) = false`); S0 closes only through `freezeGoal`. The S0 artifact-edit exception additionally requires the pipeline to still be AT S0. New gate G10 rejects any row past S0 with an unfrozen goal, making the invariant gate-enforced even though the service can no longer produce such a row.
- **The durable schema is enforced at both boundaries**: write-side, every `commit()` runs the strict row schema (unknown fields now fail loud instead of being stripped on reopen) and then the gates; read-side, the domain open keeps its existing parse. Early, precise errors for the name bound (exported `NAME_MAX = 200`) sit in `create`/`buildArtifact` so the model never sees a schema dump.
- **Git anchors accept the repo's real object format**: heads are 40-hex sha1 or 64-hex sha256 (`GIT_OBJECT_ID_HEX`, shared by the service validator and the zod schema). Staging is phase-guarded (S3/S4 only, no frozen candidate, sample not older than the coding stage's start) and future-dated samples are rejected at capture — the G9 lower bound is removed because a pre-creation sample is the documented baseline order. Sampling fails loud on git stderr even with exit 0 (an unscannable tree must never record as a clean anchor), uses `core.quotePath=false` for literal paths, and passes a derived execFile `maxBuffer` so the 4096-line cap fires before Node's default 1 MiB buffer.
- **Dispatch settlement is exact and total**: `settleDispatch` targets one dispatch by agent id, refuses non-ACTIVE rows and double settlement, and records `failed: true` when a child run rejects on an infrastructure fault. The tool moves `recordDispatch` inside the dispose-guarded try, so a mid-start revocation can no longer orphan a child.
- **Atomic stage reports**: new `reportStage` commits artifacts + concession + verdict as one enqueued mutation; the tool pre-validates every input (artifact kinds, block level/location/description) before anything is written. Rollback verdicts require at least one block item at the service layer. `freezeGoal` preserves pre-freeze S0 artifacts. `registerConcession`/`settleDispatch` gained the ACTIVE guard every sibling mutation had; `revoke` validates its repairs referent like `supersede` validates its successor (existence, non-empty, not self, ACTIVE).
- **Routing truth**: a model id listed by several providers is an ambiguity error instead of a silent first-wins, and catalog failures propagate instead of masquerading as "model not listed". `boundText` slices by code points and both character caps have a floor of 64 so a truncated result always carries the truncation marker.
- **Dead-code removal**: G5 (debt verdicts) was unreachable — the closed verdict enum cannot carry a DEBT token — and the 4th-rollback message stopped offering a concession escape that does not exist. The committed row is deep-frozen so mutation results never alias live central state.

## Alternatives considered

Service-side git sampling (rejected: keeps the sidecar storage-only). A batch API that replaced the existing per-verb methods (rejected: `reportStage` composes them for the tool while the verbs stay available). Keeping the 200-char bound only in zod (rejected: the poison-row failure mode proved validation must live at the write).

## Consequences

Audit records are now tamper-resistant at the persistence layer (strict schema on every commit), goal integrity is structural rather than courtesy, and the VCS-anchor feature works on the repositories it is meant to audit. Existing stored rows match the strict schema because the service is the only writer; a row that does not match is rejected loudly on open, which pre-release treats as correct. Model-visible tool texts changed (capture_vcs stderr semantics, ambiguity errors), so the tool catalog was regenerated.

## Verification

51 tests across the three orchestrator suites (up from 27), each fix carried by a regression test that fails on the old code: S0 verdict refusal and post-freeze goal edits, name-bound rejection plus a commit-level schema backstop (unknown fields and 201-char names), a real end-to-end capture against this SHA-1 repository with the production runner, phase/freshness guards, per-id settlement with failure flags, atomic reportStage, referent validation, ambiguity and loud catalog failures, and code-point-safe truncation. Gates: vitest (51/51), tsc -b host+client, oxlint, doc gates, tool-catalog --check, note format/classification.
