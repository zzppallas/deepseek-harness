/**
 * Pure mechanical gates and transitions for orchestrator pipeline rows.
 *
 * This module is the in-process successor of the source skill's
 * orchestrator-state-check rules: the same invariants (goal immutability,
 * required artifacts per stage, rollback caps, candidate-bound approvals,
 * phase closure) evaluated as pure functions over one row, so the service can
 * refuse any mutation that would produce an inconsistent state.
 * @module @deepseek-ai/dsh-orchestrator/src/gates
 */

import { createHash } from 'node:crypto'
import { GIT_OBJECT_ID_HEX, NAME_MAX } from './spec.ts'
import type {
  OrchestratorArtifact,
  OrchestratorArtifactKind,
  OrchestratorBlockItem,
  OrchestratorMode,
  OrchestratorPhase,
  OrchestratorPipelineRow,
  OrchestratorRole,
  OrchestratorStage,
  OrchestratorVerdict,
  OrchestratorVcsAnchor,
} from './types.ts'

/** Canonical phase order shared by both modes. */
export const CANONICAL_PHASES: readonly OrchestratorPhase[] = [
  'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6A', 'S6B',
] as const

/** Review phases that may carry a BLOCK verdict. */
const REVIEW_PHASES: ReadonlySet<OrchestratorPhase> = new Set(['S2', 'S3', 'S4', 'S5', 'S6A'])

/** Per-phase dispatchable roles (S0/S6B stay with the orchestrating master). */
export const PHASE_ROLES: Readonly<Record<Exclude<OrchestratorPhase, 'S0' | 'S6B'>, readonly OrchestratorRole[]>> = {
  S1: ['architect'],
  S2: ['reviewer'],
  S3: ['coder', 'coverage-reviewer'],
  S4: ['code-reviewer'],
  S5: ['qa'],
  S6A: ['auditor'],
}

/** Rollback target when a review phase records BLOCK/FAIL. */
export function rollbackTarget(phase: OrchestratorPhase): OrchestratorPhase {
  switch (phase) {
    case 'S2': return 'S1'
    case 'S3': return 'S3'
    case 'S4': return 'S3'
    case 'S5': return 'S3'
    case 'S6A': return 'S3'
    default: throw new TypeError(`phase ${phase} cannot carry BLOCK/FAIL`)
  }
}

/** Required artifact kinds for a stage to close DONE, by mode and phase. */
export function requiredArtifactKinds(mode: OrchestratorMode, phase: OrchestratorPhase): readonly OrchestratorArtifactKind[] {
  if (mode === 'LITE') {
    switch (phase) {
      case 'S0': return ['goal', 'task']
      case 'S3': return []
      case 'S4': return ['codereview']
      case 'S5': return ['qa-report']
      case 'S6A': return ['final-audit']
      case 'S6B': return ['final']
      default: return []
    }
  }
  switch (phase) {
    case 'S0': return ['goal', 'task']
    case 'S1': return ['architecture']
    case 'S2': return ['review']
    case 'S3': return ['receipt', 'coding-batch']
    case 'S4': return ['codereview']
    case 'S5': return ['qa-report']
    case 'S6A': return ['final-audit']
    case 'S6B': return ['final']
  }
}

/** One mechanical violation. */
export interface GateViolation {
  readonly rule: string
  readonly message: string
}

/** SHA-256 hex of a UTF-8 string. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Fresh stage records for a new pipeline. */
export function initialStages(): OrchestratorStage[] {
  return CANONICAL_PHASES.map(phase => ({
    phase,
    status: 'PENDING',
    artifacts: [],
    dispatches: [],
    attempts: 0,
  }))
}

/** Whether the goal anchor is frozen. */
export function goalFrozen(row: OrchestratorPipelineRow): boolean {
  return row.goal.sha256 !== undefined && row.goal.frozenAt !== undefined
}

function stageOf(row: OrchestratorPipelineRow, phase: OrchestratorPhase): OrchestratorStage {
  const stage = row.stages.find(candidate => candidate.phase === phase)
  if (stage === undefined) throw new TypeError(`pipeline row lacks stage ${phase}`)
  return stage
}

/** Index of a phase in canonical order. */
export function phaseIndex(phase: OrchestratorPhase): number {
  const index = CANONICAL_PHASES.indexOf(phase)
  if (index === -1) throw new TypeError(`unknown phase ${phase}`)
  return index
}

/**
 * Evaluate every mechanical gate over one row. An empty result is the only
 * state the service may persist between mutations; violations reference the
 * rule id and a human-readable explanation.
 */
