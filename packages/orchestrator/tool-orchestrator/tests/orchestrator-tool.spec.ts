/**
 * Tool-level composition tests for the orchestrator tool family over the
 * real service, storage stack, and tool runtime; only the external git
 * command boundary is faked through the sanctioned NativeCommandRunner seam.
 * @module @deepseek-ai/dsh-tool-orchestrator/tests/orchestrator-tool
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type LlmModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SubagentRuntime, { type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import OrchestratorService from '@deepseek-ai/dsh-orchestrator'
import * as toolOrchestrator from '../src/index.ts'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'

const signal = new AbortController().signal
const HEAD = 'd'.repeat(64)

/** Fake git boundary: canned HEAD plus porcelain lines, argv-visible to the test. */
function fakeGit(over: Partial<Record<'head' | 'status', string>> = {}, fail = false): NativeCommandRunner {
  return async (_command, args) => {
    if (fail) throw Object.assign(new Error('git failed'), { code: 128, stderr: 'fatal: not a git repository' })
    if (args.includes('HEAD')) return { stdout: over.head ?? `${HEAD}\n`, stderr: '' }
    // Real git emits plain LF terminators; the \r normalizer belongs to
    // the service boundary, not to the tool fixture.
    return { stdout: over.status ?? ' M packages/a/package.json\n?? packages/b/\n', stderr: '' }
  }
}

interface Harness {
  readonly ctx: Context
  readonly root: string
  readonly dispose: () => Promise<void>
}

const harnesses: Harness[] = []

async function harness(git: NativeCommandRunner, config: Partial<toolOrchestrator.Config> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-orchestrator-test-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(OrchestratorService, { maxArtifactBytes: 65_536 })
  await ctx.plugin(toolOrchestrator, { gitRunner: git, ...config })
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

async function pipeline(ctx: Context, name: string): Promise<string> {
  const created = await ctx.orchestrator.create({
    name,
    projectRoot: '/tmp/tool-test',
    mode: 'LITE',
    riskClass: 'LOW',
    goalText: 'g',
  })
  return created.row.id
}

describe('orchestrator_capture_vcs over the real composition', () => {
  it('captures a baseline anchor through the git boundary', async () => {
    const { ctx } = await harness(fakeGit())
    const id = await pipeline(ctx, 'baseline')
    const result = await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_capture_vcs',
      arguments: { pipelineId: id, purpose: 'baseline' },
    })
    const got = ctx.orchestrator.get({ id })
    expect(got.ok && got.value.vcsBaseline?.head).toBe(HEAD)
    expect(got.ok && got.value.vcsBaseline?.dirty).toEqual([' M packages/a/package.json', '?? packages/b/'])
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('vcs baseline captured')
  })

  it('stages a candidate anchor and binds it at freeze_candidate', async () => {
    const { ctx } = await harness(fakeGit())
    const id = await pipeline(ctx, 'staged')
    await ctx.orchestrator.freezeGoal(id, {})
    await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_capture_vcs',
      arguments: { pipelineId: id, purpose: 'candidate' },
    })
    await ctx.orchestrator.recordArtifact(id, 'S3', { name: 'batch', kind: 'note', content: 'x' })
    await ctx.orchestrator.recordVerdict(id, 'S3', 'PASS', [])
    await ctx.tools.execute({
      signal, callId: CallId('c2'), name: 'orchestrator_freeze_candidate',
      arguments: { pipelineId: id, subjectHash: 'e'.repeat(64) },
    })
    const got = ctx.orchestrator.get({ id })
    expect(got.ok && got.value.candidate?.vcs?.head).toBe(HEAD)
    expect(got.ok && got.value.vcsCandidate).toBeUndefined()
  })

  it('fails loudly when git is unavailable or the purpose is invalid', async () => {
    const { ctx } = await harness(fakeGit({}, true))
    const id = await pipeline(ctx, 'failing')
    const failed = await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_capture_vcs',
      arguments: { pipelineId: id, purpose: 'baseline' },
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toContain('not a git repository')
    const invalid = await ctx.tools.execute({
      signal, callId: CallId('c2'), name: 'orchestrator_capture_vcs',
      arguments: { pipelineId: id, purpose: 'later' },
    })
    expect(invalid.isError).toBe(true)
    expect(JSON.stringify(invalid.content)).toContain('purpose')
  })

  it('surfaces anchor heads in orchestrator_state', async () => {
    const { ctx } = await harness(fakeGit())
    const id = await pipeline(ctx, 'visible')
    await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_capture_vcs',
      arguments: { pipelineId: id, purpose: 'baseline' },
    })
    const state = await ctx.tools.execute({
      signal, callId: CallId('c2'), name: 'orchestrator_state',
      arguments: { pipelineId: id },
    })
    expect(state.isError).toBe(false)
    expect(JSON.stringify(state.content)).toContain(`vcs baseline ${HEAD.slice(0, 12)}`)
  })
})

