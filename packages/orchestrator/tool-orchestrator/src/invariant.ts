/** Package-owned invariant companion. @module @deepseek-ai/dsh-tool-orchestrator/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-orchestrator'

/** Cordis companion plugin name. */
export const name = 'tool-orchestrator-invariant'
/** Services required before the companion can reserve and check package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tools are stateless policies over the
 * dsh-orchestrator sidecar service, which owns every row mutation.
 */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['tools'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
