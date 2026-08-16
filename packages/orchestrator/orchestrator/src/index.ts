/**
 * Central orchestrator pipeline sidecar service. Pipeline state and every
 * stage artifact live in the DSH storage home (never in the project working
 * tree), exposed to the browser through Typert Remotes and to model-facing
 * tools through plain service methods.
 * @module @deepseek-ai/dsh-orchestrator
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import {
  applyVerdict,
  buildArtifact,
  evaluateGates,
  goalFrozen,
  initialStages,
  PHASE_ROLES,
  sha256Text,
  validateVcsAnchor,
} from './gates.ts'
import { NAME_MAX, orchestratorDomainSpec, pipelineRowParseError } from './spec.ts'
import type {
  OrchestratorArtifact,
  OrchestratorArtifactKind,
  OrchestratorArtifactRequest,
  OrchestratorArtifactValue,
  OrchestratorBlockItem,
  OrchestratorDispatch,
  OrchestratorFailureCode,
  OrchestratorGetRequest,
  OrchestratorListRequest,
  OrchestratorMode,
  OrchestratorPhase,
  OrchestratorPipelineRow,
  OrchestratorPipelineSummary,
  OrchestratorResult,
  OrchestratorRisk,
  OrchestratorRole,
  OrchestratorVerdict,
  OrchestratorVcsAnchor,
} from './types.ts'

export type * from './types.ts'
export { orchestratorDomainSpec } from './spec.ts'
export {
  applyVerdict,
  buildArtifact,
  evaluateGates,
  goalFrozen,
  initialStages,
  PHASE_ROLES,
  requiredArtifactKinds,
  rollbackTarget,
  sha256Text,
  validateVcsAnchor,
  verdictAllowed,
} from './gates.ts'

/** Deployment policy for artifact bodies kept in the central store. */
export interface Config {
  /** Maximum UTF-8 byte length accepted for one artifact (default 262144). */
  readonly maxArtifactBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    orchestrator: OrchestratorService
  }
}

function success<T>(value: T): OrchestratorResult<T> {
  return Object.freeze({ ok: true, value })
}

function rejected<T = never>(code: OrchestratorFailureCode, message: string): OrchestratorResult<T> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) })
}

/**
 * Freeze one row at every structural depth (top level, stages, and each
 * stage's artifact/dispatch arrays and records) so committed rows never
 * alias live central state through mutation results or get().
 * @param row - committed row.
 * @returns the frozen row.
 */
function deepFreezeRow(row: OrchestratorPipelineRow): OrchestratorPipelineRow {
  return Object.freeze({
    ...row,
    stages: Object.freeze(row.stages.map(stage => Object.freeze({
      ...stage,
      artifacts: Object.freeze(stage.artifacts.map(artifact => Object.freeze(artifact))),
      dispatches: Object.freeze(stage.dispatches.map(dispatch => Object.freeze(dispatch))),
      ...(stage.blocks !== undefined ? { blocks: Object.freeze(stage.blocks.map(block => Object.freeze(block))) } : {}),
    }))),
    approvals: Object.freeze(row.approvals.map(approval => Object.freeze(approval))),
    concessions: Object.freeze(row.concessions.map(concession => Object.freeze(concession))),
  })
}

/**
 * Validate one anchor and reject future-dated samples: a capturedAt in the
 * future would brick the freeze-goal upper bound with no recovery path.
 * @param anchor - caller-sampled anchor.
 * @param purpose - 'baseline' or 'candidate', for the error text.
 * @returns the validated anchor.
 */
function validatedFutureSafeAnchor(anchor: OrchestratorVcsAnchor, purpose: 'baseline' | 'candidate'): OrchestratorVcsAnchor {
  const validated = validateVcsAnchor(anchor)
  if (validated.capturedAt > Date.now()) {
    throw new TypeError(`${purpose} vcs anchor is dated in the future; sample again`)
  }
  return validated
}

/** Validate the one deployment-varying limit at the configuration boundary. */
function resolveMaxArtifactBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `orchestrator: maxArtifactBytes must be a positive safe integer, got ${String(value)}`,
    )
  }
  return value
}

