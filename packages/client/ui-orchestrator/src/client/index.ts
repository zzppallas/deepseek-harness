/**
 * Browser plugin for the orchestrator pipelines surface: one sidebar-footer
 * action that opens the pipelines browser modal, fed entirely by the
 * orchestrator Host Remote.
 * @module @deepseek-ai/dsh-client-ui-orchestrator/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-sidebar's SlotMap merge (sidebar.footer.action) in.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { OrchestratorFooterAction } from './OrchestratorFooterAction.tsx'
import type { OrchestratorRemoteFace } from './PipelinesPanel.tsx'
import { en, NS, zh, type OrchestratorPipelinesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Orchestrator pipelines browser copy. */
    [NS]: OrchestratorPipelinesKey
  }
}

/** Required services: the slot registry, the Remote namespace, and the copy. */
export const inject = ['slots', 'remote', 'remote.orchestrator', 'locale']

/**
 * Client plugin body: register the dictionaries and the footer action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-orchestrator: dictionaries')
  ctx.slots.inject(
    'sidebar.footer.action',
    () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'orchestrator-pipelines',
      // After the settings trigger: process-wide work reads last.
      order: 20,
      locale: NS,
      inject: (): { remote: OrchestratorRemoteFace } => ({
        remote: ctx.remote.orchestrator as unknown as OrchestratorRemoteFace,
      }),
    }, OrchestratorFooterAction),
  )
}
