/**
 * Client-safe domain vocabulary for the orchestrator pipeline sidecar.
 * @module @deepseek-ai/dsh-orchestrator/types
 */

/** Pipeline phase ids in canonical order. */
export type OrchestratorPhase =
  | 'S0'
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4'
  | 'S5'
  | 'S6A'
  | 'S6B'

/** Terminal pseudo-phase once a pipeline is sealed. */
export type OrchestratorCurrentPhase = OrchestratorPhase | 'COMPLETE'

/** FULL runs the six-role review spine; LITE merges S1/S2 and lightens S3. */
export type OrchestratorMode = 'FULL' | 'LITE'

/** Risk vocabulary mirroring the source skill's riskClass. */
export type OrchestratorRisk = 'LOW' | 'STRUCTURAL' | 'STATEFUL' | 'CRITICAL'

/** Lifecycle of one pipeline record. */
export type OrchestratorLifecycle = 'ACTIVE' | 'SEALED' | 'SUPERSEDED' | 'REVOKED'

/** Per-stage execution status. */
export type OrchestratorStageStatus = 'PENDING' | 'ACTIVE' | 'DONE' | 'BLOCKED'

/** Verdict a stage closes with. COMPLETE is valid only at S6B. */
export type OrchestratorVerdict = 'PASS' | 'BLOCK' | 'FAIL' | 'LITE-MERGED' | 'COMPLETE'

/** Artifact taxonomy keyed off the source skill's document family. */
export type OrchestratorArtifactKind =
  | 'goal'
  | 'task'
  | 'architecture'
  | 'review'
  | 'coding-batch'
  | 'coverage-review'
  | 'codereview'
  | 'qa-report'
  | 'final-audit'
  | 'final'
  | 'receipt'
  | 'probe'
  | 'candidate'
  | 'note'

/** Role ids dispatchable to subagents, by phase. */
export type OrchestratorRole =
  | 'architect'
  | 'reviewer'
  | 'coder'
  | 'coverage-reviewer'
  | 'code-reviewer'
  | 'qa'
  | 'auditor'

/** Severity of one review BLOCK item. */
export type OrchestratorBlockLevel = 'Critical' | 'Scoped'

/** One review BLOCK entry carried on a stage. */
export interface OrchestratorBlockItem {
  /** Critical = architectural/contract breach; Scoped = point fix. */
  readonly level: OrchestratorBlockLevel
  /** file:line or section anchor. */
  readonly location: string
  /** What is wrong. */
  readonly description: string
}

/** One durable artifact stored centrally with the pipeline. */
export interface OrchestratorArtifact {
  /** Stable name unique inside its stage, kebab-ish identifier. */
  readonly name: string
  /** Taxonomy entry driving required-artifact gates. */
  readonly kind: OrchestratorArtifactKind
  /** SHA-256 of the UTF-8 content, hex lowercase. */
  readonly sha256: string
  /** Content byte length. */
  readonly bytes: number
  /** Full text content (markdown-centric). */
  readonly content: string
  /** Epoch ms when recorded. */
  readonly createdAt: number
}

/** One subagent dispatch bound to a stage, with its resolved LLM route. */
export interface OrchestratorDispatch {
  /** Role the child played. */
  readonly role: OrchestratorRole
  /** Durable child session id when the provider mints one. */
  readonly agentId?: string
  /** Subagent provider name used. */
  readonly provider?: string
  /** Model id actually used (after resolution and validation). */
  readonly model?: string
  /** Epoch ms when the dispatch started. */
  readonly dispatchedAt: number
  /** Epoch ms when the child settled, when it did. */
  readonly settledAt?: number
  /** Whether the child has settled. */
  readonly settled: boolean
  /** Whether the child settled through an infrastructure failure. */
  readonly failed?: boolean
}

/** One pipeline stage record. */
export interface OrchestratorStage {
  /** Canonical phase id. */
  readonly phase: OrchestratorPhase
  /** Execution status. */
  readonly status: OrchestratorStageStatus
  /** Verdict recorded when the stage closed (DONE/BLOCKED). */
  readonly verdict?: OrchestratorVerdict
  /** BLOCK items recorded on the stage, newest rollback included. */
  readonly blocks?: readonly OrchestratorBlockItem[]
  /** Artifacts recorded into this stage. */
  readonly artifacts: readonly OrchestratorArtifact[]
  /** Subagent dispatches bound to this stage. */
  readonly dispatches: readonly OrchestratorDispatch[]
  /** Rollback attempts consumed at this stage (cap 3). */
  readonly attempts: number
  /** Epoch ms when the stage first activated. */
  readonly startedAt?: number
  /** Epoch ms when the stage closed DONE. */
  readonly finishedAt?: number
}

/** One approval bound to the frozen candidate. */
export interface OrchestratorApproval {
  /** Approval-owning phase. */
  readonly phase: 'S4' | 'S5' | 'S6A'
  /** Candidate subjectHash approved. */
  readonly subjectHash: string
  /** Epoch ms. */
  readonly grantedAt: number
}

/** One registered concession (debt verdict requires these). */
export interface OrchestratorConcession {
  /** Phase whose verdict carried the debt token. */
  readonly phase: OrchestratorPhase
  /** Why the concession was granted, quoting the debt wording. */
  readonly reason: string
  /** Who granted it (human-confirmed wording). */
  readonly grantedBy: string
  /** Epoch ms. */
  readonly grantedAt: number
}

