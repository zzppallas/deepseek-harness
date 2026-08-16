/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-orchestrator/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-orchestrator'

/** Cordis companion plugin name. */
export const name = 'ui-orchestrator-invariant'
/** Services required before the companion can reserve and check package ownership. */
export const inject = ['invariants']

/** No runtime invariant: a pure presentation plugin over the orchestrator Remote. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['remote'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