/** Inputs for creating one pipeline. */
export interface OrchestratorCreateInput {
  readonly name: string
  readonly projectRoot: string
  readonly mode: OrchestratorMode
  readonly riskClass: OrchestratorRisk
  readonly goalText: string
  readonly taskText?: string
  /** Version-control baseline sampled by the caller before work starts. */
  readonly baselineVcs?: OrchestratorVcsAnchor
}

/**
 * Inputs for one atomic stage report: artifacts, an optional concession,
 * and the closing verdict, committed as ONE row transition so a failed
 * call persists nothing.
 */
export interface OrchestratorStageReportInput {
  /** Artifacts recorded before the verdict, in order. */
  readonly artifacts?: readonly { readonly name: string; readonly kind: OrchestratorArtifactKind; readonly content: string }[]
  /** Concession registered with the report, when the caller grants one. */
  readonly concession?: { readonly reason: string; readonly grantedBy: string }
  /** Closing verdict of the stage. */
  readonly verdict: OrchestratorVerdict
  /** BLOCK items; required when the verdict is BLOCK/FAIL. */
  readonly blocks?: readonly OrchestratorBlockItem[]
}

/** Inputs for freezing the goal anchor. */
export interface OrchestratorFreezeGoalInput {
  readonly goalText?: string
  readonly taskText?: string
}

/** Inputs for recording one artifact. */
export interface OrchestratorArtifactInput {
  readonly name: string
  readonly kind: OrchestratorArtifactKind
  readonly content: string
}

/** The effect summary every mutation returns alongside the fresh row. */
export interface OrchestratorMutation {
  readonly row: OrchestratorPipelineRow
  readonly effect: string
}

/**
 * The central pipeline sidecar. One storage-domain table holds every pipeline
 * for every project; rows are keyed by opaque uuid and filtered by
 * `projectRoot` on read.
 */
export class OrchestratorService extends TypertRemoteService {
  static inject = ['storageDomain']

  /** Loader validation for the artifact-size policy. */
  static Config: s<Config> = s.object({
    maxArtifactBytes: s.number().step(1).min(1).default(262_144),
  })

  private readonly maxArtifactBytes: number
  private table?: KvTable<string, OrchestratorPipelineRow>
  private readonly operationTails = new Map<string, Promise<void>>()

  /**
   * @param ctx - Host context carrying the storage-domain form.
   * @param config - Artifact-size policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'orchestrator')
    this.maxArtifactBytes = resolveMaxArtifactBytes(config.maxArtifactBytes)
  }

  /** Open and own the one orchestrator sidecar domain. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(orchestratorDomainSpec)
    this.ctx.effect(() => async () => {
      await Promise.all(this.operationTails.values())
      await domain.close()
    }, 'orchestrator.domainClose')
    this.table = domain.table('pipelines')
  }

  private requireTable(): KvTable<string, OrchestratorPipelineRow> {
    if (this.table === undefined) throw new Error('orchestrator domain is not open')
    return this.table
  }

  /** Serialize mutations per pipeline id so concurrent tool calls cannot interleave. */
  private enqueue<T>(id: string, operation: () => Promise<T> | T): Promise<T> {
    const prior = this.operationTails.get(id) ?? Promise.resolve()
    const run = (async () => {
      await prior.catch(() => {})
      return await operation()
    })()
    const tail = run.then(() => {}, () => {})
    this.operationTails.set(id, tail)
    void tail.then(() => {
      if (this.operationTails.get(id) === tail) this.operationTails.delete(id)
    })
    return run
  }

  private requireRow(id: string): OrchestratorPipelineRow {
    const row = this.requireTable().get(id)
    if (row === undefined) {
      const error: OrchestratorFailureCode = 'pipeline-not-found'
      throw Object.assign(new TypeError(`no orchestrator pipeline '${id}'`), { code: error })
    }
    return row
  }

  /**
   * Persist a candidate row only when it matches the durable schema AND
   * every gate stays green. The schema-first check mirrors the read
   * boundary: a row the next domain open would reject must never be
   * written in the first place.
   */
  private async commit(row: OrchestratorPipelineRow, effect: string): Promise<OrchestratorMutation> {
    const schemaError = pipelineRowParseError(row)
    if (schemaError !== undefined) {
      throw new TypeError(`mutation rejected by durable schema: ${schemaError}`)
    }
    const violations = evaluateGates(row)
    if (violations.length > 0) {
      throw new TypeError(
        `mutation rejected by gates: ${violations.map(violation => violation.message).join('; ')}`,
      )
    }
    const frozen = deepFreezeRow(row)
    await this.requireTable().put(row.id, frozen)
    return { row: frozen, effect }
  }

