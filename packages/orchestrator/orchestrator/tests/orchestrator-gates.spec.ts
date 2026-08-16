/**
 * Gates and transition tests for the orchestrator sidecar domain.
 * @module @deepseek-ai/dsh-orchestrator/tests/orchestrator-gates
 */

import { describe, expect, it } from 'vitest'
import {
  applyVerdict,
  buildArtifact,
  evaluateGates,
  initialStages,
  PHASE_ROLES,
  requiredArtifactKinds,
  sha256Text,
  validateVcsAnchor,
  verdictAllowed,
} from '../src/gates.ts'
import { pipelineRowParseError } from '../src/spec.ts'
import type { OrchestratorPipelineRow, OrchestratorStage } from '../src/types.ts'

function baseRow(overrides: Partial<OrchestratorPipelineRow> = {}): OrchestratorPipelineRow {
  return {
    id: 'p1',
    name: 'demo-task',
    projectRoot: '/tmp/demo',
    mode: 'FULL',
    riskClass: 'LOW',
    lifecycle: 'ACTIVE',
    currentPhase: 'S1',
    goal: { text: 'ship the demo', taskText: 'brief', sha256: sha256Text('ship the demo'), frozenAt: 1 },
    stages: initialStages(),
    approvals: [],
    concessions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function stageAt(row: OrchestratorPipelineRow, phase: string): OrchestratorStage {
  const stage = row.stages.find(candidate => candidate.phase === phase)
  if (stage === undefined) throw new Error('missing stage ' + phase)
  return stage
}

function withArtifact(row: OrchestratorPipelineRow, phase: string, name: string, kind: string): OrchestratorPipelineRow {
  const now = 2
  return {
    ...row,
    stages: row.stages.map((stage) => {
      if (stage.phase !== phase) return stage
      const artifact = buildArtifact(stage, name, kind as never, '# ' + name + '\nbody', 1_000_000, now)
      return { ...stage, artifacts: [...stage.artifacts, artifact] }
    }),
  }
}

describe('required artifact matrix', () => {
  it('requires the review spine in FULL mode', () => {
    expect(requiredArtifactKinds('FULL', 'S2')).toEqual(['review'])
    expect(requiredArtifactKinds('FULL', 'S3')).toEqual(['receipt', 'coding-batch'])
  })

  it('lightens S1/S2/S3 for LITE mode', () => {
    expect(requiredArtifactKinds('LITE', 'S1')).toEqual([])
    expect(requiredArtifactKinds('LITE', 'S2')).toEqual([])
    expect(requiredArtifactKinds('LITE', 'S3')).toEqual([])
  })
})

describe('phase roles', () => {
  it('maps review phases to their reviewer roles', () => {
    expect(PHASE_ROLES.S2).toEqual(['reviewer'])
    expect(PHASE_ROLES.S4).toEqual(['code-reviewer'])
    expect(PHASE_ROLES.S6A).toEqual(['auditor'])
  })
})

describe('verdict admission', () => {
  it('confines COMPLETE to S6B and LITE-MERGED to S1/S2', () => {
    expect(verdictAllowed('S6B', 'COMPLETE')).toBe(true)
    expect(verdictAllowed('S4', 'COMPLETE')).toBe(false)
    expect(verdictAllowed('S1', 'LITE-MERGED')).toBe(true)
    expect(verdictAllowed('S3', 'LITE-MERGED')).toBe(false)
  })
})

describe('evaluateGates', () => {
  it('accepts a fresh S1 row with a frozen goal', () => {
    let row = withArtifact(baseRow({ currentPhase: 'S0' }), 'S0', 'goal', 'goal')
    row = withArtifact(row, 'S0', 'task', 'task')
    row = {
      ...row,
      stages: row.stages.map(stage => (stage.phase === 'S0'
        ? { ...stage, status: 'DONE' as const, verdict: 'PASS' as const }
        : stage)),
      currentPhase: 'S1',
    }
    expect(evaluateGates(row)).toEqual([])
  })

  it('rejects a drifted goal hash', () => {
    const row = baseRow({ goal: { text: 'tampered', sha256: sha256Text('original'), frozenAt: 1 } })
    expect(evaluateGates(row).map(violation => violation.rule)).toContain('G3')
  })

  it('rejects DONE stages missing required artifacts', () => {
    const stages = initialStages().map((stage) => {
      if (stage.phase === 'S0') return { ...stage, status: 'DONE' as const, verdict: 'PASS' as const }
      if (stage.phase === 'S1') return { ...stage, status: 'DONE' as const, verdict: 'PASS' as const }
      return stage
    })
    const violations = evaluateGates(baseRow({ stages, currentPhase: 'S2' }))
    expect(violations.map(violation => violation.rule)).toContain('G2')
  })

  it('rejects sealing without the three bound approvals', () => {
    const row = baseRow({ lifecycle: 'SEALED', currentPhase: 'COMPLETE', candidate: { subjectHash: sha256Text('c'), generation: 1, frozenAt: 3 } })
    const violations = evaluateGates(row)
    expect(violations.map(violation => violation.rule)).toContain('G6')
  })
})

describe('applyVerdict', () => {
  it('advances on PASS and activates the next stage', () => {
    const row = withArtifact(baseRow({ currentPhase: 'S1' }), 'S1', 'architecture', 'architecture')
    const { row: next, effect } = applyVerdict(row, 'S1', 'PASS', [], 10)
    expect(stageAt(next, 'S1').status).toBe('DONE')
    expect(next.currentPhase).toBe('S2')
    expect(stageAt(next, 'S2').status).toBe('ACTIVE')
    expect(effect).toContain('advanced to S2')
  })

  it('rolls an S2 BLOCK back to S1 and counts the attempt', () => {
    const row = baseRow({ currentPhase: 'S2' })
    const { row: next } = applyVerdict(row, 'S2', 'BLOCK', [{ level: 'Critical', location: 'a:1', description: 'wrong premise' }], 10)
    expect(stageAt(next, 'S2').status).toBe('BLOCKED')
    expect(stageAt(next, 'S2').attempts).toBe(1)
    expect(next.currentPhase).toBe('S1')
    expect(stageAt(next, 'S1').status).toBe('ACTIVE')
  })

  it('invalidates candidate and approvals when S4 rolls back to S3', () => {
    const row = baseRow({
      currentPhase: 'S4',
      candidate: { subjectHash: sha256Text('c'), generation: 1, frozenAt: 3 },
      approvals: [{ phase: 'S4', subjectHash: sha256Text('c'), grantedAt: 4 }],
    })
    const { row: next } = applyVerdict(row, 'S4', 'BLOCK', [{ level: 'Scoped', location: 'c:1', description: 'rework needed' }], 10)
    expect(next.currentPhase).toBe('S3')
    expect(next.candidate).toBeUndefined()
    expect(next.approvals).toEqual([])
  })

  it('refuses the fourth rollback at one stage', () => {
    const stages = initialStages().map(stage => (stage.phase === 'S2' ? { ...stage, attempts: 3 } : stage))
    const row = baseRow({ currentPhase: 'S2', stages })
    expect(() => applyVerdict(row, 'S2', 'BLOCK', [{ level: 'Critical', location: 'a:1', description: 'again' }], 10)).toThrow(/cap/)
  })

  it('refuses sealing with gates violated', () => {
    const doneStages = initialStages().map(stage => ({ ...stage, status: 'DONE' as const, verdict: 'PASS' as const }))
    const row = baseRow({ currentPhase: 'S6B', stages: doneStages })
    expect(() => applyVerdict(row, 'S6B', 'COMPLETE', [], 10)).toThrow(/gates/)
  })
})

describe('buildArtifact', () => {
  it('hashes content and enforces uniqueness', () => {
    const stage = initialStages()[1]!
    const artifact = buildArtifact(stage, 'architecture', 'architecture', 'doc', 1000, 5)
    expect(artifact.sha256).toBe(sha256Text('doc'))
    expect(() => buildArtifact({ ...stage, artifacts: [artifact] }, 'architecture', 'architecture', 'doc2', 1000, 5)).toThrow(/exists/)
  })

  it('enforces the byte cap', () => {
    expect(() => buildArtifact(initialStages()[1]!, 'big', 'note', 'x'.repeat(11), 10, 5)).toThrow(/cap/)
  })
})

describe('adversarial-review gates', () => {
  it('G10 rejects a row past S0 whose goal is unfrozen', () => {
    const row = baseRow({ currentPhase: 'S3', goal: { text: 'unfrozen' } })
    expect(evaluateGates(row).map(violation => violation.rule)).toContain('G10')
  })

  it('G9 accepts a baseline sampled before creation and rejects one after the freeze', () => {
    const pre = baseRow({ vcsBaseline: { head: 'a'.repeat(64), dirty: [], capturedAt: 0 } })
    expect(evaluateGates(pre)).toEqual([])
    const post = baseRow({ vcsBaseline: { head: 'a'.repeat(64), dirty: [], capturedAt: 9 } })
    expect(evaluateGates(post).map(violation => violation.rule)).toContain('G9')
  })

  it('refuses every verdict at S0: the freeze is the only S0 closer', () => {
    for (const verdict of ['PASS', 'BLOCK', 'FAIL', 'COMPLETE'] as const) {
      expect(verdictAllowed('S0', verdict)).toBe(false)
    }
  })

  it('applyVerdict refuses BLOCK/FAIL without block items', () => {
    expect(() => applyVerdict(baseRow({ currentPhase: 'S2' }), 'S2', 'BLOCK', [], 10))
      .toThrow(/at least one block item/)
    expect(() => applyVerdict(baseRow({ currentPhase: 'S3' }), 'S3', 'FAIL', [], 10))
      .toThrow(/at least one block item/)
  })

  it('buildArtifact enforces the durable name bound', () => {
    const stage = stageAt(baseRow(), 'S0')
    expect(() => buildArtifact(stage, 'z'.repeat(201), 'note', 'x', 1000, 1)).toThrow(/at most 200/)
    expect(buildArtifact(stage, 'z'.repeat(200), 'note', 'x', 1000, 1).name.length).toBe(200)
  })

  it('validateVcsAnchor accepts 40-hex sha1 and 64-hex sha256 heads', () => {
    expect(validateVcsAnchor({ head: 'a'.repeat(40), dirty: [], capturedAt: 1 }).head).toHaveLength(40)
    expect(validateVcsAnchor({ head: 'a'.repeat(64), dirty: [], capturedAt: 1 }).head).toHaveLength(64)
    expect(() => validateVcsAnchor({ head: 'a'.repeat(41), dirty: [], capturedAt: 1 }))
      .toThrow(/git object id/)
  })

  it('strict durable schema rejects unknown fields and out-of-bound names on parse', () => {
    const good = baseRow({})
    expect(pipelineRowParseError(good)).toBeUndefined()
    const unknown = { ...good, futureField: 1 } as OrchestratorPipelineRow
    expect(pipelineRowParseError(unknown)).toMatch(/durable schema/)
    expect(pipelineRowParseError(baseRow({ name: 'x'.repeat(201) }))).toMatch(/200/)
  })
})
