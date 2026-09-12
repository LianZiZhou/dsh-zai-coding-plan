/**
 * The JSON transport every Z.AI request goes through, and the envelope its
 * endpoints answer in.
 *
 * Z.AI wraps most replies in `{ code, msg, data, success }` and signals success
 * with two different codes depending on which service answered, so unwrapping
 * is a shared step rather than something each call open-codes. The failing
 * envelope is the only place the service explains itself, which is why its
 * `msg` reaches the human instead of a generic transport failure.
 *
 * @module dsh-zai-coding-plan/transport
 */

/** Per-request bound on one Z.AI call; a sign-in that stalls here is not one a human should wait on. */
export const REQUEST_TIMEOUT_MS = 30_000

/** The fetch implementation one sign-in runs on; injectable so tests answer without a network. */
export type ZaiFetch = (url: string, init: RequestInit) => Promise<Response>

/** What one Z.AI request needs beyond its own url and body. */
export interface ZaiRequestContext {
  /** The fetch implementation to call. */
  readonly fetch: ZaiFetch
  /** Withdraws the request with the command that owns it. */
  readonly signal: AbortSignal
}

/** Stable error taxonomy for a Z.AI sign-in that could not produce a key. */
export class ZaiSignInError extends Error {
  /** Stable machine-routable failure class; route on this, never by parsing `message`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ZaiSignInError'
    this.code = code
  }
}

/**
 * Whether an envelope's status code reports success.
 *
 * The OAuth token endpoint answers `0` and the business endpoints answer `200`,
 * both as a number or as its decimal string, so both spellings of both codes
 * are accepted. A body carrying no code at all is not an envelope and is
 * therefore not a failure.
 * @param code - the envelope's `code` member, in whatever type it arrived as.
 * @returns whether the call succeeded.
 */
function isSuccessCode(code: unknown): boolean {
  if (code === null || code === undefined) return true
  if (typeof code === 'number') return code === 0 || code === 200
  if (typeof code === 'string') return code === '0' || code === '200'
  return false
}

/**
 * Take the payload out of one Z.AI envelope.
 * @param body - the parsed response body.
 * @param operation - what was being attempted, named in the failure.
 * @returns the envelope's `data`, or the body itself when it carries no envelope.
 * @throws {ZaiSignInError} code `ZAI_REJECTED` when the envelope reports failure.
 */
export function unwrapEnvelope(body: unknown, operation: string): unknown {
  if (typeof body !== 'object' || body === null || !('code' in body || 'success' in body)) return body
  const envelope = body as { code?: unknown; msg?: unknown; data?: unknown; success?: unknown }
  if (envelope.success === false || !isSuccessCode(envelope.code)) {
    const explanation = typeof envelope.msg === 'string' && envelope.msg.length > 0
      ? envelope.msg
      : `code ${String(envelope.code)}`
    throw new ZaiSignInError(`Z.AI ${operation} failed: ${explanation}`, 'ZAI_REJECTED')
  }
  return 'data' in envelope ? envelope.data : envelope
}

/**
 * The trimmed string one envelope member holds, when it holds one at all.
 * @param value - the member as it arrived.
 * @returns the trimmed value, or undefined when it is absent or blank.
 */
export function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Run one Z.AI request and parse its body.
 * @param url - the endpoint to call.
 * @param init - method, headers, and body; the signal is supplied here.
 * @param operation - what is being attempted, named in a failure.
 * @param context - the fetch implementation and the command's cancellation signal.
 * @returns the parsed body, or undefined for an empty response.
 * @throws {ZaiSignInError} code `ZAI_HTTP` when the endpoint answers a failure status.
 */
async function request(
  url: string,
  init: RequestInit,
  operation: string,
  context: ZaiRequestContext,
): Promise<unknown> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  const response = await context.fetch(url, { ...init, signal })
  const body = await response.text()
  if (!response.ok) {
    throw new ZaiSignInError(`Z.AI ${operation} failed: ${url} answered ${response.status} ${body}`, 'ZAI_HTTP')
  }
  return body.length > 0 ? JSON.parse(body) : undefined
}

/**
 * Read one Z.AI endpoint and unwrap its envelope.
 * @param url - the endpoint to read.
 * @param headers - request headers, carrying the bearer token when there is one.
 * @param operation - what is being attempted, named in a failure.
 * @param context - the fetch implementation and the command's cancellation signal.
 * @returns the envelope's payload.
 */
export async function zaiGet(
  url: string,
  headers: Readonly<Record<string, string>>,
  operation: string,
  context: ZaiRequestContext,
): Promise<unknown> {
  return unwrapEnvelope(await request(url, { method: 'GET', headers: { ...headers } }, operation, context), operation)
}

/**
 * Post one JSON body to a Z.AI endpoint and unwrap its envelope.
 * @param url - the endpoint to post to.
 * @param body - the JSON body to send.
 * @param headers - request headers, carrying the bearer token when there is one.
 * @param operation - what is being attempted, named in a failure.
 * @param context - the fetch implementation and the command's cancellation signal.
 * @returns the envelope's payload.
 */
export async function zaiPost(
  url: string,
  body: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
  operation: string,
  context: ZaiRequestContext,
): Promise<unknown> {
  const init: RequestInit = {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
  return unwrapEnvelope(await request(url, init, operation, context), operation)
}