describe('adversarial-review tool fixes', () => {
  it('treats git stderr on success as a failed capture', async () => {
    const noisy: NativeCommandRunner = async (_command, args) => {
      if (args.includes('HEAD')) return { stdout: `${HEAD}\n`, stderr: '' }
      return { stdout: '', stderr: 'warning: could not open directory: File name too long' }
    }
    const { ctx } = await harness(noisy)
    const id = await pipeline(ctx, 'noisy')
    const result = await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_capture_vcs',
      arguments: { pipelineId: id, purpose: 'baseline' },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('emitted warnings')
  })

  it('captures a real SHA-1 repository baseline end to end', async () => {
    // Production execFile runner against the actual repo: a 40-hex head
    // must be accepted (regression for the sha256-only anchor bug).
    const { ctx } = await harness(runNativeCommand)
    const created = await ctx.orchestrator.create({
      name: 'real-git',
      // The suite runs from the repository root; capture samples this
      // actual work tree with the production execFile runner.
      projectRoot: process.cwd(),
      mode: 'LITE', riskClass: 'LOW', goalText: 'g',
    })
    const result = await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_capture_vcs',
      arguments: { pipelineId: created.row.id, purpose: 'baseline' },
    })
    expect(result.isError).toBe(false)
    const gotResult = ctx.orchestrator.get({ id: created.row.id })
    expect(gotResult.ok).toBe(true)
    const got = gotResult.ok ? gotResult.value : undefined
    expect(got?.vcsBaseline?.head).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
  })

  it('stage_report is atomic: a bad artifact kind persists nothing', async () => {
    const { ctx } = await harness(fakeGit())
    const id = await pipeline(ctx, 'atomic')
    const failed = await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_stage_report',
      arguments: {
        pipelineId: id, phase: 'S3', verdict: 'PASS',
        artifacts: [
          { name: 'a', kind: 'note', content: 'x' },
          { name: 'b', kind: 'bogus', content: 'y' },
        ],
      },
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toContain('artifacts[].kind')
    const s3row = ctx.orchestrator.get({ id })
    expect(s3row.ok).toBe(true)
    const s3 = (s3row.ok ? s3row.value.stages.find(stage => stage.phase === 'S3')! : undefined)!
    expect(s3.artifacts).toEqual([])
  })

  it('stage_report refuses sloppy block levels and empty fields', async () => {
    const { ctx } = await harness(fakeGit())
    const id = await pipeline(ctx, 'blocks')
    await ctx.orchestrator.freezeGoal(id, {})
    const bad = await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_stage_report',
      arguments: {
        pipelineId: id, phase: 'S3', verdict: 'BLOCK',
        blocks: [{ level: 'scoped', location: 'a:1', description: 'point fix' }],
      },
    })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toContain('blocks[].level')
    const missing = await ctx.tools.execute({
      signal, callId: CallId('c2'), name: 'orchestrator_stage_report',
      arguments: {
        pipelineId: id, phase: 'S3', verdict: 'BLOCK',
        blocks: [{ level: 'Critical', location: '', description: 'x' }],
      },
    })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('location')
  })

  it('anchors pipelines at the session header cwd, not the server cwd', async () => {
    const { ctx } = await harness(fakeGit())
    const session = Session.create(SessionId('tool-cwd-test'), [], {
      version: 0, id: SessionId('tool-cwd-test'), createdAt: 0, cwd: '/tmp/session-project',
    })
    const agent = { id: SessionId('tool-cwd-test'), options: {}, session, status: 'idle' } as never
    await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_start',
      arguments: { name: 'cwd-anchored', mode: 'LITE', riskClass: 'LOW', goal: 'g' },
      agent,
    })
    const listed = ctx.orchestrator.list({ projectRoot: '/tmp/session-project' })
    expect(listed.ok && listed.value.pipelines.length).toBe(1)
    expect(listed.ok && listed.value.pipelines[0]?.name).toBe('cwd-anchored')
  })

  it('disposes a started child when recordDispatch rejects and records failed settles on child faults', async () => {
    let disposed = 0
    const run = () => ({
      id: SessionId('run-1'),
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' as const, endedAt: Date.now() }),
      dispose: async () => { disposed += 1 },
    })
    const victimIdBox: { current: string | undefined } = { current: undefined }
    const repairIdBox: { current: string | undefined } = { current: undefined }
    const revoker: SubagentProvider = {
      name: 'revoker',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async () => {
        // Land a revoke ahead of the tool's enqueued recordDispatch.
        if (victimIdBox.current !== undefined && repairIdBox.current !== undefined) {
          await ctx.orchestrator.revoke(victimIdBox.current, repairIdBox.current)
        }
        return run()
      },
    }
    const { ctx } = await harness(fakeGit(), { subagentProvider: 'revoker' })
    ctx.subagents.registerProvider(revoker)
    const victim = await ctx.orchestrator.create({
      name: 'victim', projectRoot: '/tmp/leak', mode: 'FULL', riskClass: 'LOW', goalText: 'g',
    })
    const repair = await ctx.orchestrator.create({
      name: 'repair', projectRoot: '/tmp/leak', mode: 'FULL', riskClass: 'LOW', goalText: 'g',
    })
    const victimId = victim.row.id
    await ctx.orchestrator.freezeGoal(victimId, {})
    victimIdBox.current = victimId
    repairIdBox.current = repair.row.id
    const session = Session.create(SessionId('dispatch-agent'), [], {
      version: 0, id: SessionId('dispatch-agent'), createdAt: 0, cwd: '/tmp/leak',
    })
    const agent = { id: SessionId('dispatch-agent'), options: {}, session, status: 'idle' } as never
    const failed = await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_dispatch',
      arguments: { pipelineId: victimId, role: 'architect', prompt: 'p' },
      agent,
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toContain('REVOKED')
    expect(disposed).toBe(1)
    // Provider 2: run.result rejects on an infrastructure fault.
    let failedCount = 0
    const failingProvider: SubagentProvider = {
      name: 'failing',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('run-2'),
        localAgent: undefined,
        result: Promise.reject(new Error('infrastructure fault')),
        dispose: async () => { failedCount += 1 },
      }),
    }
    const { ctx: ctx2 } = await harness(fakeGit(), { subagentProvider: 'failing' })
    ctx2.subagents.registerProvider(failingProvider)
    const staged = await ctx2.orchestrator.create({
      name: 'child-fault', projectRoot: '/tmp/fault', mode: 'FULL', riskClass: 'LOW', goalText: 'g',
    })
    const sid = staged.row.id
    await ctx2.orchestrator.freezeGoal(sid, {})
    const session2 = Session.create(SessionId('dispatch-agent-2'), [], {
      version: 0, id: SessionId('dispatch-agent-2'), createdAt: 0, cwd: '/tmp/fault',
    })
    const agent2 = { id: SessionId('dispatch-agent-2'), options: {}, session: session2, status: 'idle' } as never
    const faulted = await ctx2.tools.execute({
      signal, callId: CallId('c2'), name: 'orchestrator_dispatch',
      arguments: { pipelineId: sid, role: 'architect', prompt: 'p' },
      agent: agent2,
    })
    expect(faulted.isError).toBe(true)
    const rowResult = ctx2.orchestrator.get({ id: sid })
    expect(rowResult.ok).toBe(true)
    const row = rowResult.ok ? rowResult.value : undefined
    const dispatch = row!.stages.find(stage => stage.phase === 'S1')!.dispatches[0]!
    expect(dispatch.settled).toBe(true)
    expect(dispatch.failed).toBe(true)
    expect(failedCount).toBe(1)
  })

  it('reports model-id ambiguity across providers instead of silently first-winning', async () => {
    const adapter = (): LlmAdapter => new class extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> { return }
      override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        return [{ provider, id: 'shared-model', name: 'shared-model' }]
      }
    }()
    const { ctx } = await harness(fakeGit())
    ctx.llm.registerConfigurableProviders([
      { provider: 'alpha', displayName: 'Alpha', settingsNs: 'llm-pi-ai', settingsPath: [] },
      { provider: 'beta', displayName: 'Beta', settingsNs: 'llm-pi-ai', settingsPath: [] },
    ])
    ctx.llm.registerAdapter(['alpha'], adapter())
    ctx.llm.registerAdapter(['beta'], adapter())
    const created = await ctx.orchestrator.create({
      name: 'ambiguous', projectRoot: '/tmp/amb', mode: 'FULL', riskClass: 'LOW', goalText: 'g',
    })
    const id = created.row.id
    await ctx.orchestrator.freezeGoal(id, {})
    const session3 = Session.create(SessionId('dispatch-agent-3'), [], {
      version: 0, id: SessionId('dispatch-agent-3'), createdAt: 0, cwd: '/tmp/amb',
    })
    const agent3 = { id: SessionId('dispatch-agent-3'), options: {}, session: session3, status: 'idle' } as never
    const result = await ctx.tools.execute({
      signal, callId: CallId('c1'), name: 'orchestrator_dispatch',
      arguments: { pipelineId: id, role: 'architect', prompt: 'p', model: 'shared-model' },
      agent: agent3,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('multiple providers')
  })
})
