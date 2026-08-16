/**
 * Orchestrator pipelines browser: one modal panel over the orchestrator Host
 * Remote — every pipeline for every project, grouped by lifecycle filter,
 * with per-stage detail, dispatch models, and clickable artifact bodies.
 * @module @deepseek-ai/dsh-client-ui-orchestrator/client/PipelinesPanel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Button, Modal, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  OrchestratorArtifactValue,
  OrchestratorLifecycle,
  OrchestratorPipelineRow,
  OrchestratorPipelineSummary,
  OrchestratorResult,
  OrchestratorStageStatus,
} from '@deepseek-ai/dsh-orchestrator/types'
import { NS } from './locales.ts'
import css from './PipelinesPanel.module.css'

/** Business union for one remote reply branch. */
type Business<T> = OrchestratorResult<T>

/** The three Remote calls this panel needs, as a structural face. */
export interface OrchestratorRemoteFace {
  list: (
    request: { projectRoot?: string },
  ) => Promise<RemoteResult<Business<{ readonly pipelines: readonly OrchestratorPipelineSummary[] }>>>
  get: (request: { id: string }) => Promise<RemoteResult<Business<OrchestratorPipelineRow>>>
  artifact: (
    request: { id: string; phase: string; name: string },
  ) => Promise<RemoteResult<Business<OrchestratorArtifactValue>>>
}

/** Lifecycle filter chips. */
type LifecycleFilter = 'all' | 'active' | 'sealed' | 'voided'

/** One artifact preview being viewed. */
interface ArtifactPreview {
  readonly phase: string
  readonly name: string
  readonly content: string
  readonly bytes: number
}

const FILTERS: readonly LifecycleFilter[] = ['all', 'active', 'sealed', 'voided']

function lifecycleBucket(lifecycle: OrchestratorLifecycle): Exclude<LifecycleFilter, 'all'> {
  if (lifecycle === 'ACTIVE') return 'active'
  if (lifecycle === 'SEALED') return 'sealed'
  return 'voided'
}

function lifecycleDot(lifecycle: OrchestratorLifecycle): StateDotState {
  if (lifecycle === 'ACTIVE') return 'ongoing'
  if (lifecycle === 'SEALED') return 'done'
  return 'warning'
}

function stageDot(status: OrchestratorStageStatus): StateDotState {
  if (status === 'DONE') return 'done'
  if (status === 'ACTIVE') return 'ongoing'
  if (status === 'BLOCKED') return 'error'
  return 'warning'
}

function basename(path: string): string {
  const parts = path.split('/').filter(part => part.length > 0)
  const last = parts.at(-1)
  return last === undefined ? path : last
}

/** Full props of the pipelines browser panel. */
export type PipelinesPanelProps = {
  readonly remote: OrchestratorRemoteFace
  readonly open: boolean
  readonly onClose: () => void
} & PropsLocale<typeof NS>

/**
 * The pipelines browser modal: filter chips and a list on the left, the
 * selected pipeline's stage timeline and artifact viewer on the right.
 * @param props - remote face, dialog state, and the namespace translator.
 * @returns the modal tree (null when closed).
 */
