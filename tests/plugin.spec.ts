import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, conversationFor } from '../src/index.ts'
import { ProvisionError, provisionRoute, provisionState } from '../src/provision.ts'
import { mintReplies, routed, TOKEN } from './fake-zai.ts'
import type { Replies } from './fake-zai.ts'

const PI_AI_NS = settingsNamespace('llm-pi-ai')

/** The replies of a sign-in that ends in `existing-key.secret`. */
function signInReplies(extra: Replies = {}): Replies {
  return mintReplies({
    [`POST ${TOKEN}`]: { code: 0, data: { zai: { access_token: 'oauth-token' } } },
    ...extra,
  })
}

/** One registered command, as the fake registry captured it. */
interface Registered {
  name: string
  description: string
  handler: (run: { agent?: unknown; signal: AbortSignal }) => Promise<{ kind: string; text?: string }>
}

/** The host services this plugin reaches, each recording what it was asked. */
function host(options: { section?: Record<string, unknown>; answer?: string } = {}) {
  const registered: Registered[] = []
  const asked: unknown[] = []
  const credentials: [string, string][] = []
  const mutations: unknown[][] = []
  let section = options.section
  const ctx = {
    commands: {
      register: (definition: Registered) => {
        registered.push(definition)
        return () => { registered.length = 0 }
      },
    },
    userQuestions: {
      ask: (request: unknown) => {
        asked.push(request)
        return Promise.resolve({
          answers: [{ id: 'zai-redirect', selected: [], custom: options.answer ?? 'pasted-code' }],
        })
      },
    },
    credentials: {
      set: (ref: string, value: string) => {
        credentials.push([String(ref), value])
        return Promise.resolve()
      },
    },
    settings: {
      describe: () => section === undefined ? [] : [{ ns: PI_AI_NS, value: section }],
      mutate: (_ns: unknown, ops: unknown[]) => {
        mutations.push(ops)
        section = { providers: { zai: { apiKeyEnv: 'ZAI_API_KEY' } } }
        return Promise.resolve()
      },
    },
  } as unknown as Context
  return { ctx, registered, asked, credentials, mutations }
}