  /** Project one row into its list summary (no artifact bodies). */
  static summarize(row: OrchestratorPipelineRow): OrchestratorPipelineSummary {
    return Object.freeze({
      id: row.id,
      name: row.name,
      projectRoot: row.projectRoot,
      mode: row.mode,
      riskClass: row.riskClass,
      lifecycle: row.lifecycle,
      currentPhase: row.currentPhase,
      stages: Object.freeze(row.stages.map(stage => Object.freeze({
        phase: stage.phase,
        status: stage.status,
        ...(stage.verdict !== undefined ? { verdict: stage.verdict } : {}),
        artifactCount: stage.artifacts.length,
        dispatchCount: stage.dispatches.length,
        attempts: stage.attempts,
        ...(() => {
          const last = stage.dispatches.at(-1)
          return last?.model !== undefined ? { lastModel: last.model } : {}
        })(),
      }))),
      goalFrozen: goalFrozen(row),
      ...(row.vcsBaseline !== undefined ? { baselineHead: row.vcsBaseline.head } : {}),
      ...(row.candidate?.vcs !== undefined ? { candidateHead: row.candidate.vcs.head } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  }

  /**
   * List pipeline summaries, newest first, optionally narrowed to one project.
   * @param request - Optional project-root filter.
   * @returns every matching summary.
   */
  @Remote('list')
  list(request: OrchestratorListRequest): OrchestratorResult<{ readonly pipelines: readonly OrchestratorPipelineSummary[] }> {
    const table = this.requireTable()
    const rows: OrchestratorPipelineRow[] = []
    const filterRoot = request.projectRoot?.replace(/\/+$/, '')
    for (const [, row] of table.entries()) {
      if (filterRoot === undefined || row.projectRoot === filterRoot) {
        rows.push(row)
      }
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt)
    return success({
      pipelines: Object.freeze(rows.map(row => OrchestratorService.summarize(row))),
    })
  }

  /**
   * Fetch one full pipeline row including artifact bodies.
   * @param request - Pipeline id.
   * @returns the row, or `pipeline-not-found`.
   */
  @Remote('get')
  get(request: OrchestratorGetRequest): OrchestratorResult<OrchestratorPipelineRow> {
    if (typeof request.id !== 'string' || request.id.length === 0) {
      return rejected('invalid-request', 'id must be a non-empty string')
    }
    const row = this.requireTable().get(request.id)
    if (row === undefined) return rejected('pipeline-not-found', `no orchestrator pipeline '${request.id}'`)
    return success(row)
  }

  /**
   * Fetch one artifact body by phase and name.
   * @param request - Pipeline id, phase, artifact name.
   * @returns the artifact, or a not-found failure.
   */
  @Remote('artifact')
  artifact(request: OrchestratorArtifactRequest): OrchestratorResult<OrchestratorArtifactValue> {
    if (typeof request.id !== 'string' || request.id.length === 0) {
      return rejected('invalid-request', 'id must be a non-empty string')
    }
    const row = this.requireTable().get(request.id)
    if (row === undefined) return rejected('pipeline-not-found', `no orchestrator pipeline '${request.id}'`)
    const stage = row.stages.find(candidate => candidate.phase === request.phase)
    const artifact = stage?.artifacts.find(candidate => candidate.name === request.name)
    if (stage === undefined || artifact === undefined) {
      return rejected(
        'artifact-not-found',
        `no artifact '${request.name}' at ${request.phase} in '${request.id}'`,
      )
    }
    return success({
      phase: artifact.kind === 'goal' || artifact.kind === 'task' ? 'S0' : request.phase,
      name: artifact.name,
      kind: artifact.kind,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      content: artifact.content,
      createdAt: artifact.createdAt,
    })
  }

  /**
   * Create one pipeline at S0 with its goal/task drafts recorded as S0
   * artifacts. The goal is NOT frozen yet; call {@link freezeGoal} after the
   * human finalizes the wording.
   */
  async create(input: OrchestratorCreateInput): Promise<OrchestratorMutation> {
    const name = input.name.trim()
    if (name.length === 0) throw new TypeError('pipeline name must be non-empty')
    if (name.length > NAME_MAX) throw new TypeError(`pipeline name must be at most ${NAME_MAX} characters`)
    if (input.goalText.trim().length === 0) throw new TypeError('goalText must be non-empty')
    const projectRoot = input.projectRoot.replace(/\/+$/, '')
    if (projectRoot.length === 0) throw new TypeError('projectRoot must be non-empty')
    const now = Date.now()
    const id = randomUUID()
    return this.enqueue(id, () => {
      const stages = initialStages().map(stage =>
        stage.phase === 'S0' ? { ...stage, status: 'ACTIVE' as const, startedAt: now } : stage,
      )
      const s0 = stages.find(stage => stage.phase === 'S0')
      if (s0 === undefined) throw new TypeError('initial stages must include S0')
      const goalArtifact = buildArtifact(s0, 'goal', 'goal', input.goalText, this.maxArtifactBytes, now)
      const taskArtifact = buildArtifact(
        { ...s0, artifacts: [] },
        'task',
        'task',
        input.taskText ?? '(task brief pending)',
        this.maxArtifactBytes,
        now,
      )
      const baseline = input.baselineVcs === undefined ? undefined : validatedFutureSafeAnchor(input.baselineVcs, 'baseline')
      const row: OrchestratorPipelineRow = {
        id,
        name,
        projectRoot,
        mode: input.mode,
        riskClass: input.riskClass,
        lifecycle: 'ACTIVE',
        currentPhase: 'S0',
        goal: { text: input.goalText, ...(input.taskText !== undefined ? { taskText: input.taskText } : {}) },
        stages: stages.map(stage =>
          stage.phase === 'S0'
            ? { ...stage, artifacts: [goalArtifact, taskArtifact] }
            : stage,
        ),
        approvals: [],
        concessions: [],
        ...(baseline !== undefined ? { vcsBaseline: baseline } : {}),
        createdAt: now,
        updatedAt: now,
      }
      const anchorNote = baseline === undefined ? '' : `; vcs baseline ${baseline.head.slice(0, 12)}… (${baseline.dirty.length} dirty)`
      return this.commit(row, `pipeline '${name}' created at S0 (${input.mode}/${input.riskClass})${anchorNote}; goal is a draft until frozen`)
    })
  }

  /**
   * Finalize the S0 drafts and freeze the goal anchor: computes the goal
   * sha256, closes S0 DONE, and advances (LITE pipelines also close S1/S2 as
   * LITE-MERGED and start at S3).
   */
  async freezeGoal(id: string, input: OrchestratorFreezeGoalInput): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      if (row.currentPhase !== 'S0') throw new TypeError('goal is already frozen')
      const now = Date.now()
      const goalText = input.goalText ?? row.goal.text
      const taskText = input.taskText ?? row.goal.taskText ?? '(task brief pending)'
      if (goalText.trim().length === 0) throw new TypeError('goalText must be non-empty')

      const sha = sha256Text(goalText)
      const s0 = row.stages.find(stage => stage.phase === 'S0')
      if (s0 === undefined) throw new TypeError('pipeline row lacks stage S0')
      const kept = s0.artifacts.filter(artifact => artifact.kind !== 'goal' && artifact.kind !== 'task')
      const artifacts: OrchestratorArtifact[] = [
        buildArtifact({ ...s0, artifacts: [] }, 'goal', 'goal', goalText, this.maxArtifactBytes, now),
        buildArtifact({ ...s0, artifacts: [] }, 'task', 'task', taskText, this.maxArtifactBytes, now),
        ...kept,
      ]
      let next: OrchestratorPipelineRow = {
        ...row,
        goal: { text: goalText, taskText, sha256: sha, frozenAt: now },
        stages: row.stages.map(stage =>
          stage.phase === 'S0' ? { ...stage, artifacts, status: 'DONE' as const, verdict: 'PASS' as const, finishedAt: now } : stage,
        ),
        currentPhase: 'S1',
        updatedAt: now,
      }
      if (row.mode === 'LITE') {
        next = {
          ...next,
          stages: next.stages.map((stage) => {
            if (stage.phase === 'S1' || stage.phase === 'S2') {
              return { ...stage, status: 'DONE' as const, verdict: 'LITE-MERGED' as const, finishedAt: now }
            }
            if (stage.phase === 'S3') {
              return { ...stage, status: 'ACTIVE' as const, startedAt: now }
            }
            return stage
          }),
          currentPhase: 'S3',
        }
      } else {
        next = {
          ...next,
          stages: next.stages.map(stage =>
            stage.phase === 'S1' && stage.status === 'PENDING'
              ? { ...stage, status: 'ACTIVE' as const, startedAt: now }
              : stage,
          ),
        }
      }
      return this.commit(next, `goal frozen (sha256 ${sha.slice(0, 12)}…); S0 closed; now at ${next.currentPhase}`)
    })
  }