/** Frozen goal anchor. sha256 null until S0 is frozen. */
export interface OrchestratorGoal {
  /** Goal text (immutable once frozen). */
  readonly text: string
  /** Task brief text. */
  readonly taskText?: string
  /** SHA-256 of the UTF-8 goal text once frozen. */
  readonly sha256?: string
  /** Epoch ms when frozen. */
  readonly frozenAt?: number
}

/** The frozen implementation candidate (simplified R12). */
export interface OrchestratorCandidate {
  /** Workspace manifest aggregate hash or equivalent subject token. */
  readonly subjectHash: string
  /** Monotone generation, starts at 1. */
  readonly generation: number
  /** Epoch ms when frozen. */
  readonly frozenAt: number
  /** Version-control anchor captured at or before the freeze, when one was staged. */
  readonly vcs?: OrchestratorVcsAnchor
}

/**
 * One version-control snapshot bound to a pipeline moment: the commit HEAD
 * plus the `git status --porcelain` dirty listing as observed at capture
 * time. The service verifies structure and ordering, never content truth —
 * the sampling tool owns fidelity to the real repository.
 */
export interface OrchestratorVcsAnchor {
  /** Commit sha the snapshot was taken at (lowercase 64-hex). */
  readonly head: string
  /** `git status --porcelain` output lines, one entry each. */
  readonly dirty: readonly string[]
  /** Epoch ms when the snapshot was captured. */
  readonly capturedAt: number
}

/** One whole pipeline sidecar row. */
export interface OrchestratorPipelineRow {
  /** Opaque pipeline id (uuid). */
  readonly id: string
  /** Human pipeline name (kebab-ish). */
  readonly name: string
  /** Absolute project root this pipeline belongs to. */
  readonly projectRoot: string
  /** Mode chosen at creation. */
  readonly mode: OrchestratorMode
  /** Risk class. */
  readonly riskClass: OrchestratorRisk
  /** Lifecycle. */
  readonly lifecycle: OrchestratorLifecycle
  /** Current phase, or COMPLETE once sealed. */
  readonly currentPhase: OrchestratorCurrentPhase
  /** Goal anchor. */
  readonly goal: OrchestratorGoal
  /** Stage records in canonical phase order for the mode. */
  readonly stages: readonly OrchestratorStage[]
  /** Frozen candidate, when one exists. */
  readonly candidate?: OrchestratorCandidate
  /** Baseline version-control anchor captured before the goal froze. */
  readonly vcsBaseline?: OrchestratorVcsAnchor
  /** Staged candidate anchor awaiting the next candidate freeze. */
  readonly vcsCandidate?: OrchestratorVcsAnchor
  /** Approvals bound to the candidate. */
  readonly approvals: readonly OrchestratorApproval[]
  /** Registered concessions. */
  readonly concessions: readonly OrchestratorConcession[]
  /** Successor pipeline id when SUPERSEDED. */
  readonly supersededBy?: string
  /** Repairs-pipeline id when REVOKED. */
  readonly repairsPipeline?: string
  /** Epoch ms creation. */
  readonly createdAt: number
  /** Epoch ms last update. */
  readonly updatedAt: number
}

/** Summary projection for lists (no artifact bodies). */
export interface OrchestratorPipelineSummary {
  readonly id: string
  readonly name: string
  readonly projectRoot: string
  readonly mode: OrchestratorMode
  readonly riskClass: OrchestratorRisk
  readonly lifecycle: OrchestratorLifecycle
  readonly currentPhase: OrchestratorCurrentPhase
  /** Per-stage status + verdict + artifact count + dispatch count. */
  readonly stages: readonly {
    readonly phase: OrchestratorPhase
    readonly status: OrchestratorStageStatus
    readonly verdict?: OrchestratorVerdict
    readonly artifactCount: number
    readonly dispatchCount: number
    readonly attempts: number
    readonly lastModel?: string
  }[]
  readonly goalFrozen: boolean
  /** Baseline anchor HEAD sha, when a baseline was captured. */
  readonly baselineHead?: string
  /** Frozen candidate's anchor HEAD sha, when the candidate carries one. */
  readonly candidateHead?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Remote: list pipelines, optionally narrowed to one project root. */
export interface OrchestratorListRequest {
  readonly projectRoot?: string
}

/** Remote: fetch one full pipeline row. */
export interface OrchestratorGetRequest {
  readonly id: string
}

/** Remote: fetch one artifact body. */
export interface OrchestratorArtifactRequest {
  readonly id: string
  readonly phase: OrchestratorPhase
  readonly name: string
}

/** One artifact body reply. */
export interface OrchestratorArtifactValue {
  readonly phase: OrchestratorPhase
  readonly name: string
  readonly kind: OrchestratorArtifactKind
  readonly sha256: string
  readonly bytes: number
  readonly content: string
  readonly createdAt: number
}

/** Business failure codes for the remote surface. */
export type OrchestratorFailureCode =
  | 'pipeline-not-found'
  | 'artifact-not-found'
  | 'invalid-request'

/** Remote result envelope branches. */
export type OrchestratorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: OrchestratorFailureCode; readonly message: string } }