describe('the plugin entry', () => {
  it('registers one command naming the route it configures', () => {
    const { ctx, registered } = host()
    apply(ctx)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe('zai-login')
    expect(registered[0]?.description).toContain('zai')
  })

  it('names a route a deployment redirected the command at', () => {
    const { ctx, registered } = host()
    apply(ctx, { provider: 'zai-coding-cn' })
    expect(registered[0]?.description).toContain('zai-coding-cn')
  })

  it('signs in, stores the key under its reference, and declares the route', async () => {
    const context = routed(signInReplies())
    vi.stubGlobal('fetch', context.fetch)
    const { ctx, registered, credentials, mutations, asked } = host({ section: { providers: {} } })
    apply(ctx)
    const result = await (registered[0] as Registered)
      .handler({ signal: new AbortController().signal })
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toContain('models are now selectable')
    expect(credentials).toEqual([['ZAI_API_KEY', 'existing-key.secret']])
    expect(mutations).toEqual([[{ op: 'set', path: ['providers', 'zai'], value: { apiKeyEnv: 'ZAI_API_KEY' } }]])
    expect(asked).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('says the key was refreshed when the route was already configured', async () => {
    const context = routed(signInReplies())
    vi.stubGlobal('fetch', context.fetch)
    const { ctx, registered, mutations } = host({ section: { providers: { zai: { baseURL: 'https://proxy/v1' } } } })
    apply(ctx)
    const result = await (registered[0] as Registered)
      .handler({ signal: new AbortController().signal })
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toContain('key is refreshed')
    expect(mutations).toEqual([])
    vi.unstubAllGlobals()
  })

  it('asks for a redirect a deployment corrected when the allowlist moved again', async () => {
    const context = routed(signInReplies())
    vi.stubGlobal('fetch', context.fetch)
    const { ctx, registered, asked } = host({ section: { providers: {} } })
    apply(ctx, { redirectUri: 'zcode://elsewhere/cb' })
    await (registered[0] as Registered).handler({ signal: new AbortController().signal })
    const question = (asked[0] as { questions: { detail: string }[] }).questions[0]
    expect(question?.detail).toContain('zcode://elsewhere/cb')
    vi.unstubAllGlobals()
  })

  it('reports the step that broke rather than throwing at the chat', async () => {
    const context = routed(signInReplies({ [`POST ${TOKEN}`]: { code: 401, msg: 'bad code' } }))
    vi.stubGlobal('fetch', context.fetch)
    const { ctx, registered, credentials } = host({ section: { providers: {} } })
    apply(ctx)
    const result = await (registered[0] as Registered)
      .handler({ signal: new AbortController().signal })
    expect(result).toMatchObject({ kind: 'error' })
    expect(result.text).toContain('bad code')
    expect(credentials).toEqual([])
    vi.unstubAllGlobals()
  })

  it('reports a refusal that was not an Error', async () => {
    const { ctx, registered } = host()
    const failing = {
      ...ctx,
      userQuestions: { ask: () => Promise.reject('nope') },
    } as unknown as Context
    apply(failing)
    const result = await (registered[0] as Registered)
      .handler({ signal: new AbortController().signal })
    expect(result).toMatchObject({ kind: 'error', text: 'Z.AI sign-in failed: nope' })
  })
})

describe('storing what the sign-in produced', () => {
  /** The two seams, as provisioning takes them. */
  function target(built: ReturnType<typeof host>) {
    const ctx = built.ctx as unknown as { credentials: never; settings: never }
    return { credentials: ctx.credentials, settings: ctx.settings }
  }

  it('leaves a route someone already configured exactly as it is', async () => {
    const built = host({ section: { providers: { zai: { baseURL: 'https://proxy/v1' } } } })
    await expect(provisionRoute('id.secret', target(built))).resolves.toEqual({
      ref: 'ZAI_API_KEY',
      routeDeclared: false,
    })
    expect(built.credentials).toEqual([['ZAI_API_KEY', 'id.secret']])
    expect(built.mutations).toEqual([])
  })

  it('declares the route when the section does not exist at all', async () => {
    const built = host()
    await expect(provisionRoute('id.secret', target(built), 'MY_REF')).resolves.toEqual({
      ref: 'MY_REF',
      routeDeclared: true,
    })
    expect(built.mutations).toEqual([[{ op: 'set', path: ['providers', 'zai'], value: { apiKeyEnv: 'MY_REF' } }]])
  })

  it('declares the route a deployment redirected the sign-in at', async () => {
    const built = host({ section: { providers: {} } })
    await provisionRoute('id.secret', target(built), 'ZAI_API_KEY', 'zai-coding-cn')
    expect(built.mutations).toEqual([[
      { op: 'set', path: ['providers', 'zai-coding-cn'], value: { apiKeyEnv: 'ZAI_API_KEY' } },
    ]])
  })

  it('refuses when there is nowhere to keep the key', async () => {
    await expect(provisionRoute('id.secret', {})).rejects.toMatchObject({ code: 'NO_CREDENTIAL_STORE' })
  })

  it('names the reference when the store refuses the write', async () => {
    const credentials = { set: () => Promise.reject(new Error('read-only source shadows it')) }
    await expect(provisionRoute('id.secret', { credentials: credentials as never }))
      .rejects.toMatchObject({ code: 'CREDENTIAL_REFUSED' })
  })

  it('keeps the key when the route cannot be declared', async () => {
    const built = host({ section: { providers: {} } })
    const credentials = target(built).credentials
    await expect(provisionRoute('id.secret', { credentials })).rejects.toMatchObject({
      code: 'NO_SETTINGS_PROVIDER',
    })
    expect(built.credentials).toEqual([['ZAI_API_KEY', 'id.secret']])

    const settings = {
      describe: () => [],
      mutate: () => Promise.reject('the settings document is read-only'),
    }
    await expect(provisionRoute('id.secret', { credentials, settings: settings as never }))
      .rejects.toMatchObject({ code: 'SETTINGS_REFUSED' })
    expect(ProvisionError).toBeTypeOf('function')
  })

  it('reports what this deployment already has', async () => {
    const built = host({ section: { providers: { zai: {} } } })
    const seams = target(built)
    const configured = { describe: () => Promise.resolve({ configured: true, writable: true }) }
    await expect(provisionState({ credentials: configured as never, settings: seams.settings }))
      .resolves.toEqual({ keyStored: true, routeDeclared: true })
    await expect(provisionState({})).resolves.toEqual({ keyStored: false, routeDeclared: false })
  })
})

describe('the sign-in conversation', () => {
  it('puts the authorize page and the unreachable redirect to the human', async () => {
    const { ctx, asked } = host({ answer: 'zcode://zai-auth/callback?code=abc' })
    const talk = conversationFor(ctx, { signal: new AbortController().signal })
    await expect(talk.ask({ url: 'https://chat.z.ai/authorize?x=1', redirectUri: 'zcode://zai-auth/callback' }))
      .resolves.toBe('zcode://zai-auth/callback?code=abc')
    const question = (asked[0] as { questions: { detail: string }[] }).questions[0]
    expect(question?.detail).toContain('https://chat.z.ai/authorize?x=1')
    expect(question?.detail).toContain('cannot open zcode://zai-auth/callback')
  })

  it('carries the agent through when the command run has one', async () => {
    const { ctx, asked } = host()
    const agent = { id: 'agent-1' }
    const talk = conversationFor(ctx, { agent, signal: new AbortController().signal })
    await talk.ask({ url: 'https://chat.z.ai/authorize', redirectUri: 'zcode://zai-auth/callback' })
    expect(asked[0]).toMatchObject({ agent })
  })

  it('falls back from the free-text answer to a chosen option, then to nothing', async () => {
    for (const [item, expected] of [
      [{ id: 'zai-redirect', selected: ['chosen'] }, 'chosen'],
      [{ id: 'zai-redirect', selected: [] }, ''],
      [{ id: 'other', selected: ['x'] }, ''],
    ] as const) {
      const ctx = {
        userQuestions: { ask: () => Promise.resolve({ answers: [item] }) },
      } as unknown as Context
      const talk = conversationFor(ctx, { signal: new AbortController().signal })
      await expect(talk.ask({ url: 'u', redirectUri: 'r' })).resolves.toBe(expected)
    }
  })
})
