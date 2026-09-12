/**
 * The GLM Coding Plan browser sign-in, from the authorize page to the durable
 * key the route stores.
 *
 * The conversation is Z.AI's own desktop flow: an authorization-code request
 * against `chat.z.ai` with no PKCE, a token exchange whose body is not the
 * OAuth-standard one, and a key-provisioning sequence afterwards. None of the
 * three is a published API, so every field this module sends is the one Z.AI's
 * own client sends — including the redirect, which is why the code comes back
 * through the human rather than through a local listener.
 *
 * @module dsh-zai-coding-plan/oauth
 */

import { randomUUID } from 'node:crypto'
import { mintCodingPlanKey } from './mint.js'
import { trimmedString, ZaiSignInError, zaiPost } from './transport.js'
import type { ZaiFetch, ZaiRequestContext } from './transport.js'

/** Z.AI's own desktop client id; the authorize page rejects any other. */
const CLIENT_ID = 'client_P8X5CMWmlaRO9gyO-KSqtg'

/** The page the human signs in on. */
const AUTHORIZE_URL = 'https://chat.z.ai/api/oauth/authorize'

/** The endpoint that turns an authorization code into an OAuth access token. */
const TOKEN_URL = 'https://zcode.z.ai/api/v1/oauth/token'

/**
 * Where Z.AI sends the browser afterwards.
 *
 * Z.AI validates this against a server-side allowlist registered for the client
 * id above, and that allowlist admits only its own desktop scheme: every
 * loopback address is refused at the authorize page with `Redirect URI not
 * registered for this client`, before the human can do anything about it. A
 * `zcode://` address is one no browser hands back to this process, so the code
 * returns the one way that always works — the human copies the address their
 * browser ended on. {@link ZaiSignInOptions.redirectUri} exists because this
 * allowlist has already moved once.
 */
export const REDIRECT_URI = 'zcode://zai-auth/callback'

/** What a caller may replace; production supplies none of it. */
export interface ZaiSignInOptions {
  /** The fetch implementation every Z.AI call runs on. */
  readonly fetch?: ZaiFetch
  /** The redirect to ask Z.AI for, when their allowlist has moved again. */
  readonly redirectUri?: string
}

/** An authorization code and the state it came back with. */
interface AuthorizationAnswer {
  code?: string
  state?: string
}

/** How one sign-in talks to the human. */
export interface ZaiSignInConversation {
  /** The address to open, and the answer it eventually produces. */
  ask(request: { readonly url: string; readonly redirectUri: string }): Promise<string>
  /** Withdraws the whole sign-in. */
  readonly signal: AbortSignal
}

/**
 * The authorization answer one query string carries.
 * @param params - the parsed query.
 * @returns its code and state, either of which may be absent.
 */
function fromQuery(params: URLSearchParams): AuthorizationAnswer {
  const code = params.get('code')
  const state = params.get('state')
  return {
    ...code === null ? {} : { code },
    ...state === null ? {} : { state },
  }
}

/**
 * Read an authorization answer out of whatever the human pasted.
 *
 * What lands in the box is the whole redirect as often as it is the code alone
 * — a browser that cannot open `zcode://` shows the address, one that can hands
 * it to ZCode and leaves the human copying it from elsewhere. All four
 * spellings Z.AI's redirect can be reduced to are accepted, because asking
 * again for a differently-shaped copy of the same value is not a question
 * anyone can act on.
 * @param input - the pasted text.
 * @returns the code and state it carried, either of which may be absent.
 */
export function parseAuthorizationAnswer(input: string): AuthorizationAnswer {
  const value = input.trim()
  if (value.length === 0) return {}
  if (URL.canParse(value)) return fromQuery(new URL(value).searchParams)
  const separator = value.indexOf('#')
  if (separator >= 0) return { code: value.slice(0, separator), state: value.slice(separator + 1) }
  if (value.includes('code=')) return fromQuery(new URLSearchParams(value))
  return { code: value }
}

/**
 * The page to send the human to.
 * @param state - the value this attempt expects echoed back.
 * @param redirectUri - the address the browser is redirected to afterwards.
 * @returns the authorize URL.
 */
function authorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    response_type: 'code',
    client_id: CLIENT_ID,
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

/**
 * Exchange the authorization code for the OAuth access token.
 *
 * The body carries neither `grant_type` nor a code verifier: this endpoint is
 * Z.AI's, not a standard OAuth token endpoint, and it refuses the standard
 * shape.
 * @param answer - the code and the redirect it was issued against.
 * @param context - the fetch implementation and the command's cancellation signal.
 * @returns the short-lived access token.
 * @throws {ZaiSignInError} code `ZAI_NO_ACCESS_TOKEN` when the reply carries none.
 */
async function exchangeCode(
  answer: { code: string; state: string; redirectUri: string },
  context: ZaiRequestContext,
): Promise<string> {
  const body = {
    provider: 'zai',
    code: answer.code,
    redirect_uri: answer.redirectUri,
    state: answer.state,
  }
  const data = await zaiPost(TOKEN_URL, body, {}, 'token exchange', context) as
    { zai?: { access_token?: unknown } } | undefined
  const accessToken = trimmedString(data?.zai?.access_token)
  if (accessToken === undefined) {
    throw new ZaiSignInError('Z.AI token exchange returned no access token', 'ZAI_NO_ACCESS_TOKEN')
  }
  return accessToken
}

/**
 * Run one GLM Coding Plan sign-in.
 *
 * @param conversation - how to put the authorize page to the human and read their answer.
 * @param options - replacements for the fetch implementation and the redirect.
 * @returns the durable `id.secret` key the inference endpoint authenticates.
 * @throws {ZaiSignInError} code `ZAI_NO_CODE` when no authorization code arrived,
 *   or `ZAI_STATE_MISMATCH` when the answer belongs to a different attempt.
 */
export async function runZaiSignIn(
  conversation: ZaiSignInConversation,
  options: ZaiSignInOptions = {},
): Promise<string> {
  const context: ZaiRequestContext = { fetch: options.fetch ?? fetch, signal: conversation.signal }
  const state = randomUUID()
  const redirectUri = options.redirectUri ?? REDIRECT_URI
  const answer = parseAuthorizationAnswer(await conversation.ask({
    url: authorizeUrl(state, redirectUri),
    redirectUri,
  }))
  if (answer.code === undefined || answer.code.length === 0) {
    throw new ZaiSignInError('Z.AI sign-in produced no authorization code', 'ZAI_NO_CODE')
  }
  if (answer.state !== undefined && answer.state !== state) {
    throw new ZaiSignInError('Z.AI returned an authorization code for a different sign-in attempt', 'ZAI_STATE_MISMATCH')
  }
  const accessToken = await exchangeCode({ code: answer.code, state, redirectUri }, context)
  return mintCodingPlanKey(accessToken, context)
}
