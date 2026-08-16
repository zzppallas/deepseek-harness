/**
 * Service-level round-trip tests over a real json storage-domain backend.
 * @module @deepseek-ai/dsh-orchestrator/tests/orchestrator-service
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { OrchestratorService } from '../src/index.ts'

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly dispose: () => Promise<void>
}

const harnesses: Harness[] = []

async function harness(root: string): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(OrchestratorService, { maxArtifactBytes: 65_536 })
  const value = { ctx, root, dispose: async () => { await ctx.fiber.dispose() } }
  harnesses.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async (value) => {
    await value.dispose()
    await rm(value.root, { recursive: true, force: true })
  }))
})

describe('OrchestratorService over real storage', () => {
  it('publishes the exact Remote method names', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    expect(remoteMethods(ctx.orchestrator)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'get', invocation: { kind: 'direct' } },
      { method: 'artifact', invocation: { kind: 'direct' } },
    ])
  })

  it('runs create → freeze → dispatch → PASS → BLOCK rollback with model routing recorded', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'demo-task',
      projectRoot: '/tmp/demo',
      mode: 'FULL',
      riskClass: 'LOW',
      goalText: 'ship the demo',
      taskText: 'gate: npm test',
    })
    const id = created.row.id
    expect(created.row.currentPhase).toBe('S0')
    expect(created.row.goal.sha256).toBeUndefined()

    const frozen = await ctx.orchestrator.freezeGoal(id, {})
    expect(frozen.row.currentPhase).toBe('S1')
    expect(frozen.row.goal.sha256).toMatch(/^[0-9a-f]{64}$/)

    await ctx.orchestrator.recordDispatch(id, 'architect', {
      agentId: 'child-1',
      provider: 'spawn',
      model: 'deepseek-reasoner',
      dispatchedAt: Date.now(),
    })
    await ctx.orchestrator.settleDispatch(id, 'S1', 'child-1')
    await ctx.orchestrator.recordArtifact(id, 'S1', {
      name: 'architecture',
      kind: 'architecture',
      content: '# Architecture\nmodules: a, b, c',
    })
    const passed = await ctx.orchestrator.recordVerdict(id, 'S1', 'PASS', [])
    expect(passed.row.currentPhase).toBe('S2')

    const blocked = await ctx.orchestrator.recordVerdict(id, 'S2', 'BLOCK', [
      { level: 'Critical', location: 'ARCHITECTURE.md#batches', description: 'unfounded module split' },
    ])
    expect(blocked.row.currentPhase).toBe('S1')
    expect(blocked.row.stages.find(stage => stage.phase === 'S2')?.attempts).toBe(1)

    const listed = ctx.orchestrator.list({ projectRoot: '/tmp/demo' })
    expect(listed.ok && listed.value.pipelines.length).toBe(1)
    expect(listed.ok && listed.value.pipelines[0]!.stages.find(stage => stage.phase === 'S1')?.lastModel)
      .toBe('deepseek-reasoner')

    const artifact = ctx.orchestrator.artifact({ id, phase: 'S1', name: 'architecture' })
    expect(artifact.ok && artifact.value.content).toContain('# Architecture')
  })

  it('LITE pipelines jump straight to S3 with merged S1/S2', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'lite-task',
      projectRoot: '/tmp/lite',
      mode: 'LITE',
      riskClass: 'LOW',
      goalText: 'small fix',
    })
    const frozen = await ctx.orchestrator.freezeGoal(created.row.id, {})
    expect(frozen.row.currentPhase).toBe('S3')
    expect(frozen.row.stages.find(stage => stage.phase === 'S1')?.verdict).toBe('LITE-MERGED')
    expect(frozen.row.stages.find(stage => stage.phase === 'S2')?.verdict).toBe('LITE-MERGED')
  })

  it('persists centrally and survives a reopen of the storage root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-'))
    const first = await harness(root)
    const created = await first.ctx.orchestrator.create({
      name: 'durable-task',
      projectRoot: '/tmp/durable',
      mode: 'FULL',
      riskClass: 'LOW',
      goalText: 'survive reopen',
    })
    const id = created.row.id
    await first.ctx.orchestrator.freezeGoal(id, {})
    await first.dispose()

    // Reopen the SAME root: the row must still be there — state is durable in
    // the central store, never in the working tree.
    const second = await harness(root)
    const got = second.ctx.orchestrator.get({ id })
    expect(got.ok && got.value.name).toBe('durable-task')
    expect(got.ok && got.value.currentPhase).toBe('S1')
  })
})

describe('OrchestratorService version-control anchors', () => {
  const HEAD = 'a'.repeat(64)
  const anchor = (over: Partial<{ head: string; dirty: string[]; capturedAt: number }> = {}) => ({
    head: HEAD,
    dirty: [' M packages/a/tsconfig.json', '?? packages/b/'],
    capturedAt: Date.now(),
    ...over,
  })

  it('accepts a create-time baseline and projects its head in summaries', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'anchored',
      projectRoot: '/tmp/anchored',
      mode: 'LITE',
      riskClass: 'LOW',
      goalText: 'g',
      baselineVcs: anchor(),
    })
    const row = created.row
    expect(row.vcsBaseline?.head).toBe(HEAD)
    const listed = ctx.orchestrator.list({ projectRoot: '/tmp/anchored' })
    expect(listed.ok && listed.value.pipelines[0]?.baselineHead).toBe(HEAD)
    expect(listed.ok && listed.value.pipelines[0]?.candidateHead).toBeUndefined()
  })

  it('rejects a baseline after the goal froze and rejects malformed anchors', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'late-baseline',
      projectRoot: '/tmp/late',
      mode: 'LITE',
      riskClass: 'LOW',
      goalText: 'g',
    })
    const id = created.row.id
    // Structural rejection fires while the goal is still a draft.
    await expect(ctx.orchestrator.captureVcsBaseline(id, anchor({ head: 'nothex' })))
      .rejects.toThrow('64-hex')
    await expect(ctx.orchestrator.captureVcsBaseline(id, anchor({ dirty: [''] })))
      .rejects.toThrow('dirty lines')
    // Timing rejection fires once the goal has frozen.
    await ctx.orchestrator.freezeGoal(id, {})
    await expect(ctx.orchestrator.captureVcsBaseline(id, anchor()))
      .rejects.toThrow('vcs baselines are captured before the goal freezes')
  })

  it('binds a staged anchor to the frozen candidate and drops it on rollback', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'bind',
      projectRoot: '/tmp/bind',
      mode: 'LITE',
      riskClass: 'LOW',
      goalText: 'g',
    })
    const id = created.row.id
    await ctx.orchestrator.freezeGoal(id, {})
    await ctx.orchestrator.stageCandidateVcs(id, anchor())
    // LITE reaches S4 after S3 closes with an artifact.
    await ctx.orchestrator.recordArtifact(id, 'S3', { name: 'batch', kind: 'note', content: 'x' })
    await ctx.orchestrator.recordVerdict(id, 'S3', 'PASS', [])
    const frozen = await ctx.orchestrator.freezeCandidate(id, 'b'.repeat(64))
    expect(frozen.row.candidate?.vcs?.head).toBe(HEAD)
    expect(frozen.row.vcsCandidate).toBeUndefined()
    const listed = ctx.orchestrator.list({ projectRoot: '/tmp/bind' })
    expect(listed.ok && listed.value.pipelines[0]?.candidateHead).toBe(HEAD)

    // S4 BLOCK rolls back to S3: candidate (with its anchor) is invalidated.
    const blocked = await ctx.orchestrator.recordVerdict(id, 'S4', 'BLOCK', [
      { level: 'Scoped', location: 'x', description: 'y' },
    ])
    expect(blocked.row.candidate).toBeUndefined()
    expect(blocked.row.vcsBaseline).toBeUndefined()
  })

  it('refuses a staged anchor that postdates the freeze', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'future-anchor',
      projectRoot: '/tmp/future',
      mode: 'LITE',
      riskClass: 'LOW',
      goalText: 'g',
    })
    const id = created.row.id
    await ctx.orchestrator.freezeGoal(id, {})
    // Future-dated anchors are refused at the stage, not deferred to the freeze.
    await expect(ctx.orchestrator.stageCandidateVcs(id, anchor({ capturedAt: Date.now() + 3_600_000 })))
      .rejects.toThrow('dated in the future')
  })
})

describe('adversarial-review service fixes', () => {
  const H = 'a'.repeat(64)
  const anchor = (over: Partial<{ head: string; dirty: string[]; capturedAt: number }> = {}) => ({
    head: H, dirty: [], capturedAt: Date.now(), ...over,
  })

  it('refuses to close S0 by verdict and keeps the goal immutable afterwards', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 's0-guard', projectRoot: '/tmp/s0', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    await expect(ctx.orchestrator.recordVerdict(id, 'S0', 'PASS', [])).rejects.toThrow('not valid at phase')
    await ctx.orchestrator.freezeGoal(id, {})
    await expect(ctx.orchestrator.recordArtifact(id, 'S0', { name: 'goal-v2', kind: 'goal', content: 'evil' }))
      .rejects.toThrow('artifacts go to the current stage')
  })

  it('rejects names beyond the durable bound at create and via buildArtifact', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    await expect(ctx.orchestrator.create({
      name: 'n'.repeat(201), projectRoot: '/tmp/n', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })).rejects.toThrow(/at most 200/)
    const ok = await ctx.orchestrator.create({
      name: 'n'.repeat(200), projectRoot: '/tmp/n', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    expect(ok.row.name).toHaveLength(200)
  })

  it('stages candidate anchors only during S3/S4 with a fresh sample', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'window', projectRoot: '/tmp/w', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    // S0: not in the candidate window.
    await expect(ctx.orchestrator.stageCandidateVcs(id, anchor())).rejects.toThrow(/S3\/S4/)
    await ctx.orchestrator.freezeGoal(id, {})
    // Predates the coding stage start.
    await expect(ctx.orchestrator.stageCandidateVcs(id, anchor({ capturedAt: 1 })))
      .rejects.toThrow(/predates the coding stage/)
    await ctx.orchestrator.recordArtifact(id, 'S3', { name: 'batch', kind: 'note', content: 'x' })
    await ctx.orchestrator.recordVerdict(id, 'S3', 'PASS', [])
    await ctx.orchestrator.freezeCandidate(id, 'b'.repeat(64))
    // Candidate exists: re-staging refused.
    await expect(ctx.orchestrator.stageCandidateVcs(id, anchor())).rejects.toThrow(/already frozen/)
  })

  it('refuses a second freeze and makes generation monotone across rollbacks', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'gen', projectRoot: '/tmp/g', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    await ctx.orchestrator.freezeGoal(id, {})
    await ctx.orchestrator.recordArtifact(id, 'S3', { name: 'batch', kind: 'note', content: 'x' })
    await ctx.orchestrator.recordVerdict(id, 'S3', 'PASS', [])
    const first = await ctx.orchestrator.freezeCandidate(id, 'b'.repeat(64))
    expect(first.row.candidate?.generation).toBe(1)
    await expect(ctx.orchestrator.freezeCandidate(id, 'c'.repeat(64))).rejects.toThrow(/already frozen/)
    await ctx.orchestrator.recordVerdict(id, 'S4', 'BLOCK', [{ level: 'Scoped', location: 'x', description: 'rework' }])
    await ctx.orchestrator.recordArtifact(id, 'S3', { name: 'batch2', kind: 'note', content: 'x' })
    await ctx.orchestrator.recordVerdict(id, 'S3', 'PASS', [])
    const second = await ctx.orchestrator.freezeCandidate(id, 'd'.repeat(64))
    expect(second.row.candidate?.generation).toBe(2)
  })

  it('settles exactly one dispatch by id, refuses re-settle and terminal rows, records failures', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'settle', projectRoot: '/tmp/s', mode: 'FULL', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    await ctx.orchestrator.freezeGoal(id, {})
    await ctx.orchestrator.recordDispatch(id, 'architect', { agentId: 'rev-1', provider: 'spawn', dispatchedAt: Date.now() })
    await ctx.orchestrator.recordDispatch(id, 'architect', { agentId: 'rev-2', provider: 'spawn', dispatchedAt: Date.now() })
    await expect(ctx.orchestrator.settleDispatch(id, 'S1', 'missing')).rejects.toThrow(/no dispatch/)
    await ctx.orchestrator.settleDispatch(id, 'S1', 'rev-1', true)
    const settled = ctx.orchestrator.get({ id })
    expect(settled.ok).toBe(true)
    const [d1, d2] = (settled.ok ? settled.value.stages.find(stage => stage.phase === 'S1')!.dispatches : [])
    expect(d1?.settled).toBe(true)
    expect(d1?.failed).toBe(true)
    expect(d2?.settled).toBe(false)
    await expect(ctx.orchestrator.settleDispatch(id, 'S1', 'rev-1')).rejects.toThrow(/already settled/)
    await ctx.orchestrator.recordArtifact(id, 'S1', { name: 'architecture', kind: 'architecture', content: '# arch' })
    await ctx.orchestrator.recordVerdict(id, 'S1', 'PASS', [])
    // Unsettled dispatch rides to S2 untouched.
    const s2row = ctx.orchestrator.get({ id })
    expect(s2row.ok).toBe(true)
    const s2 = (s2row.ok ? s2row.value.stages.find(stage => stage.phase === 'S2')! : undefined)!
    expect(s2.status).toBe('ACTIVE')
  })

  it('refuses concessions and settles on terminal lifecycles', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'sealed-guard', projectRoot: '/tmp/sg', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    await ctx.orchestrator.freezeGoal(id, {})
    await ctx.orchestrator.recordArtifact(id, 'S3', { name: 'batch', kind: 'note', content: 'x' })
    await ctx.orchestrator.recordVerdict(id, 'S3', 'PASS', [])
    await ctx.orchestrator.freezeCandidate(id, 'b'.repeat(64))
    await ctx.orchestrator.recordArtifact(id, 'S4', { name: 'codereview', kind: 'codereview', content: 'ok' })
    await ctx.orchestrator.recordVerdict(id, 'S4', 'PASS', [])
    await ctx.orchestrator.recordArtifact(id, 'S5', { name: 'qa-report', kind: 'qa-report', content: 'ok' })
    await ctx.orchestrator.recordVerdict(id, 'S5', 'PASS', [])
    await ctx.orchestrator.recordArtifact(id, 'S6A', { name: 'final-audit', kind: 'final-audit', content: 'ok' })
    await ctx.orchestrator.recordVerdict(id, 'S6A', 'PASS', [])
    await ctx.orchestrator.recordArtifact(id, 'S6B', { name: 'final', kind: 'final', content: 'ok' })
    await ctx.orchestrator.recordVerdict(id, 'S6B', 'COMPLETE', [])
    await expect(ctx.orchestrator.registerConcession(id, 'S6A', 'late', 'human')).rejects.toThrow(/SEALED/)
    await expect(ctx.orchestrator.settleDispatch(id, 'S3', 'x')).rejects.toThrow(/SEALED/)
  })

  it('validates revoke and supersede referents', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'ref', projectRoot: '/tmp/r', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    await expect(ctx.orchestrator.revoke(id, '')).rejects.toThrow(/non-empty/)
    await expect(ctx.orchestrator.revoke(id, id)).rejects.toThrow(/own repairs/)
    await expect(ctx.orchestrator.revoke(id, 'no-such')).rejects.toThrow(/does not exist/)
    // Seal id, then build a successor and supersede.
    const other = await ctx.orchestrator.create({
      name: 'other', projectRoot: '/tmp/r', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const oid = other.row.id
    const close = async (pid: string) => {
      await ctx.orchestrator.freezeGoal(pid, {})
      await ctx.orchestrator.recordArtifact(pid, 'S3', { name: 'batch', kind: 'note', content: 'x' })
      await ctx.orchestrator.recordVerdict(pid, 'S3', 'PASS', [])
      await ctx.orchestrator.freezeCandidate(pid, 'b'.repeat(64))
      await ctx.orchestrator.recordArtifact(pid, 'S4', { name: 'codereview', kind: 'codereview', content: 'ok' })
      await ctx.orchestrator.recordVerdict(pid, 'S4', 'PASS', [])
      await ctx.orchestrator.recordArtifact(pid, 'S5', { name: 'qa-report', kind: 'qa-report', content: 'ok' })
      await ctx.orchestrator.recordVerdict(pid, 'S5', 'PASS', [])
      await ctx.orchestrator.recordArtifact(pid, 'S6A', { name: 'final-audit', kind: 'final-audit', content: 'ok' })
      await ctx.orchestrator.recordVerdict(pid, 'S6A', 'PASS', [])
      await ctx.orchestrator.recordArtifact(pid, 'S6B', { name: 'final', kind: 'final', content: 'ok' })
      await ctx.orchestrator.recordVerdict(pid, 'S6B', 'COMPLETE', [])
    }
    await close(id)
    await expect(ctx.orchestrator.supersede(id, id)).rejects.toThrow(/own successor/)
    await expect(ctx.orchestrator.supersede(id, 'no-such')).rejects.toThrow(/does not exist/)
    // oid is ACTIVE: a valid supersede target.
    const superseded = await ctx.orchestrator.supersede(id, oid)
    expect(superseded.row.lifecycle).toBe('SUPERSEDED')
    // A non-ACTIVE successor is refused: revoke oid, then supersede the
    // sealed id again — the source must also be SEALED, so re-seal via a
    // fresh pipeline carrying the same shape.
    await close(oid)
    await ctx.orchestrator.revoke(oid, id)
    await expect(ctx.orchestrator.supersede(id, oid)).rejects.toThrow(/only SEALED/)
    const third = await ctx.orchestrator.create({
      name: 'third', projectRoot: '/tmp/r', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    await close(third.row.id)
    await expect(ctx.orchestrator.supersede(third.row.id, oid)).rejects.toThrow(/REVOKED, not ACTIVE/)
  })

  it('freezeGoal keeps pre-freeze S0 artifacts', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'keep', projectRoot: '/tmp/k', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    await ctx.orchestrator.recordArtifact(id, 'S0', { name: 'human-note', kind: 'note', content: 'feedback' })
    const frozen = await ctx.orchestrator.freezeGoal(id, {})
    const names = frozen.row.stages.find(stage => stage.phase === 'S0')!.artifacts.map(artifact => artifact.name)
    expect(names).toEqual(['goal', 'task', 'human-note'])
  })

  it('reportStage commits atomically: a failing verdict persists no artifacts', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    const created = await ctx.orchestrator.create({
      name: 'atomic', projectRoot: '/tmp/a', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    await ctx.orchestrator.freezeGoal(id, {})
    await ctx.orchestrator.recordArtifact(id, 'S3', { name: 'batch', kind: 'note', content: 'x' })
    await ctx.orchestrator.recordVerdict(id, 'S3', 'PASS', [])
    // S4 PASS without a candidate must persist nothing.
    await expect(ctx.orchestrator.reportStage(id, 'S4', {
      verdict: 'PASS',
      artifacts: [{ name: 'codereview', kind: 'codereview', content: 'ok' }],
    })).rejects.toThrow(/freeze a candidate/)
    const s4row = ctx.orchestrator.get({ id })
    expect(s4row.ok).toBe(true)
    const s4 = (s4row.ok ? s4row.value.stages.find(stage => stage.phase === 'S4')! : undefined)!
    expect(s4.artifacts).toEqual([])
    expect(s4.status).toBe('ACTIVE')
    // A full atomic report works end to end.
    await ctx.orchestrator.freezeCandidate(id, 'b'.repeat(64))
    const reported = await ctx.orchestrator.reportStage(id, 'S4', {
      verdict: 'PASS',
      artifacts: [{ name: 'codereview', kind: 'codereview', content: 'ok' }],
    })
    expect(reported.row.currentPhase).toBe('S5')
  })

  it('refuses future-dated baselines at create and freezes committed rows', async () => {
    const { ctx } = await harness(await mkdtemp(join(tmpdir(), 'dsh-orchestrator-test-')))
    await expect(ctx.orchestrator.create({
      name: 'future', projectRoot: '/tmp/f', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
      baselineVcs: { head: H, dirty: [], capturedAt: Date.now() + 3_600_000 },
    })).rejects.toThrow(/dated in the future/)
    const created = await ctx.orchestrator.create({
      name: 'frozen-row', projectRoot: '/tmp/f', mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    expect(Object.isFrozen(created.row)).toBe(true)
    expect(Object.isFrozen(created.row.stages)).toBe(true)
    const gotResult = ctx.orchestrator.get({ id: created.row.id })
    expect(gotResult.ok).toBe(true)
    const got = gotResult.ok ? gotResult.value : undefined
    expect(Object.isFrozen(got!.stages[0]!.artifacts)).toBe(true)
  })
})
