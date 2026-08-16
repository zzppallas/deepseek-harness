/**
 * Durable storage-domain declaration for orchestrator pipeline sidecars.
 * @module @deepseek-ai/dsh-orchestrator/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { OrchestratorPipelineRow } from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const epochMs = nonNegativeSafeInteger
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase 64-hex sha256')

/** Lowercase hex git object id: 40-hex sha1 or 64-hex sha256. */
export const GIT_OBJECT_ID_HEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const gitHeadHex = z.string().regex(GIT_OBJECT_ID_HEX, 'must be a lowercase hex git object id (40-hex sha1 or 64-hex sha256)')
const kebabish = z.string().min(1).max(200)

/** Durable bound for pipeline and artifact names, enforced at every write. */
export const NAME_MAX = 200

const artifactKindSchema = z.enum([
  'goal', 'task', 'architecture', 'review', 'coding-batch', 'coverage-review',
  'codereview', 'qa-report', 'final-audit', 'final', 'receipt', 'probe', 'candidate', 'note',
])
const roleSchema = z.enum([
  'architect', 'reviewer', 'coder', 'coverage-reviewer', 'code-reviewer', 'qa', 'auditor',
])

const artifactSchema = z.strictObject({
  name: kebabish,
  kind: artifactKindSchema,
  sha256: sha256Hex,
  bytes: nonNegativeSafeInteger,
  content: z.string(),
  createdAt: epochMs,
})

const dispatchSchema = z.strictObject({
  role: roleSchema,
  agentId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  dispatchedAt: epochMs,
  settledAt: epochMs.optional(),
  settled: z.boolean(),
  failed: z.boolean().optional(),
})

const blockItemSchema = z.strictObject({
  level: z.enum(['Critical', 'Scoped']),
  location: z.string(),
  description: z.string(),
})

const stageSchema = z.strictObject({
  phase: z.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6A', 'S6B']),
  status: z.enum(['PENDING', 'ACTIVE', 'DONE', 'BLOCKED']),
  verdict: z.enum(['PASS', 'BLOCK', 'FAIL', 'LITE-MERGED', 'COMPLETE']).optional(),
  blocks: z.array(blockItemSchema).optional(),
  artifacts: z.array(artifactSchema),
  dispatches: z.array(dispatchSchema),
  attempts: z.number().int().nonnegative().max(3),
  startedAt: epochMs.optional(),
  finishedAt: epochMs.optional(),
})

const approvalSchema = z.strictObject({
  phase: z.enum(['S4', 'S5', 'S6A']),
  subjectHash: sha256Hex,
  grantedAt: epochMs,
})

const concessionSchema = z.strictObject({
  phase: z.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6A', 'S6B']),
  reason: z.string().min(1),
  grantedBy: z.string().min(1),
  grantedAt: epochMs,
})

const goalSchema = z.strictObject({
  text: z.string(),
  taskText: z.string().optional(),
  sha256: sha256Hex.optional(),
  frozenAt: epochMs.optional(),
})

const vcsAnchorSchema = z.object({
  head: gitHeadHex,
  dirty: z.array(z.string().min(1).max(4096)).max(4096),
  capturedAt: epochMs,
})

const candidateSchema = z.strictObject({
  subjectHash: sha256Hex,
  generation: z.number().int().min(1),
  frozenAt: epochMs,
  vcs: vcsAnchorSchema.optional(),
})

const pipelineRowSchema = z.strictObject({
  id: z.string().min(1),
  name: kebabish,
  projectRoot: z.string().min(1),
  mode: z.enum(['FULL', 'LITE']),
  riskClass: z.enum(['LOW', 'STRUCTURAL', 'STATEFUL', 'CRITICAL']),
  lifecycle: z.enum(['ACTIVE', 'SEALED', 'SUPERSEDED', 'REVOKED']),
  currentPhase: z.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6A', 'S6B', 'COMPLETE']),
  goal: goalSchema,
  stages: z.array(stageSchema),
  candidate: candidateSchema.optional(),
  vcsBaseline: vcsAnchorSchema.optional(),
  vcsCandidate: vcsAnchorSchema.optional(),
  approvals: z.array(approvalSchema),
  concessions: z.array(concessionSchema),
  supersededBy: z.string().min(1).optional(),
  repairsPipeline: z.string().min(1).optional(),
  createdAt: epochMs,
  updatedAt: epochMs,
}).superRefine((row, ctx) => {
  const phases = row.stages.map(stage => stage.phase)
  const canonical = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6A', 'S6B']
  if (phases.join(',') !== canonical.join(',')) {
    ctx.addIssue({
      code: 'custom',
      path: ['stages'],
      message: 'stages must list every canonical phase exactly once in order',
    })
  }
})

/** Persisted row type inferred from the durable schema. */
export type OrchestratorPersistedRow = z.infer<typeof pipelineRowSchema>

/**
 * One whole-pipeline sidecar per pipeline id. The table lives in the DSH
 * storage home, never in the project working tree.
 */
/** Exact schema parameter shape expected by the pipelines table. */
type PipelineTableSchema = Parameters<typeof domainTable<string, OrchestratorPipelineRow>>[0]

export const orchestratorDomainSpec = defineDomain({
  name: 'orchestrator',
  version: 0,
  tables: {
    pipelines: domainTable<string, OrchestratorPipelineRow>(
      pipelineRowSchema as unknown as PipelineTableSchema,
    ),
  },
})

/**
 * First durable-schema violation message for one row, or undefined when the
 * row matches the spec. The service runs this before persisting so a
 * schema-bounded write fails at the commit instead of at the next open.
 * @param row - candidate row.
 * @returns the first issue message, or undefined when the row is valid.
 */
export function pipelineRowParseError(row: OrchestratorPipelineRow): string | undefined {
  const parsed = pipelineRowSchema.safeParse(row)
  if (parsed.success) return undefined
  const issue = parsed.error.issues[0]
  if (issue === undefined) return 'unknown schema violation'
  const path = issue.path.join('.')
  return `durable schema: ${path === '' ? '(row)' : path} ${issue.message}`
}
