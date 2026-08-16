/**
 * Model-facing orchestrator pipeline tools: create and freeze goal-anchored
 * pipelines, dispatch role subagents with per-role model routing, report
 * stage verdicts through mechanical gates, and manage lifecycle endings. The
 * pipeline state itself lives entirely in the central dsh-orchestrator
 * sidecar — nothing lands in the project working tree.
 * @module @deepseek-ai/dsh-tool-orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import type { OrchestratorService } from '@deepseek-ai/dsh-orchestrator'
import type {
  OrchestratorArtifactKind,
  OrchestratorBlockItem,
  OrchestratorMode,
  OrchestratorPhase,
  OrchestratorRisk,
  OrchestratorRole,
  OrchestratorVerdict,
} from '@deepseek-ai/dsh-orchestrator/types'
import { PHASE_ROLES } from '@deepseek-ai/dsh-orchestrator'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Declaration merges: ctx.systemPrompt section registration and the
// ctx.subagents registry both become visible through these type-only pulls.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'tool-orchestrator'
export const inject = ['tools', 'orchestrator', 'subagents', 'systemPrompt', 'llm']

/** One role's LLM route: either field alone is meaningful. */
export interface OrchestratorRoleRoute {
  /** Provider route override for children playing this role. */
  readonly provider?: string
  /** Model id override for children playing this role. */
  readonly model?: string
}

/** Deployment policy for the orchestrator tools. */
export interface Config {
  /** Subagent provider used for role dispatches (default `spawn`). */
  readonly subagentProvider?: string
  /** Per-role LLM routes; roles without an entry inherit the session default. */
  readonly roles?: Readonly<Partial<Record<OrchestratorRole, OrchestratorRoleRoute>>>
  /** Maximum characters of one role child's output returned to the parent (default 16384). */
  readonly maxDispatchChars?: number
  /** Maximum characters in one tool result text (default 16384). */
  readonly maxResultChars?: number
  /** No-shell git command boundary; tests inject a fake, production uses execFile. */
  readonly gitRunner?: NativeCommandRunner
}

const roleSchema = z.object({
  provider: z.string(),
  model: z.string(),
})

/** Schemastery configuration for the orchestrator tools. */
export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  roles: z.object({
    architect: roleSchema,
    reviewer: roleSchema,
    coder: roleSchema,
    'coverage-reviewer': roleSchema,
    'code-reviewer': roleSchema,
    qa: roleSchema,
    auditor: roleSchema,
  }),
  maxDispatchChars: z.number().step(1).min(64).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxResultChars: z.number().step(1).min(64).max(Number.MAX_SAFE_INTEGER).default(16_384),
  gitRunner: z.any(),
})

interface ResolvedConfig {
  readonly subagentProvider: string
  readonly roles: Readonly<Partial<Record<OrchestratorRole, OrchestratorRoleRoute>>>
  readonly maxDispatchChars: number
  readonly maxResultChars: number
  readonly gitRunner: NativeCommandRunner
}

function resolveConfig(config: Config): ResolvedConfig {
  const subagentProvider = config.subagentProvider ?? 'spawn'
  if (typeof subagentProvider !== 'string' || subagentProvider.length === 0) {
    throw new TypeError('subagentProvider must be a non-empty string')
  }
  const gitRunner = config.gitRunner ?? runNativeCommand
  if (typeof gitRunner !== 'function') {
    throw new TypeError('gitRunner must be a command runner function')
  }
  return {
    subagentProvider,
    roles: config.roles ?? {},
    maxDispatchChars: positiveInt(config.maxDispatchChars ?? 16_384, 'maxDispatchChars'),
    maxResultChars: positiveInt(config.maxResultChars ?? 16_384, 'maxResultChars'),
    gitRunner,
  }
}

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 64) {
    throw new TypeError(`${field} must be a safe integer of at least 64`)
  }
  return value
}

const TRUNCATION_NOTICE = '\n… [truncated]'

/**
 * execFile bound for the git boundary: 4096 dirty lines × 4096 characters
 * each (the durable schema caps), doubled for safety, so the service's own
 * line cap always fires before Node's default 1 MiB buffer does.
 */
