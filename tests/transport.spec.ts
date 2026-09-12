import { describe, expect, it, vi } from 'vitest'
import { trimmedString, unwrapEnvelope, ZaiSignInError, zaiGet, zaiPost } from '../src/transport.ts'
import type { ZaiFetch, ZaiRequestContext } from '../src/transport.ts'

/** A request context answering every call with one canned response. */
function answering(response: Response | (() => Response)): ZaiRequestContext & { fetch: ZaiFetch } {
  const fetchImpl = vi.fn(() => Promise.resolve(typeof response === 'function' ? response() : response))
  return { fetch: fetchImpl, signal: new AbortController().signal }
}

/** One JSON response body. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('envelope unwrapping', () => {
  it('passes a body carrying no envelope straight through', () => {
    expect(unwrapEnvelope({ secretKey: 'plain' }, 'api key copy')).toEqual({ secretKey: 'plain' })
    expect(unwrapEnvelope(null, 'api key copy')).toBeNull()
    expect(unwrapEnvelope('text', 'api key copy')).toBe('text')
  })

  it('accepts both success codes in both spellings', () => {
    expect(unwrapEnvelope({ code: 0, data: 'token' }, 'token exchange')).toBe('token')
    expect(unwrapEnvelope({ code: 200, data: 'biz' }, 'customer lookup')).toBe('biz')
    expect(unwrapEnvelope({ code: '0', data: 'token' }, 'token exchange')).toBe('token')
    expect(unwrapEnvelope({ code: '200', data: 'biz' }, 'customer lookup')).toBe('biz')
  })

  it('accepts an envelope that reports success without a code', () => {
    expect(unwrapEnvelope({ success: true, data: 'ok' }, 'api key list')).toBe('ok')
    expect(unwrapEnvelope({ code: null, data: 'ok' }, 'api key list')).toBe('ok')
  })

  it('returns the envelope itself when it carries no data member', () => {
    expect(unwrapEnvelope({ code: 200, secretKey: 'inline' }, 'api key copy'))
      .toEqual({ code: 200, secretKey: 'inline' })
  })

  it('reports the service explanation when the envelope fails', () => {
    expect(() => unwrapEnvelope({ code: 401, msg: 'token expired' }, 'customer lookup'))
      .toThrow(/Z\.AI customer lookup failed: token expired/)
    expect(() => unwrapEnvelope({ success: false, msg: 'nope' }, 'api key create'))
      .toThrow(/Z\.AI api key create failed: nope/)
  })

  it('names the bare code when the envelope explains nothing', () => {
    const failures = [
      { code: 500 },
      { code: '500' },
      { code: true },
      { code: 500, msg: '' },
      { code: 500, msg: 7 },
    ]
    for (const body of failures) {
      expect(() => unwrapEnvelope(body, 'business login')).toThrow(ZaiSignInError)
    }
    expect(() => unwrapEnvelope({ code: 500 }, 'business login'))
      .toThrow(/Z\.AI business login failed: code 500/)
  })

  it('stamps ZAI_REJECTED on a refused envelope', () => {
    expect(() => unwrapEnvelope({ code: 403 }, 'api key list'))
      .toThrow(expect.objectContaining({ code: 'ZAI_REJECTED' }))
  })
})

describe('optional string members', () => {
  it('answers only for a non-blank string', () => {
    expect(trimmedString('  value ')).toBe('value')
    expect(trimmedString('   ')).toBeUndefined()
    expect(trimmedString(42)).toBeUndefined()
    expect(trimmedString(undefined)).toBeUndefined()
  })
})

describe('Z.AI requests', () => {
  it('reads an endpoint and unwraps what it answered', async () => {
    const context = answering(json({ code: 200, data: { secretKey: 'sk' } }))
    await expect(zaiGet('https://api.z.ai/keys', { Authorization: 'Bearer b' }, 'api key copy', context))
      .resolves.toEqual({ secretKey: 'sk' })
    expect(context.fetch).toHaveBeenCalledWith('https://api.z.ai/keys', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: 'Bearer b' },
    }))
  })

  it('posts a JSON body and unwraps what it answered', async () => {
    const context = answering(json({ code: 0, data: { zai: { access_token: 'at' } } }))
    await expect(zaiPost('https://zcode.z.ai/token', { code: 'c' }, {}, 'token exchange', context))
      .resolves.toEqual({ zai: { access_token: 'at' } })
    const [, init] = vi.mocked(context.fetch).mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(init.body).toBe('{"code":"c"}')
  })

  it('treats an empty body as no payload at all', async () => {
    const context = answering(new Response('', { status: 200 }))
    await expect(zaiGet('https://api.z.ai/keys', {}, 'api key list', context)).resolves.toBeUndefined()
  })

  it('names the endpoint and status when the request fails', async () => {
    const context = answering(() => new Response('denied', { status: 401 }))
    await expect(zaiGet('https://api.z.ai/keys', {}, 'api key list', context))
      .rejects.toThrow(/https:\/\/api\.z\.ai\/keys answered 401 denied/)
    await expect(zaiGet('https://api.z.ai/keys', {}, 'api key list', context))
      .rejects.toThrow(expect.objectContaining({ code: 'ZAI_HTTP' }))
  })

  it('carries the attempt cancellation into every request', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(false)
      controller.abort()
      expect(init.signal?.aborted).toBe(true)
      return Promise.resolve(json({ code: 200, data: 'ok' }))
    })
    await expect(zaiGet('https://api.z.ai/keys', {}, 'api key list', {
      fetch: fetchImpl,
      signal: controller.signal,
    })).resolves.toBe('ok')
  })
})
