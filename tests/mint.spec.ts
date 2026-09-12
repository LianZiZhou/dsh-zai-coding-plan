import { describe, expect, it } from 'vitest'
import { KEY_NAME, mintCodingPlanKey } from '../src/mint.ts'
import { CUSTOMER, KEYS, LOGIN, mintReplies, routed } from './fake-zai.ts'
import type { Replies } from './fake-zai.ts'
import type { ZaiRequestContext } from '../src/transport.ts'

/**
 * The replies of a run that ends in a usable key, with the key list overridden.
 * @param list - the payload the key-list endpoint answers.
 * @param extra - further replies replacing the successful ones.
 * @returns the request context to mint through.
 */
function run(list: unknown, extra: Replies = {}): ZaiRequestContext & { asked: string[] } {
  return routed(mintReplies({ [`GET ${KEYS}`]: list, ...extra }))
}

const EXISTING = { code: 200, data: [{ name: KEY_NAME, apiKey: 'existing-key' }] }

describe('minting the durable key', () => {
  it('reuses the key this harness already made', async () => {
    const context = run(EXISTING)
    await expect(mintCodingPlanKey('oauth-token', context)).resolves.toBe('existing-key.secret')
    expect(context.asked).toEqual([
      `POST ${LOGIN}`,
      `GET ${CUSTOMER}`,
      `GET ${KEYS}`,
      `GET ${KEYS}/copy/existing-key`,
    ])
  })

  it('creates a key named for this harness when the account has none', async () => {
    const context = run({ code: 200, data: [{ name: 'zcode-api-key', apiKey: 'someone-elses' }] })
    await expect(mintCodingPlanKey('oauth-token', context)).resolves.toBe('created-key.secret')
    expect(context.asked).toContain(`POST ${KEYS}`)
  })

  it('reads the key list out of every shape the endpoint wraps it in', async () => {
    const entry = { name: KEY_NAME, apiKey: 'existing-key' }
    for (const field of ['list', 'keys', 'apiKeys', 'records']) {
      const context = run({ code: 200, data: { [field]: [entry] } })
      await expect(mintCodingPlanKey('oauth-token', context)).resolves.toBe('existing-key.secret')
      expect(context.asked).not.toContain(`POST ${KEYS}`)
    }
  })

  it('creates a key when the list payload holds no list at all', async () => {
    for (const payload of [{ code: 200, data: 'unexpected' }, { code: 200, data: { total: 0 } }, { code: 200 }]) {
      const context = run(payload)
      await expect(mintCodingPlanKey('oauth-token', context)).resolves.toBe('created-key.secret')
    }
  })

  it('accepts either spelling of the business token', async () => {
    const context = run(EXISTING, { [`POST ${LOGIN}`]: { code: 200, data: { accessToken: 'biz-token' } } })
    await expect(mintCodingPlanKey('oauth-token', context)).resolves.toBe('existing-key.secret')
  })

  it('refuses a business login that returned no token', async () => {
    const context = run(EXISTING, { [`POST ${LOGIN}`]: { code: 200, data: {} } })
    await expect(mintCodingPlanKey('oauth-token', context)).rejects.toThrow(
      expect.objectContaining({ code: 'ZAI_NO_BUSINESS_TOKEN' }),
    )
  })

  it('sends the business token as the bearer for every later call', async () => {
    const context = run(EXISTING)
    await mintCodingPlanKey('oauth-token', context)
    expect(context.fetch).toHaveBeenCalledWith(CUSTOMER, expect.objectContaining({
      headers: { Authorization: 'Bearer biz-token' },
    }))
  })

  it('falls back to the first organization and project when none is marked default', async () => {
    const context = run(EXISTING, {
      [`GET ${CUSTOMER}`]: {
        code: 200,
        data: {
          organizations: [
            { organizationId: 'org-1', projects: [{ projectId: 'proj-1' }, { projectId: 'proj-2' }] },
            { organizationId: 'org-9', projects: [{ projectId: 'proj-9' }] },
          ],
        },
      },
    })
    await expect(mintCodingPlanKey('oauth-token', context)).resolves.toBe('existing-key.secret')
  })

  it('prefers the organization and project the account marks default', async () => {
    const context = run(EXISTING, {
      [`GET ${CUSTOMER}`]: {
        code: 200,
        data: {
          organizations: [
            { organizationId: 'org-9', projects: [{ projectId: 'proj-9' }] },
            { organizationId: 'org-1', isDefault: true, projects: [{ projectId: 'proj-9' }, { projectId: 'proj-1', isDefault: true }] },
          ],
        },
      },
    })
    await expect(mintCodingPlanKey('oauth-token', context)).resolves.toBe('existing-key.secret')
  })

  it('refuses an account with no organization or project to create a key in', async () => {
    const empty = [{ code: 200, data: {} }, { code: 200, data: { organizations: [] } },
      { code: 200, data: { organizations: [{ organizationId: 'org-1' }] } }]
    for (const payload of empty) {
      const context = run(EXISTING, { [`GET ${CUSTOMER}`]: payload })
      await expect(mintCodingPlanKey('oauth-token', context)).rejects.toThrow(
        expect.objectContaining({ code: 'ZAI_NO_PROJECT' }),
      )
    }
  })

  it('refuses a creation that answered without a key', async () => {
    const context = run({ code: 200, data: [] }, { [`POST ${KEYS}`]: { code: 200, data: {} } })
    await expect(mintCodingPlanKey('oauth-token', context)).rejects.toThrow(
      expect.objectContaining({ code: 'ZAI_NO_KEY' }),
    )
  })

  it('refuses a key whose secret the copy endpoint withheld', async () => {
    const context = run(EXISTING, { [`GET ${KEYS}/copy/existing-key`]: { code: 200, data: {} } })
    await expect(mintCodingPlanKey('oauth-token', context)).rejects.toThrow(
      expect.objectContaining({ code: 'ZAI_NO_SECRET' }),
    )
  })
})
