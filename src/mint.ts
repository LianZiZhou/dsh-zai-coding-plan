/**
 * Provisioning of the durable Z.AI key a GLM Coding Plan sign-in ends in.
 *
 * The OAuth token the browser conversation produces is short-lived and the
 * inference endpoint does not accept it, so signing in is only half the job:
 * the account's own key is then minted through Z.AI's business API and that is
 * what the route stores. The key is named rather than anonymous so it can be
 * found again on the next sign-in and revoked by name in the Z.AI console
 * without disturbing a key another client made.
 *
 * @module dsh-zai-coding-plan/mint
 */

import { trimmedString, ZaiSignInError, zaiGet, zaiPost } from './transport.js'
import type { ZaiRequestContext } from './transport.js'

/** Root of Z.AI's business API, which owns accounts, projects, and keys. */
const BUSINESS_BASE = 'https://api.z.ai'

/** Exchanges the OAuth access token for the token the business API accepts. */
const BUSINESS_LOGIN_URL = `${BUSINESS_BASE}/api/auth/z/login`

/**
 * The name this plugin gives the key it mints. Distinct per client by
 * convention: a shared name would mean one client's revocation logging another
 * out, and the Z.AI console lists keys by exactly this string.
 */
export const KEY_NAME = 'deepseek-harness'

/** One project on a Z.AI organization, as `getCustomerInfo` reports it. */
interface ZaiProject {
  projectId?: unknown
  isDefault?: unknown
}

/** One organization on a Z.AI account, as `getCustomerInfo` reports it. */
interface ZaiOrganization {
  organizationId?: unknown
  isDefault?: unknown
  projects?: ZaiProject[]
}

/**
 * Exchange the OAuth access token for a business-API token.
 *
 * The business endpoints reject the OAuth token itself, so this is the step
 * that makes every later call in this module possible.
 * @param oauthAccessToken - the short-lived token the code exchange produced.
 * @param context - the fetch implementation and the attempt's cancellation signal.
 * @returns the business token to authorize the remaining calls with.
 * @throws {ZaiSignInError} code `ZAI_NO_BUSINESS_TOKEN` when the reply carries none.
 */
async function businessLogin(oauthAccessToken: string, context: ZaiRequestContext): Promise<string> {
  const data = await zaiPost(
    BUSINESS_LOGIN_URL, { token: oauthAccessToken }, {}, 'business login', context,
  ) as { access_token?: unknown; accessToken?: unknown } | undefined
  const token = trimmedString(data?.access_token) ?? trimmedString(data?.accessToken)
  if (token === undefined) {
    throw new ZaiSignInError('Z.AI business login returned no access token', 'ZAI_NO_BUSINESS_TOKEN')
  }
  return token
}

/**
 * The organization and project new keys are created under.
 *
 * An account can hold several of each; the one marked default is the one the
 * Z.AI console itself works in, and the first is the only honest fallback when
 * nothing is marked.
 * @param context - the fetch implementation and the attempt's cancellation signal.
 * @param headers - the business-token authorization header.
 * @returns the organization and project ids.
 * @throws {ZaiSignInError} code `ZAI_NO_PROJECT` when the account has neither.
 */
async function defaultProject(
  headers: Readonly<Record<string, string>>,
  context: ZaiRequestContext,
): Promise<{ organizationId: string; projectId: string }> {
  const customer = await zaiGet(
    `${BUSINESS_BASE}/api/biz/customer/getCustomerInfo`, headers, 'customer lookup', context,
  ) as { organizations?: ZaiOrganization[] } | undefined
  const organizations = Array.isArray(customer?.organizations) ? customer.organizations : []
  const organization = organizations.find(entry => entry.isDefault === true) ?? organizations[0]
  const projects = Array.isArray(organization?.projects) ? organization.projects : []
  const project = projects.find(entry => entry.isDefault === true) ?? projects[0]
  const organizationId = trimmedString(organization?.organizationId)
  const projectId = trimmedString(project?.projectId)
  if (organizationId === undefined || projectId === undefined) {
    throw new ZaiSignInError(
      'Z.AI key provisioning failed: the signed-in account has no organization and project to create a key in',
      'ZAI_NO_PROJECT',
    )
  }
  return { organizationId, projectId }
}

/**
 * The key list as an array, whichever shape the endpoint wrapped it in.
 * @param value - the unwrapped list payload.
 * @returns the key records, or an empty array when the payload holds none.
 */
function asKeyList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  for (const field of ['list', 'keys', 'apiKeys', 'records']) {
    const candidate = record[field]
    if (Array.isArray(candidate)) return candidate as Array<Record<string, unknown>>
  }
  return []
}

/**
 * Mint — or recover — this harness's durable Z.AI key.
 *
 * Signing in twice reuses the key made the first time rather than filling the
 * account with one key per sign-in. The secret is always read back through the
 * copy endpoint: the list masks it, and the create reply carries it only for
 * some account states, so the copy endpoint is the one source that answers in
 * both cases.
 * @param oauthAccessToken - the short-lived token the code exchange produced.
 * @param context - the fetch implementation and the attempt's cancellation signal.
 * @returns the durable `id.secret` key the inference endpoint authenticates.
 * @throws {ZaiSignInError} code `ZAI_NO_KEY` or `ZAI_NO_SECRET` when provisioning
 *   answers without the half it was asked for.
 */
export async function mintCodingPlanKey(oauthAccessToken: string, context: ZaiRequestContext): Promise<string> {
  const headers = { Authorization: `Bearer ${await businessLogin(oauthAccessToken, context)}` }
  const { organizationId, projectId } = await defaultProject(headers, context)
  const keysUrl = `${BUSINESS_BASE}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`

  const existing = asKeyList(await zaiGet(keysUrl, headers, 'api key list', context))
    .find(entry => entry.name === KEY_NAME)
  const minted = existing ?? await zaiPost(keysUrl, { name: KEY_NAME }, headers, 'api key create', context) as
    Record<string, unknown> | undefined
  const apiKey = trimmedString(minted?.apiKey)
  if (apiKey === undefined) {
    throw new ZaiSignInError(`Z.AI created no key named "${KEY_NAME}"`, 'ZAI_NO_KEY')
  }

  const copied = await zaiGet(
    `${keysUrl}/copy/${encodeURIComponent(apiKey)}`, headers, 'api key copy', context,
  ) as { secretKey?: unknown } | undefined
  const secretKey = trimmedString(copied?.secretKey)
  if (secretKey === undefined) {
    throw new ZaiSignInError(`Z.AI returned no secret for the key named "${KEY_NAME}"`, 'ZAI_NO_SECRET')
  }
  return `${apiKey}.${secretKey}`
}