const VCS_RUN_OPTIONS = { maxBuffer: 4096 * 4096 * 2 }

/**
 * Bound one tool-result text, including its truncation marker. Slicing is
 * code-point aware so an astral character is never split into a lone
 * surrogate in model-visible text.
 */
function boundText(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${chars.slice(0, maxChars - TRUNCATION_NOTICE.length).join('')}${TRUNCATION_NOTICE}`
}

/** Extract the concatenated text blocks of one child output. */
function textOf(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** One resolved dispatch route after model evaluation. */
interface ResolvedRoute {
  readonly provider?: string
  readonly model?: string
  readonly note: string
}

/**
 * Evaluate a role route against the live model catalog: a named model must
 * resolve to exactly one provider that actually lists it, and a named
 * provider must exist. Returns the route to pass as agentOptions, or an
 * empty route when the role inherits the session default.
 */
async function evaluateRoute(
  ctx: Context,
  providerWanted: string | undefined,
  modelWanted: string | undefined,
): Promise<ResolvedRoute> {
  if (providerWanted === undefined && modelWanted === undefined) {
    return { note: 'session default (no route configured)' }
  }
  const providers = ctx.llm.listConfigurableProviders().map(entry => entry.provider)
  if (providerWanted !== undefined) {
    if (!providers.includes(providerWanted)) {
      throw new Error(
        `orchestrator route names provider '${providerWanted}' but the configured providers are: ${providers.join(', ') || '(none)'}`,
      )
    }
    if (modelWanted !== undefined) {
      let models
      try {
        models = await ctx.llm.listModels(providerWanted)
      } catch (error) {
        // A failed catalog must not masquerade as 'model not listed'.
        throw new Error(`orchestrator route: listing models for provider '${providerWanted}' failed: ${(error as Error).message}`)
      }
      if (!models.some(model => model.id === modelWanted)) {
        const available = models.map(model => model.id).slice(0, 30).join(', ') || '(none listed)'
        throw new Error(
          `orchestrator route model '${modelWanted}' is not listed by provider '${providerWanted}'; available: ${available}`,
        )
      }
    }
    return {
      provider: providerWanted,
      ...(modelWanted !== undefined ? { model: modelWanted } : {}),
      note: `provider '${providerWanted}'${modelWanted === undefined ? '' : `, model '${modelWanted}'`} (validated)`,
    }
  }
  // Model without provider: resolve the unique provider that lists it;
  // ambiguity and catalog failures are loud, never silently first-wins.
  const matches: string[] = []
  const failures: string[] = []
  for (const provider of providers) {
    let models
    try {
      models = await ctx.llm.listModels(provider)
    } catch (error) {
      // A failed catalog must not masquerade as 'model not listed'.
      failures.push(`${provider}: ${(error as Error).message}`)
      continue
    }
    if (models.some(model => model.id === modelWanted)) matches.push(provider)
  }
  if (matches.length > 1) {
    throw new Error(
      `orchestrator route model '${String(modelWanted)}' is listed by multiple providers (${matches.join(', ')}); name a provider to disambiguate`,
    )
  }
  if (matches.length === 1) {
    const resolvedProvider = matches[0]
    if (resolvedProvider === undefined) {
      throw new Error('orchestrator route: internal provider resolution failure')
    }
    return {
      provider: resolvedProvider,
      ...(modelWanted !== undefined ? { model: modelWanted } : {}),
      note: `model '${modelWanted}' resolved to provider '${resolvedProvider}' (validated)`,
    }
  }
  if (failures.length > 0) {
    throw new Error(`orchestrator route: listing models failed for ${failures.join('; ')}`)
  }
  throw new Error(
    `orchestrator route model '${String(modelWanted)}' is not listed by any configured provider (${providers.join(', ') || 'none'})`,
  )
}

const MODES: readonly OrchestratorMode[] = ['FULL', 'LITE']
const RISKS: readonly OrchestratorRisk[] = ['LOW', 'STRUCTURAL', 'STATEFUL', 'CRITICAL']
const PHASES: readonly OrchestratorPhase[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6A', 'S6B']
const VERDICTS: readonly OrchestratorVerdict[] = ['PASS', 'BLOCK', 'FAIL', 'COMPLETE']
const ROLES: readonly OrchestratorRole[] = [
  'architect', 'reviewer', 'coder', 'coverage-reviewer', 'code-reviewer', 'qa', 'auditor',
]
const ARTIFACT_KINDS: readonly OrchestratorArtifactKind[] = [
  'goal', 'task', 'architecture', 'review', 'coding-batch', 'coverage-review',
  'codereview', 'qa-report', 'final-audit', 'final', 'receipt', 'probe', 'candidate', 'note',
]

/** stage_report arguments as the model supplies them. */
interface StageReportArgs {
  pipelineId: string
  phase: string
  verdict: string
  blocks?: readonly StageReportBlock[]
  artifacts?: readonly StageReportArtifact[]
  concession?: StageReportConcession
}

/** One BLOCK item as the model supplies it. */
interface StageReportBlock { level?: string; location?: string; description?: string }

/** One artifact record request as the model supplies it. */
interface StageReportArtifact { name: string; kind: string; content: string }

/** One concession registration as the model supplies it. */
interface StageReportConcession { reason?: string; grantedBy?: string }

function requireEnum<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T {
  if (value === undefined || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')} (got ${String(value)})`)
  }
  return value as T
}

