import { Context } from "@deepseek-ai/cordis";

//#region src/transport.d.ts

/** The fetch implementation one sign-in runs on; injectable so tests answer without a network. */
type ZaiFetch = (url: string, init: RequestInit) => Promise<Response>;
/** Stable error taxonomy for a Z.AI sign-in that could not produce a key. */
declare class ZaiSignInError extends Error {
  /** Stable machine-routable failure class; route on this, never by parsing `message`. */
  readonly code: string;
  constructor(message: string, code: string, options?: ErrorOptions);
}
//#endregion
//#region src/oauth.d.ts

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
declare const REDIRECT_URI = "zcode://zai-auth/callback";
/** What a caller may replace; production supplies none of it. */
interface ZaiSignInOptions {
  /** The fetch implementation every Z.AI call runs on. */
  readonly fetch?: ZaiFetch;
  /** The redirect to ask Z.AI for, when their allowlist has moved again. */
  readonly redirectUri?: string;
}
/** An authorization code and the state it came back with. */
interface AuthorizationAnswer {
  code?: string;
  state?: string;
}
/** How one sign-in talks to the human. */
interface ZaiSignInConversation {
  /** The address to open, and the answer it eventually produces. */
  ask(request: {
    readonly url: string;
    readonly redirectUri: string;
  }): Promise<string>;
  /** Withdraws the whole sign-in. */
  readonly signal: AbortSignal;
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
declare function parseAuthorizationAnswer(input: string): AuthorizationAnswer;
/**
 * Run one GLM Coding Plan sign-in.
 *
 * @param conversation - how to put the authorize page to the human and read their answer.
 * @param options - replacements for the fetch implementation and the redirect.
 * @returns the durable `id.secret` key the inference endpoint authenticates.
 * @throws {ZaiSignInError} code `ZAI_NO_CODE` when no authorization code arrived,
 *   or `ZAI_STATE_MISMATCH` when the answer belongs to a different attempt.
 */
declare function runZaiSignIn(conversation: ZaiSignInConversation, options?: ZaiSignInOptions): Promise<string>;
//#endregion
//#region src/mint.d.ts
/**
 * The name this plugin gives the key it mints. Distinct per client by
 * convention: a shared name would mean one client's revocation logging another
 * out, and the Z.AI console lists keys by exactly this string.
 */
declare const KEY_NAME = "deepseek-harness";
//#endregion
//#region src/index.d.ts
declare const name = "zai-coding-plan";
/** Services this plugin cannot work without. */
declare const inject: string[];
/** How this plugin may be adapted without waiting for a release. */
interface Config {
  /**
   * The pi-ai route to configure. Defaults to `zai` (`api.z.ai`); a deployment
   * on the mainland endpoint points this at its own route instead.
   */
  readonly provider?: string;
  /**
   * The credential reference the minted key is stored under, and the one the
   * route's profile names. Defaults to `ZAI_API_KEY`.
   */
  readonly credentialRef?: string;
  /**
   * The redirect to ask Z.AI for. Z.AI validates it against a server-side
   * allowlist this plugin does not control, and that allowlist has already
   * moved once — every loopback address it once accepted is now refused at the
   * authorize page. Set this when it moves again.
   */
  readonly redirectUri?: string;
}
/** The resolved configuration one command run reads. */
interface Resolved {
  readonly provider: string;
  readonly ref: string;
  readonly redirectUri: string | undefined;
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
declare function conversationFor(ctx: Context, run: {
  readonly agent?: unknown;
  readonly signal: AbortSignal;
}): ZaiSignInConversation;
/**
 * Store the minted key and declare the route that reads it.
 *
 * Two writes, because a credential is not a route: the pi-ai adapter registers
 * only what its settings section declares, so a key on its own leaves the
 * Models page and the model picker unchanged. The profile names the reference
 * rather than carrying the key, which is what keeps `settings.yaml` free of
 * secrets. An existing profile is left exactly as it is — it may carry an
 * endpoint, a narrowed model list, or a different reference that this sign-in
 * has no business rewriting.
 * @param ctx - the plugin context carrying the credential and settings services.
 * @param resolved - the route and reference this run configures.
 * @param key - the durable key the sign-in minted.
 */
declare function store(ctx: Context, resolved: Resolved, key: string): Promise<void>;
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
declare function apply(ctx: Context, config?: Config): () => void;
//#endregion
export { Config, KEY_NAME, REDIRECT_URI, type ZaiSignInConversation, ZaiSignInError, type ZaiSignInOptions, apply, conversationFor, inject, name, parseAuthorizationAnswer, runZaiSignIn, store };