export function evaluateGates(row: OrchestratorPipelineRow): GateViolation[] {
  const violations: GateViolation[] = []
  const done = (phase: OrchestratorPhase): boolean => stageOf(row, phase).status === 'DONE'
  const everyPhaseDone = CANONICAL_PHASES.every(done)

  // G1 phase closure: COMPLETE <-> every stage DONE, and the reverse.
  if (row.currentPhase === 'COMPLETE' && !everyPhaseDone) {
    violations.push({
      rule: 'G1',
      message: 'currentPhase is COMPLETE but stages are not all DONE',
    })
  }
  if (row.currentPhase !== 'COMPLETE' && everyPhaseDone) {
    violations.push({
      rule: 'G1',
      message: 'every stage is DONE but currentPhase is not COMPLETE',
    })
  }

  // G2 required artifacts: every DONE stage owns its required kinds.
  for (const phase of CANONICAL_PHASES) {
    const stage = stageOf(row, phase)
    if (stage.status !== 'DONE') continue
    const kinds = new Set(stage.artifacts.map(artifact => artifact.kind))
    for (const kind of requiredArtifactKinds(row.mode, phase)) {
      if (!kinds.has(kind)) {
        violations.push({
          rule: 'G2',
          message: `stage ${phase} closed DONE without a required '${kind}' artifact`,
        })
      }
    }
    if (row.mode === 'LITE' && phase === 'S3' && stage.artifacts.length === 0) {
      violations.push({
        rule: 'G2',
        message: 'LITE S3 closed DONE without any pipeline artifact',
      })
    }
  }

  // G3 goal immutability: a frozen sha256 still matches the stored text.
  if (goalFrozen(row) && row.goal.sha256 !== sha256Text(row.goal.text)) {
    violations.push({
      rule: 'G3',
      message: 'goal text changed after freeze; sha256 no longer matches',
    })
  }

  // G4 rollback caps.
  for (const stage of row.stages) {
    if (stage.attempts > 3) {
      violations.push({
        rule: 'G4',
        message: `stage ${stage.phase} consumed ${stage.attempts} rollbacks (cap 3)`,
      })
    }
  }

  // G6 approvals bind the current candidate; sealing needs all three.
  if (row.candidate !== undefined) {
    for (const approval of row.approvals) {
      if (approval.subjectHash !== row.candidate.subjectHash) {
        violations.push({
          rule: 'G6',
          message: `approval from ${approval.phase} is bound to a stale candidate`,
        })
      }
    }
  }
  if (row.lifecycle === 'SEALED' || row.currentPhase === 'COMPLETE') {
    if (row.candidate === undefined) {
      violations.push({ rule: 'G6', message: 'sealed pipeline has no frozen candidate' })
    } else {
      for (const phase of ['S4', 'S5', 'S6A'] as const) {
        const owned = row.approvals.some(
          approval => approval.phase === phase && approval.subjectHash === row.candidate?.subjectHash,
        )
        if (!owned) {
          violations.push({
            rule: 'G6',
            message: `sealed pipeline lacks the ${phase} approval bound to the candidate`,
          })
        }
      }
    }
  }

  // G7 blocked alignment: the current phase never moves PAST a still-blocked
  // stage (a rollback legitimately leaves the blocked stage behind as history).
  for (const stage of row.stages) {
    if (stage.status === 'BLOCKED'
      && row.currentPhase !== 'COMPLETE'
      && phaseIndex(row.currentPhase) > phaseIndex(stage.phase)) {
      violations.push({
        rule: 'G7',
        message: `currentPhase ${row.currentPhase} moved past the BLOCKED stage ${stage.phase}`,
      })
    }
  }

  // G9 version-control anchor ordering: a baseline anchors the pipeline
  // start (a pre-creation sample is the documented order), never after the
  // goal froze; a candidate anchor never postdates the freeze it is bound
  // to. Future-dated anchors are rejected at capture time instead.
  const frozenAt = row.goal.frozenAt
  if (row.vcsBaseline !== undefined && frozenAt !== undefined && row.vcsBaseline.capturedAt > frozenAt) {
    violations.push({
      rule: 'G9',
      message: 'vcs baseline was captured after the goal froze',
    })
  }
  if (row.candidate?.vcs !== undefined && row.candidate.vcs.capturedAt > row.candidate.frozenAt) {
    violations.push({
      rule: 'G9',
      message: 'candidate vcs anchor postdates its own freeze',
    })
  }

  // G10 a goal is frozen before the pipeline may leave S0: the freeze is
  // the only S0 closer, so a row past S0 with no goal anchor is corrupt.
  if (row.currentPhase !== 'S0' && !goalFrozen(row)) {
    violations.push({
      rule: 'G10',
      message: 'pipeline advanced past S0 without freezing the goal',
    })
  }

  // G8 terminal lifecycles carry their successor/repair links exclusively.
  if (row.lifecycle === 'SUPERSEDED' && (row.supersededBy === undefined || row.repairsPipeline !== undefined)) {
    violations.push({ rule: 'G8', message: 'SUPERSEDED requires exactly a supersededBy link' })
  }
  if (row.lifecycle === 'REVOKED' && (row.repairsPipeline === undefined || row.supersededBy !== undefined)) {
    violations.push({ rule: 'G8', message: 'REVOKED requires exactly a repairsPipeline link' })
  }
  if ((row.lifecycle === 'ACTIVE' || row.lifecycle === 'SEALED')
    && (row.supersededBy !== undefined || row.repairsPipeline !== undefined)) {
    violations.push({ rule: 'G8', message: 'ACTIVE/SEALED pipelines carry no successor links' })
  }

  return violations
}

