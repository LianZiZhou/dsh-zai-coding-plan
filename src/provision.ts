/**
 * What a finished sign-in leaves behind: a stored key and a route that uses it.
 *
 * The key alone changes nothing a human can see. The pi-ai adapter mounts
 * dormant and registers only the provider routes its settings section declares,
 * so a sign-in that stopped at the credential would leave the Models page and
 * the model picker exactly as they were. Both halves are written here, through
 * the two seams' public reference APIs — this plugin owns neither the adapter's
 * settings section nor the credential store, so it addresses them the way any
 * configuration surface does.
 *
 * @module dsh-zai-coding-plan/provision
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type Credentials from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type Settings from '@deepseek-ai/dsh-settings'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'

/** The pi-ai settings section, whose `providers` dict is the route set. */
const PI_AI_NS = settingsNamespace('llm-pi-ai')

/** The pi-ai route this sign-in configures by default; its models and endpoint are pi-ai's own. */
export const ROUTE = 'zai'

/** The reference the stored key is addressed by, and the one the route resolves. */
export const DEFAULT_CREDENTIAL_REF = 'ZAI_API_KEY'

/** The seams a completed sign-in writes through. */
export interface ProvisionTarget {
  /** The credential store, when the composition mounts one. */
  readonly credentials?: Credentials | undefined
  /** The settings provider, when the composition mounts one. */
  readonly settings?: Settings | undefined
}

/** What one provisioning pass changed, so the caller can say so. */
export interface ProvisionResult {
  /** The reference the key was stored under. */
  readonly ref: string
  /** Whether this pass declared the route, rather than finding it already declared. */
  readonly routeDeclared: boolean
}

/** A provisioning step that could not complete, named so the human can act on it. */
export class ProvisionError extends Error {
  /** Stable machine-routable failure class. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProvisionError'
    this.code = code
  }
}

/** The pi-ai section as the route declaration reads it. */
interface PiAiSection {
  providers?: Record<string, unknown>
}

/**
 * Store the minted key and make the route that uses it exist.
 *
 * The credential is written as a *reference* rather than as a provider record:
 * a reference is the address the adapter's own `apiKeyEnv` resolves per
 * request, and it is the one credential address a plugin outside the adapter
 * may write. The route profile therefore names that reference, which is exactly
 * what the Models page writes when a human types a key by hand.
 *
 * A route someone already configured is left alone — it may carry an endpoint,
 * a narrowed model list, or a different reference that this sign-in has no
 * business rewriting — so signing in again refreshes only the key.
 * @param key - the durable `id.secret` key the sign-in minted.
 * @param target - the credential and settings seams, either of which may be absent.
 * @param ref - the reference name to store under.
 * @param route - the pi-ai route to declare.
 * @returns what this pass changed.
 * @throws {ProvisionError} when a required seam is absent or refuses the write.
 */
export async function provisionRoute(
  key: string,
  target: ProvisionTarget,
  ref: string = DEFAULT_CREDENTIAL_REF,
  route: string = ROUTE,
): Promise<ProvisionResult> {
  const { credentials, settings } = target
  if (credentials === undefined) {
    throw new ProvisionError(
      'this deployment mounts no credential store, so there is nowhere to keep the key this sign-in minted'
      + ' (mount @deepseek-ai/dsh-credentials-local)',
      'NO_CREDENTIAL_STORE',
    )
  }
  try {
    await credentials.set(credentialRef(ref), key)
  } catch (error: unknown) {
    throw new ProvisionError(`storing the Z.AI key under ${ref} failed: ${messageOf(error)}`, 'CREDENTIAL_REFUSED', {
      cause: error,
    })
  }
  if (settings === undefined) {
    throw new ProvisionError(
      `the Z.AI key is stored as ${ref}, but this deployment mounts no settings provider, so the ${route} route`
      + ' cannot be declared; add the provider on the Models page to use it',
      'NO_SETTINGS_PROVIDER',
    )
  }
  const section = settings.describe().find((descriptor: SettingsDescriptor) => descriptor.ns === PI_AI_NS)?.value as
    PiAiSection | undefined
  if (section?.providers?.[route] !== undefined) return { ref, routeDeclared: false }
  try {
    await settings.mutate(PI_AI_NS, [{ op: 'set', path: ['providers', route], value: { apiKeyEnv: ref } }])
  } catch (error: unknown) {
    throw new ProvisionError(
      `the Z.AI key is stored as ${ref}, but declaring the ${route} route failed: ${messageOf(error)};`
      + ' add the provider on the Models page to use it',
      'SETTINGS_REFUSED',
      { cause: error },
    )
  }
  return { ref, routeDeclared: true }
}

/**
 * Whether this deployment already has a usable Z.AI sign-in.
 * @param target - the credential and settings seams, either of which may be absent.
 * @param ref - the reference name the route would resolve.
 * @param route - the pi-ai route the sign-in configures.
 * @returns whether the key is stored and whether the route is declared.
 */
export async function provisionState(
  target: ProvisionTarget,
  ref: string = DEFAULT_CREDENTIAL_REF,
  route: string = ROUTE,
): Promise<{ keyStored: boolean; routeDeclared: boolean }> {
  const stored = target.credentials === undefined
    ? false
    : (await target.credentials.describe(credentialRef(ref))).configured
  const section = target.settings?.describe()
    .find((descriptor: SettingsDescriptor) => descriptor.ns === PI_AI_NS)?.value as
    PiAiSection | undefined
  return { keyStored: stored, routeDeclared: section?.providers?.[route] !== undefined }
}

/** Read one refusal's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