  /**
   * Record one artifact into the current stage (goal/task edits are only
   * allowed before the freeze). The mutation is rejected when its stage is not
   * the current phase or when the result would violate a gate.
   */
  async recordArtifact(
    id: string,
    phase: OrchestratorPhase,
    input: OrchestratorArtifactInput,
  ): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      const stage = row.stages.find(candidate => candidate.phase === phase)
      if (stage === undefined) throw new TypeError(`pipeline row lacks stage ${phase}`)
      const editableS0 = phase === 'S0' && row.currentPhase === 'S0' && !goalFrozen(row)
      if (!editableS0 && row.currentPhase !== phase) {
        throw new TypeError(`pipeline is at ${row.currentPhase}; artifacts go to the current stage`)
      }
      const now = Date.now()
      const artifact = buildArtifact(stage, input.name, input.kind, input.content, this.maxArtifactBytes, now)
      const next: OrchestratorPipelineRow = {
        ...row,
        stages: row.stages.map((candidate) => {
          if (candidate.phase !== phase) return candidate
          return {
            ...candidate,
            artifacts: [...candidate.artifacts, artifact],
            ...(candidate.status === 'PENDING' ? { status: 'ACTIVE' as const, startedAt: now } : {}),
          }
        }),
        updatedAt: now,
      }
      if (phase === 'S0' && input.kind === 'goal') {
        return this.commit({ ...next, goal: { ...next.goal, text: input.content } },
          `artifact '${artifact.name}' (${artifact.kind}, ${artifact.bytes}B) recorded at ${phase}`)
      }
      return this.commit(next,
        `artifact '${artifact.name}' (${artifact.kind}, ${artifact.bytes}B) recorded at ${phase}`)
    })
  }


  /**
   * Record one atomic stage report: artifacts then verdict in a single
   * enqueued mutation. The tool-facing replacement for composing
   * recordArtifact + registerConcession + recordVerdict across several calls,
   * where a mid-sequence failure left partial artifacts persisted.
   */
  async reportStage(id: string, phase: OrchestratorPhase, input: OrchestratorStageReportInput): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      if (row.currentPhase !== phase) {
        throw new TypeError(`pipeline is at ${row.currentPhase}; cannot report ${phase}`)
      }
      const now = Date.now()
      let composed = row
      const effects: string[] = []
      for (const artifact of input.artifacts ?? []) {
        const stage = composed.stages.find(candidate => candidate.phase === phase)
        if (stage === undefined) throw new TypeError(`pipeline row lacks stage ${phase}`)
        const recorded = buildArtifact(stage, artifact.name, artifact.kind, artifact.content, this.maxArtifactBytes, now)
        composed = {
          ...composed,
          stages: composed.stages.map(candidate =>
            candidate.phase === phase
              ? { ...candidate, artifacts: [...candidate.artifacts, recorded] }
              : candidate,
          ),
          updatedAt: now,
        }
        effects.push(`artifact '${recorded.name}' (${recorded.kind}, ${recorded.bytes}B) recorded at ${phase}`)
      }
      if (input.concession !== undefined) {
        const reason = input.concession.reason.trim()
        const grantedBy = input.concession.grantedBy.trim()
        if (reason.length === 0) throw new TypeError('concession reason must be non-empty')
        if (grantedBy.length === 0) throw new TypeError('concession grantedBy must be non-empty')
        composed = {
          ...composed,
          concessions: [...composed.concessions, { phase, reason, grantedBy, grantedAt: now }],
          updatedAt: now,
        }
        effects.push(`concession registered at ${phase}`)
      }
      const blocks: readonly OrchestratorBlockItem[] = input.blocks ?? []
      if (input.verdict === 'PASS' && (phase === 'S4' || phase === 'S5' || phase === 'S6A')) {
        if (composed.candidate === undefined) {
          throw new TypeError('freeze a candidate before review-phase PASS (use freeze_candidate)')
        }
      }
      const applied = applyVerdict(composed, phase, input.verdict, blocks, now)
      let next = applied.row
      let effect = applied.effect
      if (input.verdict === 'PASS' && (phase === 'S4' || phase === 'S5' || phase === 'S6A')) {
        const candidate = next.candidate
        if (candidate === undefined) throw new TypeError('candidate missing after PASS at a review phase')
        if (!next.approvals.some(approval => approval.phase === phase)) {
          next = {
            ...next,
            approvals: [...next.approvals, { phase, subjectHash: candidate.subjectHash, grantedAt: now }],
          }
          effect += ` ${phase} approval bound to candidate ${candidate.subjectHash.slice(0, 12)}…`
        }
      }
      return this.commit(next, `${effects.length === 0 ? '' : effects.join('\n') + '\n'}${effect}`)
    })
  }
  /**
   * Record a stage verdict: PASS advances, BLOCK/FAIL rolls back (candidate
   * and approvals are invalidated when the target is S3), and the S6B COMPLETE
   * seals the pipeline. S4/S5/S6A PASS grants a candidate-bound approval.
   */
  async recordVerdict(
    id: string,
    phase: OrchestratorPhase,
    verdict: OrchestratorVerdict,
    blocks: readonly OrchestratorBlockItem[] = [],
  ): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (phase === 'S4' || phase === 'S5' || phase === 'S6A') {
        if (row.candidate === undefined && verdict === 'PASS') {
          throw new TypeError('freeze a candidate before review-phase PASS (use freeze_candidate)')
        }
      }
      const now = Date.now()
      const applied = applyVerdict(row, phase, verdict, blocks, now)
      let next = applied.row
      let effect = applied.effect
      if (verdict === 'PASS' && (phase === 'S4' || phase === 'S5' || phase === 'S6A')) {
        const candidate = next.candidate
        if (candidate === undefined) throw new TypeError('candidate missing after PASS at a review phase')
        if (!next.approvals.some(approval => approval.phase === phase)) {
          next = {
            ...next,
            approvals: [...next.approvals, { phase, subjectHash: candidate.subjectHash, grantedAt: now }],
          }
          effect += ` ${phase} approval bound to candidate ${candidate.subjectHash.slice(0, 12)}…`
        }
      }
      return this.commit(next, effect)
    })
  }

  /**
   * Record the version-control baseline anchor while the goal is still a
   * draft (S0): the snapshot the later audit compares every change against.
   */
  async captureVcsBaseline(id: string, anchor: OrchestratorVcsAnchor): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      if (row.currentPhase !== 'S0' || goalFrozen(row)) {
        throw new TypeError('vcs baselines are captured before the goal freezes')
      }
      const now = Date.now()
      const baseline = validatedFutureSafeAnchor(anchor, 'baseline')
      const next: OrchestratorPipelineRow = {
        ...row,
        vcsBaseline: baseline,
        updatedAt: now,
      }
      return this.commit(next, `vcs baseline captured: ${baseline.head.slice(0, 12)}… (${baseline.dirty.length} dirty)`)
    })
  }

  /**
   * Stage the version-control anchor the next candidate freeze will bind.
   * Only during the candidate window (S3/S4, before a candidate exists) and
   * only for samples no older than the coding stage's start: an anchor from
   * before the implementation would bind stale code to the candidate. A
   * rollback to S3 discards any staged anchor: the next candidate must
   * sample afresh.
   */
  async stageCandidateVcs(id: string, anchor: OrchestratorVcsAnchor): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      if (row.candidate !== undefined) {
        throw new TypeError('a candidate is already frozen; roll back to S3 to restage an anchor')
      }
      if (row.currentPhase !== 'S3' && row.currentPhase !== 'S4') {
        throw new TypeError(`candidate anchors stage during S3/S4; pipeline is at ${row.currentPhase}`)
      }
      const s3 = row.stages.find(stage => stage.phase === 'S3')
      const workStartedAt = s3?.startedAt
      const now = Date.now()
      const staged = validatedFutureSafeAnchor(anchor, 'candidate')
      if (workStartedAt !== undefined && staged.capturedAt < workStartedAt) {
        throw new TypeError('candidate vcs anchor predates the coding stage; sample again')
      }
      const next: OrchestratorPipelineRow = {
        ...row,
        vcsCandidate: staged,
        updatedAt: now,
      }
      return this.commit(next, `candidate vcs anchor staged: ${staged.head.slice(0, 12)}… (${staged.dirty.length} dirty) at phase ${row.currentPhase}`)
    })
  }

  /**
   * Freeze the implementation candidate while S4 is current and unapproved.
   * The subjectHash is opaque to this service (typically a workspace manifest
   * aggregate hash computed by the caller). A staged version-control anchor
   * binds to the frozen candidate and is consumed by the freeze.
   */
  async freezeCandidate(id: string, subjectHash: string): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      if (row.currentPhase !== 'S4') {
        throw new TypeError(`candidate freezes at the S3→S4 boundary; pipeline is at ${row.currentPhase}`)
      }
      if (row.candidate !== undefined) {
        throw new TypeError('a candidate is already frozen; roll back to S3 to freeze a new one')
      }
      if (!/^[0-9a-f]{64}$/.test(subjectHash)) {
        throw new TypeError('subjectHash must be a lowercase 64-hex sha256')
      }
      const now = Date.now()
      const anchor = row.vcsCandidate
      if (anchor !== undefined && anchor.capturedAt > now) {
        throw new TypeError('staged vcs anchor postdates the freeze; sample again')
      }
      const s4 = row.stages.find(stage => stage.phase === 'S4')
      const generation = 1 + (s4?.attempts ?? 0)
      const { vcsCandidate: _consumed, ...rest } = row
      const next: OrchestratorPipelineRow = {
        ...rest,
        candidate: {
          subjectHash,
          generation,
          frozenAt: now,
          ...(anchor !== undefined ? { vcs: anchor } : {}),
        },
        updatedAt: now,
      }
      const anchorNote = anchor === undefined ? '' : `, vcs ${anchor.head.slice(0, 12)}…`
      return this.commit(next, `candidate frozen: ${subjectHash.slice(0, 12)}… (generation ${generation})${anchorNote}`)
    })
  }

  /**
   * Register one concession for a stage whose verdict carries a debt token.
   */
  async registerConcession(
    id: string,
    phase: OrchestratorPhase,
    reason: string,
    grantedBy: string,
  ): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      if (reason.trim().length === 0) throw new TypeError('concession reason must be non-empty')
      if (grantedBy.trim().length === 0) throw new TypeError('concession grantedBy must be non-empty')
      const now = Date.now()
      const next: OrchestratorPipelineRow = {
        ...row,
        concessions: [...row.concessions, { phase, reason: reason.trim(), grantedBy: grantedBy.trim(), grantedAt: now }],
        updatedAt: now,
      }
      return this.commit(next, `concession registered at ${phase}`)
    })
  }

  /**
   * Record one role dispatch on the current stage after validating the role
   * against the phase matrix.
   */
  async recordDispatch(
    id: string,
    role: OrchestratorRole,
    dispatch: Omit<OrchestratorDispatch, 'role' | 'settled'>,
  ): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      const phase = row.currentPhase
      if (phase === 'S0' || phase === 'S6B' || phase === 'COMPLETE') {
        throw new TypeError(`no role dispatches at ${phase}`)
      }
      const allowed = PHASE_ROLES[phase]
      if (!allowed.includes(role)) {
        throw new TypeError(`role '${role}' is not dispatchable at ${phase} (allowed: ${allowed.join(', ')})`)
      }
      const now = Date.now()
      const next: OrchestratorPipelineRow = {
        ...row,
        stages: row.stages.map((stage) => {
          if (stage.phase !== phase) return stage
          return {
            ...stage,
            dispatches: [...stage.dispatches, { ...dispatch, role, settled: false }],
            ...(stage.status === 'PENDING' ? { status: 'ACTIVE' as const, startedAt: now } : {}),
          }
        }),
        updatedAt: now,
      }
      const model = dispatch.model === undefined ? 'session default' : dispatch.model
      return this.commit(next, `${role} dispatched at ${phase} (model: ${model})`)
    })
  }

  /**
   * Settle exactly the dispatch recorded under the given agent id, on an
   * ACTIVE pipeline only. A dispatch settles at most once; a child that
   * failed through an infrastructure fault settles with failed=true so the
   * durable record never carries a stuck unsettled dispatch.
   * @param id - pipeline id.
   * @param phase - stage the dispatch was recorded on.
   * @param dispatchId - the child session id (agentId) of the dispatch.
   * @param failed - whether the child settled through a failure.
   */
  async settleDispatch(id: string, phase: OrchestratorPhase, dispatchId: string, failed: boolean = false): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE') throw new TypeError(`pipeline is ${row.lifecycle}, not ACTIVE`)
      const now = Date.now()
      const stage = row.stages.find(candidate => candidate.phase === phase)
      const dispatch = stage?.dispatches.find(candidate => candidate.agentId === dispatchId)
      if (dispatch === undefined) throw new TypeError(`no dispatch '${dispatchId}' at ${phase}`)
      if (dispatch.settled) throw new TypeError(`dispatch '${dispatchId}' at ${phase} is already settled`)
      const next: OrchestratorPipelineRow = {
        ...row,
        stages: row.stages.map(candidate =>
          candidate.phase !== phase
            ? candidate
            : { ...candidate, dispatches: candidate.dispatches.map(entry =>
              entry.agentId === dispatchId ? { ...entry, settled: true, settledAt: now, ...(failed ? { failed: true } : {}) } : entry) },
        ),
        updatedAt: now,
      }
      return this.commit(next, `${phase} dispatch ${failed ? 'settled as failed' : 'settled'}`)
    })
  }

  /**
   * Revoke an ACTIVE pipeline after a post-complete defect: the row stops
   * advancing and points at the repairs pipeline that succeeds it.
   */
  async revoke(id: string, repairsPipeline: string): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'ACTIVE' && row.lifecycle !== 'SEALED') {
        throw new TypeError(`only ACTIVE/SEALED pipelines can be revoked; this one is ${row.lifecycle}`)
      }
      const trimmed = repairsPipeline.trim()
      if (trimmed.length === 0) throw new TypeError('repairsPipeline must be non-empty')
      if (trimmed === id) throw new TypeError('a pipeline cannot be its own repairs pipeline')
      if (this.requireTable().get(trimmed) === undefined) {
        throw new TypeError(`repairs pipeline '${trimmed}' does not exist`)
      }
      const now = Date.now()
      const next: OrchestratorPipelineRow = {
        ...row,
        lifecycle: 'REVOKED',
        repairsPipeline: trimmed,
        updatedAt: now,
      }
      return this.commit(next, `pipeline revoked; repairs pipeline '${trimmed}'`)
    })
  }

  /**
   * Mark a SEALED pipeline superseded by a successor ACTIVE pipeline.
   */
  async supersede(id: string, successorId: string): Promise<OrchestratorMutation> {
    return this.enqueue(id, () => {
      const row = this.requireRow(id)
      if (row.lifecycle !== 'SEALED') {
        throw new TypeError(`only SEALED pipelines can be superseded; this one is ${row.lifecycle}`)
      }
      if (successorId === id) throw new TypeError('a pipeline cannot be its own successor')
      const successor = this.requireTable().get(successorId)
      if (successor === undefined) throw new TypeError(`successor pipeline '${successorId}' does not exist`)
      if (successor.lifecycle !== 'ACTIVE') {
        throw new TypeError(`successor pipeline '${successorId}' is ${successor.lifecycle}, not ACTIVE`)
      }
      const now = Date.now()
      const next: OrchestratorPipelineRow = {
        ...row,
        lifecycle: 'SUPERSEDED',
        supersededBy: successorId,
        updatedAt: now,
      }
      return this.commit(next, `pipeline superseded by '${successorId}'`)
    })
  }
}

export default OrchestratorService