/** Copy one row without its candidate link (explicit-field omit). */
function withoutCandidate(row: OrchestratorPipelineRow): OrchestratorPipelineRow {
  return {
    id: row.id,
    name: row.name,
    projectRoot: row.projectRoot,
    mode: row.mode,
    riskClass: row.riskClass,
    lifecycle: row.lifecycle,
    currentPhase: row.currentPhase,
    goal: row.goal,
    stages: row.stages,
    approvals: row.approvals,
    concessions: row.concessions,
    ...(row.vcsBaseline !== undefined ? { vcsBaseline: row.vcsBaseline } : {}),
    ...(row.supersededBy !== undefined ? { supersededBy: row.supersededBy } : {}),
    ...(row.repairsPipeline !== undefined ? { repairsPipeline: row.repairsPipeline } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Whether a verdict is acceptable for a phase. */
export function verdictAllowed(phase: OrchestratorPhase, verdict: OrchestratorVerdict): boolean {
  if (phase === 'S6B') return verdict === 'COMPLETE'
  if (verdict === 'COMPLETE') return false
  if (verdict === 'LITE-MERGED') return phase === 'S1' || phase === 'S2'
  // S0 closes only through freezeGoal: no verdict is reportable at S0.
  if (phase === 'S0') return false
  if (REVIEW_PHASES.has(phase)) return true
  return verdict === 'PASS'
}

/** Result of one applied verdict transition. */
export interface VerdictEffect {
  readonly row: OrchestratorPipelineRow
  /** Human description of what the transition did. */
  readonly effect: string
}

/**
 * Apply a stage verdict: close DONE, roll back on BLOCK/FAIL, seal on the
 * S6B COMPLETE. Throws on any input the gates would reject.
 */
export function applyVerdict(
  row: OrchestratorPipelineRow,
  phase: OrchestratorPhase,
  verdict: OrchestratorVerdict,
  blocks: readonly OrchestratorBlockItem[],
  now: number,
): VerdictEffect {
  if (row.lifecycle !== 'ACTIVE') {
    throw new TypeError(`pipeline ${row.id} is ${row.lifecycle}; only ACTIVE pipelines advance`)
  }
  if (!verdictAllowed(phase, verdict)) {
    throw new TypeError(`verdict ${verdict} is not valid at phase ${phase}`)
  }
  if (row.currentPhase !== phase) {
    throw new TypeError(`pipeline is at ${row.currentPhase}; cannot report ${phase}`)
  }
  const stage = row.stages.find(candidate => candidate.phase === phase)
  if (stage === undefined) throw new TypeError(`pipeline row lacks stage ${phase}`)

  if (verdict === 'BLOCK' || verdict === 'FAIL') {
    if (blocks.length === 0) {
      throw new TypeError(`verdict ${verdict} at ${phase} requires at least one block item`)
    }
    const attempts = stage.attempts + 1
    if (attempts > 3) {
      throw new TypeError(
        `stage ${phase} consumed its 3-rollback cap; ask the human to revoke or supersede the pipeline`,
      )
    }
    const target = rollbackTarget(phase)
    const nextStages = row.stages.map((candidate) => {
      if (candidate.phase === phase) {
        return {
          ...candidate,
          status: 'BLOCKED' as const,
          verdict,
          blocks,
          attempts,
        }
      }
      return candidate
    })
    // Reopen the rollback target so the pipeline can resume there.
    const reopened = nextStages.map((candidate) => {
      if (candidate.phase !== target) return candidate
      return { ...candidate, status: 'ACTIVE' as const }
    })
    const next: OrchestratorPipelineRow = target === 'S3'
      ? withoutCandidate({ ...row, stages: reopened, currentPhase: target, approvals: [], updatedAt: now })
      : { ...row, stages: reopened, currentPhase: target, updatedAt: now }
    const invalidated = target === 'S3' ? ' candidate and approvals invalidated;' : ''
    return {
      row: next,
      effect: `${verdict} at ${phase} (attempt ${attempts}/3); rolled back to ${target}.${invalidated}`,
    }
  }

  if (verdict === 'COMPLETE') {
    const sealed: OrchestratorPipelineRow = {
      ...row,
      stages: row.stages.map(candidate =>
        candidate.phase === phase
          ? { ...candidate, status: 'DONE' as const, verdict, finishedAt: now }
          : candidate,
      ),
      currentPhase: 'COMPLETE',
      lifecycle: 'SEALED',
      updatedAt: now,
    }
    const violations = evaluateGates(sealed)
    if (violations.length > 0) {
      throw new TypeError(
        `sealing rejected by gates: ${violations.map(violation => violation.message).join('; ')}`,
      )
    }
    return { row: sealed, effect: 'S6B COMPLETE: pipeline sealed.' }
  }

  // PASS / LITE-MERGED: close the stage DONE and advance.
  const nextIndex = Math.min(phaseIndex(phase) + 1, CANONICAL_PHASES.length - 1)
  const nextPhase: OrchestratorPhase = CANONICAL_PHASES.slice(nextIndex)[0] ?? 'S6B'
  const advanced: OrchestratorPipelineRow = {
    ...row,
    stages: row.stages.map((candidate) => {
      if (candidate.phase === phase) {
        return { ...candidate, status: 'DONE' as const, verdict, finishedAt: now }
      }
      if (candidate.phase === nextPhase
        && (candidate.status === 'PENDING' || candidate.status === 'BLOCKED')) {
        return { ...candidate, status: 'ACTIVE' as const, startedAt: now }
      }
      return candidate
    }),
    currentPhase: phase === 'S6B' ? 'COMPLETE' : nextPhase,
    updatedAt: now,
  }
  return {
    row: advanced,
    effect: `${phase} ${verdict}; advanced to ${phase === 'S6B' ? 'COMPLETE' : nextPhase}.`,
  }
}

/**
 * Validate one version-control anchor snapshot and normalize its dirty
 * lines (trailing carriage returns stripped for cross-platform porcelain).
 * Throws on structural violations the durable schema would also reject.
 * @param anchor - caller-sampled snapshot.
 * @returns the validated anchor with normalized dirty lines.
 */
export function validateVcsAnchor(anchor: OrchestratorVcsAnchor): OrchestratorVcsAnchor {
  if (!GIT_OBJECT_ID_HEX.test(anchor.head)) {
    throw new TypeError('vcs anchor head must be a lowercase hex git object id (40-hex sha1 or 64-hex sha256)')
  }
  if (anchor.dirty.length > 4096) {
    throw new TypeError(`vcs anchor carries ${anchor.dirty.length} dirty lines; cap is 4096`)
  }
  const dirty = anchor.dirty.map(line => line.replace(/\r$/, ''))
  if (dirty.some(line => line.length === 0 || line.length > 4096)) {
    throw new TypeError('vcs anchor dirty lines must be 1..4096 characters')
  }
  if (!Number.isSafeInteger(anchor.capturedAt) || anchor.capturedAt < 0) {
    throw new TypeError('vcs anchor capturedAt must be a non-negative safe integer')
  }
  return { ...anchor, dirty }
}

/** Build one artifact record with its hash, enforcing the stage uniqueness. */
export function buildArtifact(
  stage: OrchestratorStage,
  name: string,
  kind: OrchestratorArtifactKind,
  content: string,
  maxBytes: number,
  now: number,
): OrchestratorArtifact {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new TypeError('artifact name must be non-empty')
  if (trimmed.length > NAME_MAX) {
    throw new TypeError(`artifact name must be at most ${NAME_MAX} characters`)
  }
  if (stage.artifacts.some(artifact => artifact.name === trimmed)) {
    throw new TypeError(`artifact '${trimmed}' already exists at ${stage.phase}`)
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) {
    throw new TypeError(`artifact '${trimmed}' is ${bytes} bytes; cap is ${maxBytes}`)
  }
  return { name: trimmed, kind, sha256: sha256Text(content), bytes, content, createdAt: now }
}
