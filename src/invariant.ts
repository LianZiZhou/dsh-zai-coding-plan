/**
 * Package-owned invariant companion for `dsh-zai-coding-plan`.
 * @module dsh-zai-coding-plan/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-zai-coding-plan'

/** Cordis companion plugin name. */
export const name = 'zai-coding-plan-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no durable event stream or mutable
 * runtime data; the key it mints is committed by the credential seam and the
 * route by the settings seam, each of which checks its own writes.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
