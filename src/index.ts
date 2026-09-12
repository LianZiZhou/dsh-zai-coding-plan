/**
 * DSH host plugin: sign in to Z.AI's GLM Coding Plan from the chat, and leave
 * the `zai` route usable.
 *
 * Z.AI issues nothing an inference request can use directly — the browser
 * conversation ends in a short-lived OAuth token, and the durable `id.secret`
 * key is minted from it afterwards through Z.AI's business API. This plugin
 * runs that whole sequence behind one slash command and then does the two
 * things that make the result usable: it stores the key under a credential
 * reference, and it declares the pi-ai route that reads it.
 *
 * Host-only by design. The conversation rides `ctx.userQuestions`, which the
 * chat already renders, so there is no browser half to install and nothing to
 * register on the Models page.
 *
 * @module dsh-zai-coding-plan
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import { runZaiSignIn } from './oauth.js'
import type { ZaiSignInConversation } from './oauth.js'
import { DEFAULT_CREDENTIAL_REF, provisionRoute, ROUTE } from './provision.js'

export { KEY_NAME } from './mint.js'
export { parseAuthorizationAnswer, REDIRECT_URI, runZaiSignIn } from './oauth.js'
export type { ZaiSignInConversation, ZaiSignInOptions } from './oauth.js'
export { DEFAULT_CREDENTIAL_REF, provisionRoute, provisionState, ProvisionError, ROUTE } from './provision.js'
export type { ProvisionResult, ProvisionTarget } from './provision.js'
export { ZaiSignInError } from './transport.js'

/** Cordis plugin name. */
export const name = 'zai-coding-plan'

/**
 * Services this plugin cannot work without. The credential store and the
 * settings provider are among them rather than optional: a sign-in that could
 * not store what it minted would spend the human's time and leave nothing.
 */
export const inject = ['commands', 'userQuestions', 'credentials', 'settings']

/** The question id the sign-in conversation answers under. */
const QUESTION_ID = 'zai-redirect'

/** How this plugin may be adapted without waiting for a release. */
export interface Config {
  /**
   * The pi-ai route to configure. Defaults to `zai` (`api.z.ai`); a deployment
   * on the mainland endpoint points this at its own route instead.
   */
  readonly provider?: string
  /**
   * The credential reference the minted key is stored under, and the one the
   * route's profile names. Defaults to `ZAI_API_KEY`.
   */
  readonly credentialRef?: string
  /**
   * The redirect to ask Z.AI for. Z.AI validates it against a server-side
   * allowlist this plugin does not control, and that allowlist has already
   * moved once — every loopback address it once accepted is now refused at the
   * authorize page. Set this when it moves again.
   */
  readonly redirectUri?: string
}

/** The resolved configuration one command run reads. */
interface Resolved {
  readonly provider: string
  readonly ref: string
  readonly redirectUri: string | undefined
}

/**
 * Resolve the configuration, supplying the defaults a deployment did not override.
 * @param config - the plugin's entry configuration.
 * @returns the values one run uses.
 */
function resolve(config: Config): Resolved {
  return {
    provider: config.provider ?? ROUTE,
    ref: config.credentialRef ?? DEFAULT_CREDENTIAL_REF,
    redirectUri: config.redirectUri,
  }
}

/**
 * Put the authorize page to the human and read back what their browser showed.
 *
 * The whole exchange is one question, because that is what it is: the address
 * to open is the question's detail, and the answer is the address the browser
 * ended on. A question with no options asks for free text, which arrives as the
 * answer's `custom` field.
 * @param ctx - the plugin context carrying `ctx.userQuestions`.
 * @param run - the command run this conversation belongs to.
 * @returns the conversation to hand the sign-in.
 */
export function conversationFor(
  ctx: Context,
  run: { readonly agent?: unknown; readonly signal: AbortSignal },
): ZaiSignInConversation {
  return {
    signal: run.signal,
    async ask(request) {
      const answer = await ctx.userQuestions.ask({
        ...run.agent === undefined ? {} : { agent: run.agent as never },
        signal: run.signal,
        questions: [{
          id: QUESTION_ID,
          header: 'Z.AI',
          question: 'Open this page, sign in, then paste the address your browser ends on.',
          detail: `${request.url}\n\nYour browser cannot open ${request.redirectUri}; that address —`
            + ' or just the code inside it — is what to paste back.',
        }],
      })
      const item = answer.answers.find(entry => entry.id === QUESTION_ID)
      return item?.custom ?? item?.selected[0] ?? ''
    },
  }
}

/**
 * Register the `/zai-login` command.
 *
 * A failed sign-in is the command's error result rather than a thrown one: the
 * human asked for this in their own chat, and the step that broke — Z.AI
 * refusing the redirect, the token exchange, the key provisioning — is what
 * they need to read there.
 * @param ctx - the plugin context.
 * @param config - the entry configuration.
 * @returns Disposer that withdraws the command.
 */
export function apply(ctx: Context, config: Config = {}): () => void {
  const resolved = resolve(config)
  return ctx.commands.register({
    name: 'zai-login',
    description: `Sign in to Z.AI's GLM Coding Plan and configure the ${resolved.provider} route`,
    async handler(run) {
      try {
        const key = await runZaiSignIn(conversationFor(ctx, run), {
          ...resolved.redirectUri === undefined ? {} : { redirectUri: resolved.redirectUri },
        })
        const provisioned = await provisionRoute(
          key,
          { credentials: ctx.credentials, settings: ctx.settings },
          resolved.ref,
          resolved.provider,
        )
        return {
          kind: 'success',
          text: provisioned.routeDeclared
            ? `Signed in to Z.AI. The ${resolved.provider} route is configured — its models are now selectable.`
            : `Signed in to Z.AI. The ${resolved.provider} route was already configured; its key is refreshed.`,
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `Z.AI sign-in failed: ${detail}` }
      }
    },
  })
}
