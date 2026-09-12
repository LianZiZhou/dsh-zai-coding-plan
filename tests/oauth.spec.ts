import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAuthorizationAnswer, REDIRECT_URI, runZaiSignIn } from '../src/oauth.ts'
import type { ZaiSignInConversation } from '../src/oauth.ts'
import { mintReplies, routed, TOKEN } from './fake-zai.ts'
import type { Replies } from './fake-zai.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** The replies of a sign-in that ends in `existing-key.secret`. */
function signInReplies(extra: Replies = {}): Replies {
  return mintReplies({
    [`POST ${TOKEN}`]: { code: 0, data: { zai: { access_token: 'oauth-token' } } },
    ...extra,
  })
}

/** A conversation that answers with `answer` and records what it was asked. */
function conversation(answer: (url: string) => string): ZaiSignInConversation & {
  asked: { url: string; redirectUri: string }[]
} {
  const asked: { url: string; redirectUri: string }[] = []
  return {
    asked,
    signal: new AbortController().signal,
    ask(request) {
      asked.push({ url: request.url, redirectUri: request.redirectUri })
      return Promise.resolve(answer(request.url))
    },
  }
}

/** One search parameter of the authorize page the sign-in produced. */
function param(url: string, name: string): string {
  return new URL(url).searchParams.get(name) as string
}

describe('reading an authorization answer', () => {
  it('reads the whole redirect address', () => {
    expect(parseAuthorizationAnswer(' zcode://zai-auth/callback?code=a&state=b '))
      .toEqual({ code: 'a', state: 'b' })
    expect(parseAuthorizationAnswer('zcode://zai-auth/callback')).toEqual({})
  })

  it('reads the code-and-state pair Z.AI shows for a manual copy', () => {
    expect(parseAuthorizationAnswer('a#b')).toEqual({ code: 'a', state: 'b' })
  })

  it('reads a bare query string', () => {
    expect(parseAuthorizationAnswer('code=a&state=b')).toEqual({ code: 'a', state: 'b' })
    expect(parseAuthorizationAnswer('code=a')).toEqual({ code: 'a' })
  })

  it('takes anything else as the code itself', () => {
    expect(parseAuthorizationAnswer('bare-code')).toEqual({ code: 'bare-code' })
    expect(parseAuthorizationAnswer('   ')).toEqual({})
  })
})

describe('the GLM Coding Plan sign-in', () => {
  it('asks Z.AI for the one redirect their allowlist still accepts', async () => {
    const context = routed(signInReplies())
    const talk = conversation(url => `${REDIRECT_URI}?code=code-1&state=${param(url, 'state')}`)
    await expect(runZaiSignIn(talk, { fetch: context.fetch })).resolves.toBe('existing-key.secret')

    expect(REDIRECT_URI).toBe('zcode://zai-auth/callback')
    const page = talk.asked[0] as { url: string; redirectUri: string }
    expect(page.redirectUri).toBe(REDIRECT_URI)
    expect(param(page.url, 'redirect_uri')).toBe(REDIRECT_URI)
    expect(param(page.url, 'client_id')).toBe('client_P8X5CMWmlaRO9gyO-KSqtg')
    expect(param(page.url, 'response_type')).toBe('code')
    expect(page.url).toContain('https://chat.z.ai/api/oauth/authorize?')
  })

  it('sends the token exchange the same redirect the authorize page was given', async () => {
    const context = routed(signInReplies())
    await runZaiSignIn(conversation(() => 'code-2'), { fetch: context.fetch })
    const exchange = vi.mocked(context.fetch).mock.calls.find(([url]) => url === TOKEN) as [string, RequestInit]
    expect(JSON.parse(exchange[1].body as string)).toMatchObject({
      provider: 'zai',
      code: 'code-2',
      redirect_uri: REDIRECT_URI,
    })
  })

  it('asks for a redirect a deployment corrected when the allowlist moved again', async () => {
    const context = routed(signInReplies())
    const talk = conversation(() => 'code-3')
    await runZaiSignIn(talk, { fetch: context.fetch, redirectUri: 'zcode://elsewhere/cb' })
    expect((talk.asked[0] as { redirectUri: string }).redirectUri).toBe('zcode://elsewhere/cb')
  })

  it('runs on the ambient fetch when none is supplied', async () => {
    const context = routed(signInReplies())
    vi.stubGlobal('fetch', context.fetch)
    await expect(runZaiSignIn(conversation(() => 'code-4'))).resolves.toBe('existing-key.secret')
  })

  it('refuses an answer that carries no code', async () => {
    const context = routed(signInReplies())
    for (const pasted of ['', `${REDIRECT_URI}?code=`]) {
      await expect(runZaiSignIn(conversation(() => pasted), { fetch: context.fetch }))
        .rejects.toMatchObject({ code: 'ZAI_NO_CODE' })
    }
  })

  it('refuses an answer minted for a different attempt', async () => {
    const context = routed(signInReplies())
    await expect(runZaiSignIn(conversation(() => 'code-5#someone-elses-state'), { fetch: context.fetch }))
      .rejects.toMatchObject({ code: 'ZAI_STATE_MISMATCH' })
  })

  it('refuses a token exchange that returned no access token', async () => {
    const context = routed(signInReplies({ [`POST ${TOKEN}`]: { code: 0, data: { user: { id: 1 } } } }))
    await expect(runZaiSignIn(conversation(() => 'code-6'), { fetch: context.fetch }))
      .rejects.toMatchObject({ code: 'ZAI_NO_ACCESS_TOKEN' })
  })

  it('carries a refused conversation out to the caller', async () => {
    const context = routed(signInReplies())
    const talk: ZaiSignInConversation = {
      signal: new AbortController().signal,
      ask: () => Promise.reject(new Error('declined')),
    }
    await expect(runZaiSignIn(talk, { fetch: context.fetch })).rejects.toThrow('declined')
  })
})
