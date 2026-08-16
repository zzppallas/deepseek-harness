/**
 * The sidebar-footer trigger for the orchestrator pipelines browser.
 * @module @deepseek-ai/dsh-client-ui-orchestrator/client/OrchestratorFooterAction
 */

import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PipelinesPanel, type OrchestratorRemoteFace } from './PipelinesPanel.tsx'

/** Full props of the footer trigger row: slot runtime + inject + locale. */
export type OrchestratorFooterActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & { readonly remote: OrchestratorRemoteFace }
  & PropsLocale<'orchestratorPipelines'>

/**
 * The sidebar-footer trigger: one row that opens the pipelines browser modal.
 * @param props - footer slot currency, the Remote face, and the translator.
 * @returns the trigger row with its modal.
 */
export function OrchestratorFooterAction({ remote, t }: OrchestratorFooterActionProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true) }}
        title={t('open.wide')}
      >
        {t('open')}
      </button>
      <PipelinesPanel
        remote={remote}
        open={open}
        onClose={() => { setOpen(false) }}
        t={t}
      />
    </>
  )
}
