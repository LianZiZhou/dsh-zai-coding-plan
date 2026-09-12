import { vi } from 'vitest'
import type { ZaiRequestContext } from '../src/transport.ts'
import { KEY_NAME } from '../src/mint.ts'

/** The endpoint that exchanges an authorization code for an OAuth access token. */
export const TOKEN = 'https://zcode.z.ai/api/v1/oauth/token'
/** The endpoint that exchanges the OAuth token for a business token. */
export const LOGIN = 'https://api.z.ai/api/auth/z/login'
/** The endpoint that reports an account's organizations and projects. */
export const CUSTOMER = 'https://api.z.ai/api/biz/customer/getCustomerInfo'
/** The key collection of the one organization and project these fakes report. */
export const KEYS = 'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys'

/** The replies one run should meet, addressed by `METHOD url`. */
export type Replies = Readonly<Record<string, unknown>>

/** A request context answering from a routing table, recording what it was asked. */
export function routed(replies: Replies): ZaiRequestContext & { asked: string[] } {
  const asked: string[] = []
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    const route = `${String(init.method)} ${url}`
    asked.push(route)
    if (!(route in replies)) throw new Error(`unexpected Z.AI request: ${route}`)
    return Promise.resolve(new Response(JSON.stringify(replies[route]), { status: 200 }))
  })
  return { fetch: fetchImpl, signal: new AbortController().signal, asked }
}

/**
 * The replies of a provisioning run that ends in `existing-key.secret`.
 * @param extra - replies replacing or adding to the successful ones.
 * @returns the full routing table.
 */
export function mintReplies(extra: Replies = {}): Replies {
  return {
    [`POST ${LOGIN}`]: { code: 200, data: { access_token: 'biz-token' } },
    [`GET ${CUSTOMER}`]: {
      code: 200,
      data: {
        organizations: [
          { organizationId: 'org-1', isDefault: true, projects: [{ projectId: 'proj-1', isDefault: true }] },
        ],
      },
    },
    [`GET ${KEYS}`]: { code: 200, data: [{ name: KEY_NAME, apiKey: 'existing-key' }] },
    [`POST ${KEYS}`]: { code: 200, data: { apiKey: 'created-key' } },
    [`GET ${KEYS}/copy/existing-key`]: { code: 200, data: { secretKey: 'secret' } },
    [`GET ${KEYS}/copy/created-key`]: { code: 200, data: { secretKey: 'secret' } },
    ...extra,
  }
}