/** Canonical output properties shared by every orchestrator tool. */
const EFFECT_OUTPUT = {
  effect: { type: 'string', required: true },
} as const

/** One renderer over the shared { effect } output shape. */
function renderEffect(maxChars: number): (args: unknown, value: unknown) => ContentBlock[] {
  return (_args: unknown, value: unknown) => [{
    type: 'text',
    text: boundText((value as { effect: string }).effect, maxChars),
  }]
}

/** Register the orchestrator tool family and its usage guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const service: OrchestratorService = ctx.orchestrator

  ctx.systemPrompt.section({
    name: 'tool:orchestrator',
    order: 117,
    text: 'Orchestrator pipeline tools: use orchestrator_start + orchestrator_freeze_goal for complex multi-module tasks needing staged roles and review gates, orchestrator_dispatch to run one role child (per-role model routing is deployment-configured and validated at dispatch), orchestrator_stage_report to record artifacts and PASS/BLOCK verdicts through mechanical gates (BLOCK rolls back; the 4th rollback at one stage needs a human decision), orchestrator_capture_vcs to bind git HEAD + dirty anchors when later audits must trace a pipeline to code versions (baseline before freezing the goal; candidate before freeze_candidate), orchestrator_freeze_candidate before S4 PASS, and orchestrator_state to inspect. Pipeline state lives in the central store — never write pipeline files into the working tree.',
  })

  ctx.tools.register(defineTool({
    name: 'orchestrator_start',
    description: 'Create one orchestrator pipeline at S0 with goal/task drafts. The goal stays editable until orchestrator_freeze_goal.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short kebab-case pipeline name.' },
      mode: { type: 'string', description: 'FULL (six-role spine, default) or LITE (merged S1/S2, lighter S3).' },
      riskClass: { type: 'string', description: 'LOW | STRUCTURAL | STATEFUL | CRITICAL (default LOW).' },
      goal: { type: 'string', required: true, description: 'Verbatim goal text; quote the human request and the Definition of Done.' },
      task: { type: 'string', description: 'Task brief: gate commands, boundaries, protocol surface.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pipelineId: { type: 'string', required: true },
          ...EFFECT_OUTPUT,
        },
      },
      render: renderEffect(resolved.maxResultChars),
    },
    async execute(args: { name?: string; mode?: string; riskClass?: string; goal?: string; task?: string }, exec) {
      if (args.goal === undefined || args.name === undefined) {
        throw new Error('orchestrator_start requires name and goal')
      }
      const mode = requireEnum<OrchestratorMode>(args.mode ?? 'FULL', MODES, 'mode')
      const riskClass = requireEnum<OrchestratorRisk>(args.riskClass ?? 'LOW', RISKS, 'riskClass')
      // Anchor the pipeline at the session's project root, matching the
      // list default in orchestrator_state: a server cwd would pool every
      // session's pipelines under the wrong project.
      const projectRoot = exec.agent?.session.header.cwd ?? process.cwd()
      const mutation = await service.create({
        name: args.name,
        projectRoot,
        mode,
        riskClass,
        goalText: args.goal,
        ...(args.task !== undefined ? { taskText: args.task } : {}),
      })
      return {
        pipelineId: mutation.row.id,
        effect: `pipeline ${mutation.row.name} created\n${mutation.effect}\nnext: finalize GOAL/TASK wording with the human, then orchestrator_freeze_goal`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orchestrator_freeze_goal',
    description: 'Finalize the S0 goal/task drafts and freeze the goal hash. After this the goal is immutable; the pipeline advances to S1 (FULL) or S3 (LITE).',
    parameters: {
      pipelineId: { type: 'string', required: true },
      goal: { type: 'string', description: 'Final goal text (required when the draft needs edits).' },
      task: { type: 'string', description: 'Final task brief.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: EFFECT_OUTPUT,
      },
      render: renderEffect(resolved.maxResultChars),
    },
    async execute(args: { pipelineId: string; goal?: string; task?: string }) {
      const mutation = await service.freezeGoal(args.pipelineId, {
        ...(args.goal !== undefined ? { goalText: args.goal } : {}),
        ...(args.task !== undefined ? { taskText: args.task } : {}),
      })
      return {
        effect: `${mutation.effect}\ncurrent: ${mutation.row.currentPhase}; dispatchable roles: ${rolesAt(mutation.row.currentPhase)}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orchestrator_dispatch',
    description: 'Dispatch one role subagent for the current stage. Per-role provider/model routing comes from deployment config; call overrides are validated against the live model catalog before the child starts.',
    parameters: {
      pipelineId: { type: 'string', required: true },
      role: { type: 'string', required: true, description: 'architect | reviewer | coder | coverage-reviewer | code-reviewer | qa | auditor.' },
      prompt: { type: 'string', required: true, description: 'Complete self-contained role prompt: goal anchor, stage inputs, stage duties, required output document.' },
      provider: { type: 'string', description: 'Optional provider override for this one dispatch.' },
      model: { type: 'string', description: 'Optional model override for this one dispatch.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          effect: { type: 'string', required: true },
          agentId: { type: 'string' },
          output: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: boundText((value as { effect: string }).effect, resolved.maxDispatchChars),
      }],
    },
    async execute(args: { pipelineId: string; role: string; prompt: string; provider?: string; model?: string }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('orchestrator_dispatch requires a calling agent')
      const role = requireEnum<OrchestratorRole>(args.role, ROLES, 'role')
      const got = service.get({ id: args.pipelineId })
      if (!got.ok) throw new Error(`orchestrator_dispatch: ${got.error.message}`)
      const row = got.value
      if (row.lifecycle !== 'ACTIVE') throw new Error(`pipeline is ${row.lifecycle}; only ACTIVE pipelines dispatch`)
      const phase = row.currentPhase
      if (phase === 'S0' || phase === 'S6B' || phase === 'COMPLETE') {
        throw new Error(`no role dispatches at ${phase}`)
      }
      const allowed = PHASE_ROLES[phase]
      if (!allowed.includes(role)) {
        throw new Error(`role '${role}' is not dispatchable at ${phase} (allowed: ${allowed.join(', ')})`)
      }

      const configured = resolved.roles[role] ?? {}
      const providerWanted = args.provider !== undefined ? args.provider : configured.provider
      const modelWanted = args.model !== undefined ? args.model : configured.model
      const route = await evaluateRoute(ctx, providerWanted, modelWanted)

      const run = await ctx.subagents.start(resolved.subagentProvider, {
        label: `orchestrator:${role}:${row.name}`,
        prompt: [{ type: 'text', text: args.prompt }],
        parent: agent,
        signal: exec.signal,
        ...(route.provider !== undefined || route.model !== undefined
          ? {
            agentOptions: {
              ...(route.provider !== undefined ? { provider: route.provider } : {}),
              ...(route.model !== undefined ? { model: route.model } : {}),
            },
          }
          : {}),
      })
      try {
        await service.recordDispatch(args.pipelineId, role, {
          agentId: run.id,
          provider: resolved.subagentProvider,
          ...(route.model !== undefined ? { model: route.model } : {}),
          dispatchedAt: Date.now(),
        })
        const result = await run.result
        await service.settleDispatch(args.pipelineId, phase, run.id)
        const text = textOf(result.output)
        const stopNote = result.stopReason === 'completed' ? '' : ` (stopReason: ${result.stopReason})`
        return {
          agentId: run.id,
          output: text,
          effect: `${role} at ${phase} — route: ${route.note}${stopNote}\n--- child output ---\n${text}`,
        }
      } catch (error) {
        // Settle as failed only when the dispatch record exists; a failure
        // in recordDispatch itself leaves no record to settle.
        await service.settleDispatch(args.pipelineId, phase, run.id, true).catch(() => {})
        throw error
      } finally {
        await run.dispose()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orchestrator_stage_report',
    description: 'Record stage artifacts and the stage verdict. PASS advances; BLOCK/FAIL rolls back per the gate rules (S4/S5/S6A rollback invalidates candidate and approvals); COMPLETE (S6B only) seals the pipeline.',
    parameters: {
      pipelineId: { type: 'string', required: true },
      phase: { type: 'string', required: true, description: 'S0..S6B being reported.' },
      verdict: { type: 'string', required: true, description: 'PASS | BLOCK | FAIL | COMPLETE.' },
      artifacts: {
        type: 'array',
        description: 'Artifacts to record into the stage before the verdict.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', required: true, description: 'Artifact kind from the taxonomy.' },
            content: { type: 'string', required: true },
          },
        },
      },
      blocks: {
        type: 'array',
        description: 'BLOCK items (required for BLOCK verdicts): level (Critical|Scoped), location, description.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            level: { type: 'string' },
            location: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      concession: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional registered concession when the verdict carries debt.',
        properties: {
          reason: { type: 'string' },
          grantedBy: { type: 'string' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: EFFECT_OUTPUT,
      },
      render: renderEffect(resolved.maxResultChars),
    },
    async execute(args: StageReportArgs) {
      const phase = requireEnum<OrchestratorPhase>(args.phase, PHASES, 'phase')
      const verdict = requireEnum<OrchestratorVerdict>(args.verdict, VERDICTS, 'verdict')
      // Validate EVERY input before the first mutation: the service commits
      // the whole report atomically, so a validation failure here persists
      // nothing.
      const artifacts = (args.artifacts ?? []).map(artifact => ({
        name: artifact.name,
        kind: requireEnum<OrchestratorArtifactKind>(artifact.kind, ARTIFACT_KINDS, 'artifacts[].kind'),
        content: artifact.content,
      }))
      let concession: { reason: string; grantedBy: string } | undefined
      if (args.concession !== undefined) {
        const reason = args.concession.reason
        const grantedBy = args.concession.grantedBy
        if (typeof reason !== 'string' || typeof grantedBy !== 'string') {
          throw new Error('concession requires reason and grantedBy strings')
        }
        concession = { reason, grantedBy }
      }
      const blocks: OrchestratorBlockItem[] = (args.blocks ?? []).map(item => ({
        level: requireEnum(item.level, ['Critical', 'Scoped'] as const, 'blocks[].level'),
        location: typeof item.location === 'string' && item.location.trim().length > 0 ? item.location : (() => { throw new Error('blocks[].location must be a non-empty string') })(),
        description: typeof item.description === 'string' && item.description.trim().length > 0 ? item.description : (() => { throw new Error('blocks[].description must be a non-empty string') })(),
      }))
      const mutation = await service.reportStage(args.pipelineId, phase, {
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(concession !== undefined ? { concession } : {}),
        verdict,
        ...(blocks.length > 0 ? { blocks } : {}),
      })
      const row = mutation.row
      return {
        effect: `${mutation.effect}\ncurrent: ${row.currentPhase} (${row.lifecycle})\ndispatchable roles: ${rolesAt(row.currentPhase)}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orchestrator_capture_vcs',
    description: 'Sample the pipeline project\'s version-control state (git HEAD + dirty listing, no shell) and bind it to the pipeline: purpose baseline anchors the start (only before the goal freezes), purpose candidate stages the anchor the next freeze_candidate binds. Fails loudly when the project is not a git work tree.',
    parameters: {
      pipelineId: { type: 'string', required: true, description: 'Pipeline to bind the snapshot to.' },
      purpose: { type: 'string', required: true, description: 'baseline | candidate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: EFFECT_OUTPUT,
      },
      render: renderEffect(resolved.maxResultChars),
    },
    async execute(args: { pipelineId: string; purpose: string }, exec) {
      const purpose = requireEnum(args.purpose, ['baseline', 'candidate'] as const, 'purpose')
      const got = service.get({ id: args.pipelineId })
      if (!got.ok) throw new Error(`orchestrator_capture_vcs: ${got.error.message}`)
      const row = got.value
      if (row.lifecycle !== 'ACTIVE') throw new Error(`pipeline is ${row.lifecycle}; only ACTIVE pipelines capture anchors`)
      const runGit = async (gitArgs: readonly string[]) => {
        try {
          const outcome = await resolved.gitRunner('git', ['-C', row.projectRoot, ...gitArgs], exec.signal, VCS_RUN_OPTIONS)
          // git exits 0 with warnings on stderr when parts of the tree are
          // unscannable; recording such a partial listing as a clean anchor
          // would falsify the audit record, so stderr is always fatal.
          if (outcome.stderr.trim().length > 0) {
            throw new Error(`git ${gitArgs.join(' ')} emitted warnings: ${outcome.stderr.trim()}`)
          }
          return outcome
        } catch (error) {
          const failure = error as { stderr?: string; message: string }
          const stderr = failure.stderr?.trim()
          const detail = stderr !== undefined && stderr !== '' ? stderr : failure.message
          throw new Error(`git ${gitArgs.join(' ')} in ${row.projectRoot} failed: ${detail}`)
        }
      }
      const head = (await runGit(['rev-parse', 'HEAD'])).stdout.trim()
      const status = (await runGit(['-c', 'core.quotePath=false', 'status', '--porcelain'])).stdout
      const dirty = status.split('\n').filter(line => line.length > 0)
      const anchor = { head, dirty, capturedAt: Date.now() }
      const mutation = purpose === 'baseline'
        ? await service.captureVcsBaseline(args.pipelineId, anchor)
        : await service.stageCandidateVcs(args.pipelineId, anchor)
      return {
        effect: `${mutation.effect}\npurpose: ${purpose}; ${dirty.length} dirty entr${dirty.length === 1 ? 'y' : 'ies'}${dirty.length === 0 ? '' : `\n${dirty.slice(0, 20).join('\n')}${dirty.length > 20 ? `\n… +${dirty.length - 20} more` : ''}`}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orchestrator_freeze_candidate',
    description: 'Freeze the implementation candidate (64-hex subject hash, e.g. a workspace manifest aggregate) at the S3→S4 boundary; S4/S5/S6A PASS binds approvals to it.',
    parameters: {
      pipelineId: { type: 'string', required: true },
      subjectHash: { type: 'string', required: true, description: 'Lowercase 64-hex sha256 of the candidate subject.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: EFFECT_OUTPUT,
      },
      render: renderEffect(resolved.maxResultChars),
    },
    async execute(args: { pipelineId: string; subjectHash: string }) {
      const mutation = await service.freezeCandidate(args.pipelineId, args.subjectHash)
      return { effect: mutation.effect }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orchestrator_lifecycle',
    description: 'Void or supersede a pipeline: revoke (post-complete defect; names the repairs pipeline) or supersede (a sealed pipeline replaced by a successor).',
    parameters: {
      pipelineId: { type: 'string', required: true },
      action: { type: 'string', required: true, description: 'revoke | supersede.' },
      successorId: { type: 'string', description: 'Successor pipeline id (supersede).' },
      repairsPipeline: { type: 'string', description: 'Repairs pipeline id (revoke).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: EFFECT_OUTPUT,
      },
      render: renderEffect(resolved.maxResultChars),
    },
    async execute(args: { pipelineId: string; action: string; successorId?: string; repairsPipeline?: string }) {
      const action = requireEnum(args.action, ['revoke', 'supersede'] as const, 'action')
      let mutation
      if (action === 'revoke') {
        if (typeof args.repairsPipeline !== 'string') throw new Error('revoke requires repairsPipeline')
        mutation = await service.revoke(args.pipelineId, args.repairsPipeline)
      } else {
        if (typeof args.successorId !== 'string') throw new Error('supersede requires successorId')
        mutation = await service.supersede(args.pipelineId, args.successorId)
      }
      return { effect: mutation.effect }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orchestrator_state',
    description: 'Inspect pipelines: one full row (stage verdicts, dispatch models, artifacts) by id, or the summary list for a project root.',
    parameters: {
      pipelineId: { type: 'string' },
      projectRoot: { type: 'string', description: 'Filter for list mode.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: EFFECT_OUTPUT,
      },
      render: renderEffect(resolved.maxResultChars),
    },
    execute(args: { pipelineId?: string; projectRoot?: string }, exec) {
      if (args.pipelineId !== undefined) {
        const got = service.get({ id: args.pipelineId })
        if (!got.ok) throw new Error(`orchestrator_state: ${got.error.message}`)
        const row = got.value
        const stages = row.stages.map((stage) => {
          const models = stage.dispatches.map(dispatch => dispatch.model ?? 'default').join(', ')
          return `${stage.phase} ${stage.status}${stage.verdict === undefined ? '' : ` ${stage.verdict}`} — artifacts ${stage.artifacts.length}, attempts ${stage.attempts}${models.length === 0 ? '' : `, models ${models}`}`
        }).join('\n')
        return Promise.resolve({
          effect: `pipeline ${row.name} [${row.id}]\nmode ${row.mode} risk ${row.riskClass} lifecycle ${row.lifecycle} current ${row.currentPhase}\ngoal sha256 ${row.goal.sha256 ?? '(unfrozen)'}\nvcs baseline ${row.vcsBaseline === undefined ? '(none)' : `${row.vcsBaseline.head.slice(0, 12)}… (${row.vcsBaseline.dirty.length} dirty)`}; candidate ${row.candidate?.vcs === undefined ? '(unanchored)' : `${row.candidate.vcs.head.slice(0, 12)}… (${row.candidate.vcs.dirty.length} dirty)`}${row.vcsCandidate !== undefined ? `; staged ${row.vcsCandidate.head.slice(0, 12)}…` : ''}\n${stages}\napprovals: ${row.approvals.map(a => a.phase).join(', ') || 'none'}; concessions: ${row.concessions.length}`,
        })
      }
      const projectRoot = args.projectRoot ?? (exec.agent?.session.header.cwd ?? process.cwd())
      const listed = service.list({ projectRoot })
      if (!listed.ok) throw new Error(`orchestrator_state: ${listed.error.message}`)
      const lines = listed.value.pipelines.map(summary =>
        `${summary.name} [${summary.id}] ${summary.lifecycle}/${summary.currentPhase} ${summary.mode} — updated ${new Date(summary.updatedAt).toISOString()}`)
      return Promise.resolve({
        effect: lines.length === 0 ? 'no pipelines for this project' : lines.join('\n'),
      })
    },
  }))
}

function rolesAt(phase: string): string {
  if (phase === 'S0') return 'orchestrating master (finalize goal, then freeze)'
  if (phase === 'S6B' || phase === 'COMPLETE') return 'none (sealing)'
  return PHASE_ROLES[phase as keyof typeof PHASE_ROLES].join(', ')
}