export function PipelinesPanel({ remote, open, onClose, t }: PipelinesPanelProps) {
  const [summaries, setSummaries] = useState<readonly OrchestratorPipelineSummary[]>([])
  const [filter, setFilter] = useState<LifecycleFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OrchestratorPipelineRow | null>(null)
  const [preview, setPreview] = useState<ArtifactPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const carrier = await remote.list({})
      if (!carrier.ok) throw new Error(carrier.error.message)
      const business = carrier.value
      if (!business.ok) throw new Error(business.error.message)
      setSummaries(business.value.pipelines)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [remote])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const select = useCallback(async (id: string) => {
    setSelectedId(id)
    setDetail(null)
    setPreview(null)
    try {
      const carrier = await remote.get({ id })
      if (!carrier.ok) throw new Error(carrier.error.message)
      const business = carrier.value
      if (!business.ok) throw new Error(business.error.message)
      setDetail(business.value)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [remote])

  const openArtifact = useCallback(async (id: string, phase: string, name: string) => {
    setPreview({ phase, name, content: '', bytes: 0 })
    try {
      const carrier = await remote.artifact({ id, phase, name })
      if (!carrier.ok) throw new Error(carrier.error.message)
      const business = carrier.value
      if (!business.ok) throw new Error(business.error.message)
      setPreview({ phase: business.value.phase, name: business.value.name, content: business.value.content, bytes: business.value.bytes })
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [remote])

  const visible = useMemo(() => summaries.filter(summary =>
    filter === 'all' || lifecycleBucket(summary.lifecycle) === filter), [summaries, filter])

  const counts = useMemo(() => {
    const acc: Record<LifecycleFilter, number> = { all: summaries.length, active: 0, sealed: 0, voided: 0 }
    for (const summary of summaries) acc[lifecycleBucket(summary.lifecycle)] += 1
    return acc
  }, [summaries])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('title')}
      closeLabel={t('close')}
      description={t('subtitle')}
      className={css.modal ?? ''}
      contentClassName={css.content ?? ''}
    >
      <div className={css.toolbar}>
        <div className={css.chips}>
          {FILTERS.map(candidate => (
            <button
              key={candidate}
              type="button"
              className={candidate === filter ? css.chipActive : css.chip}
              onClick={() => { setFilter(candidate) }}
            >
              {t(`filter.${candidate}`)} ({counts[candidate]})
            </button>
          ))}
        </div>
        <Button variant="ghost" onClick={() => { void refresh() }} disabled={busy}>{t('refresh')}</Button>
      </div>
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      <div className={css.columns}>
        <div className={css.list} role="list">
          {visible.length === 0 && <div className={css.empty}>{t('empty')}</div>}
          {visible.map(summary => (
            <button
              key={summary.id}
              type="button"
              role="listitem"
              className={summary.id === selectedId ? css.rowSelected : css.row}
              onClick={() => { void select(summary.id) }}
            >
              <StateDot state={lifecycleDot(summary.lifecycle)} />
              <span className={css.rowName}>{summary.name}</span>
              <span className={css.rowMeta}>
                {summary.lifecycle}/{summary.currentPhase} · {summary.mode} · {basename(summary.projectRoot)}
              </span>
              <span className={css.rowTime}>{new Date(summary.updatedAt).toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className={css.detail}>
          {detail === null
            ? <div className={css.empty}>{selectedId === null ? t('hint.select') : t('hint.loading')}</div>
            : (
              <div className={css.detailInner}>
                <div className={css.detailHeader}>
                  <StateDot state={lifecycleDot(detail.lifecycle)} />
                  <strong>{detail.name}</strong>
                  <span className={css.rowMeta}>
                    {detail.lifecycle}/{detail.currentPhase} · {detail.mode} · {detail.riskClass}
                  </span>
                </div>
                <div className={css.goalHash}>
                  {t('goalHash')}: {detail.goal.sha256 === undefined ? t('goal.unfrozen') : detail.goal.sha256.slice(0, 16) + '…'}
                </div>
                <div className={css.goalHash}>
                  {t('vcsBaseline')}: {detail.vcsBaseline === undefined ? t('vcs.none') : detail.vcsBaseline.head.slice(0, 12) + '…'}
                  {' · '}
                  {t('vcsCandidate')}: {detail.candidate?.vcs === undefined ? t('vcs.none') : detail.candidate.vcs.head.slice(0, 12) + '…'}
                </div>
                <div className={css.stages}>
                  {detail.stages.map(stage => (
                    <div key={stage.phase} className={css.stage}>
                      <StateDot state={stageDot(stage.status)} />
                      <span className={css.stagePhase}>{stage.phase}</span>
                      <span className={css.stageStatus}>{stage.status}{stage.verdict === undefined ? '' : ` · ${stage.verdict}`}</span>
                      {stage.attempts > 0 && <span className={css.stageMeta}>{t('attempts', { attempts: stage.attempts })}</span>}
                      {stage.dispatches.length > 0 && (
                        <span className={css.stageMeta}>
                          {stage.dispatches.map(dispatch => `${dispatch.role}(${dispatch.model ?? 'default'}${dispatch.failed ? ' ✗' : dispatch.settled ? '' : ' …'})`).join(', ')}
                        </span>
                      )}
                      {stage.artifacts.length > 0 && (
                        <span className={css.artifacts}>
                          {stage.artifacts.map(artifact => (
                            <button
                              key={artifact.name}
                              type="button"
                              className={preview !== null
                                && preview.phase === stage.phase
                                && preview.name === artifact.name
                                ? css.artifactActive
                                : css.artifact}
                              onClick={() => { void openArtifact(detail.id, stage.phase, artifact.name) }}
                            >
                              {artifact.name} · {artifact.kind}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                <div className={css.metaLine}>
                  {t('candidate')}: {detail.candidate === undefined ? t('candidate.none') : detail.candidate.subjectHash.slice(0, 16) + '…'}
                  {' · '}
                  {t('approvals')}: {detail.approvals.length === 0 ? t('none') : detail.approvals.map(approval => approval.phase).join(', ')}
                  {' · '}
                  {t('concessions')}: {detail.concessions.length === 0 ? t('none') : String(detail.concessions.length)}
                </div>
                {preview !== null && (
                  <div className={css.viewer}>
                    <div className={css.viewerHeader}>
                      {preview.phase} / {preview.name} · {preview.bytes}B
                    </div>
                    <pre className={css.viewerBody}>{preview.content === '' ? t('hint.loading') : preview.content}</pre>
                  </div>
                )}
              </div>
            )}
        </div>
      </div>
    </Modal>
  )
}

void (NS satisfies string)
