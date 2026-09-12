import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { randomUUID } from "node:crypto";

//#region src/transport.ts
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
const REQUEST_TIMEOUT_MS = 3e4;
/** Stable error taxonomy for a Z.AI sign-in that could not produce a key. */
var ZaiSignInError = class extends Error {
	/** Stable machine-routable failure class; route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.name = "ZaiSignInError";
		this.code = code;
	}
};
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
function isSuccessCode(code) {
	if (code === null || code === void 0) return true;
	if (typeof code === "number") return code === 0 || code === 200;
	if (typeof code === "string") return code === "0" || code === "200";
	return false;
}
/**
* Take the payload out of one Z.AI envelope.
* @param body - the parsed response body.
* @param operation - what was being attempted, named in the failure.
* @returns the envelope's `data`, or the body itself when it carries no envelope.
* @throws {ZaiSignInError} code `ZAI_REJECTED` when the envelope reports failure.
*/
function unwrapEnvelope(body, operation) {
	if (typeof body !== "object" || body === null || !("code" in body || "success" in body)) return body;
	const envelope = body;
	if (envelope.success === false || !isSuccessCode(envelope.code)) throw new ZaiSignInError(`Z.AI ${operation} failed: ${typeof envelope.msg === "string" && envelope.msg.length > 0 ? envelope.msg : `code ${String(envelope.code)}`}`, "ZAI_REJECTED");
	return "data" in envelope ? envelope.data : envelope;
}
/**
* The trimmed string one envelope member holds, when it holds one at all.
* @param value - the member as it arrived.
* @returns the trimmed value, or undefined when it is absent or blank.
*/
function trimmedString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
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
async function request(url, init, operation, context) {
	const signal = AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	const response = await context.fetch(url, {
		...init,
		signal
	});
	const body = await response.text();
	if (!response.ok) throw new ZaiSignInError(`Z.AI ${operation} failed: ${url} answered ${response.status} ${body}`, "ZAI_HTTP");
	return body.length > 0 ? JSON.parse(body) : void 0;
}
/**
* Read one Z.AI endpoint and unwrap its envelope.
* @param url - the endpoint to read.
* @param headers - request headers, carrying the bearer token when there is one.
* @param operation - what is being attempted, named in a failure.
* @param context - the fetch implementation and the command's cancellation signal.
* @returns the envelope's payload.
*/
async function zaiGet(url, headers, operation, context) {
	return unwrapEnvelope(await request(url, {
		method: "GET",
		headers: { ...headers }
	}, operation, context), operation);
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
async function zaiPost(url, body, headers, operation, context) {
	return unwrapEnvelope(await request(url, {
		method: "POST",
		headers: {
			...headers,
			"Content-Type": "application/json"
		},
		body: JSON.stringify(body)
	}, operation, context), operation);
}

//#endregion
//#region src/mint.ts
/** Root of Z.AI's business API, which owns accounts, projects, and keys. */
const BUSINESS_BASE = "https://api.z.ai";
/** Exchanges the OAuth access token for the token the business API accepts. */
const BUSINESS_LOGIN_URL = `${BUSINESS_BASE}/api/auth/z/login`;
/**
* The name this plugin gives the key it mints. Distinct per client by
* convention: a shared name would mean one client's revocation logging another
* out, and the Z.AI console lists keys by exactly this string.
*/
const KEY_NAME = "deepseek-harness";
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
async function businessLogin(oauthAccessToken, context) {
	const data = await zaiPost(BUSINESS_LOGIN_URL, { token: oauthAccessToken }, {}, "business login", context);
	const token = trimmedString(data?.access_token) ?? trimmedString(data?.accessToken);
	if (token === void 0) throw new ZaiSignInError("Z.AI business login returned no access token", "ZAI_NO_BUSINESS_TOKEN");
	return token;
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
async function defaultProject(headers, context) {
	const customer = await zaiGet(`${BUSINESS_BASE}/api/biz/customer/getCustomerInfo`, headers, "customer lookup", context);
	const organizations = Array.isArray(customer?.organizations) ? customer.organizations : [];
	const organization = organizations.find((entry) => entry.isDefault === true) ?? organizations[0];
	const projects = Array.isArray(organization?.projects) ? organization.projects : [];
	const project = projects.find((entry) => entry.isDefault === true) ?? projects[0];
	const organizationId = trimmedString(organization?.organizationId);
	const projectId = trimmedString(project?.projectId);
	if (organizationId === void 0 || projectId === void 0) throw new ZaiSignInError("Z.AI key provisioning failed: the signed-in account has no organization and project to create a key in", "ZAI_NO_PROJECT");
	return {
		organizationId,
		projectId
	};
}
/**
* The key list as an array, whichever shape the endpoint wrapped it in.
* @param value - the unwrapped list payload.
* @returns the key records, or an empty array when the payload holds none.
*/
function asKeyList(value) {
	if (Array.isArray(value)) return value;
	if (typeof value !== "object" || value === null) return [];
	const record = value;
	for (const field of [
		"list",
		"keys",
		"apiKeys",
		"records"
	]) {
		const candidate = record[field];
		if (Array.isArray(candidate)) return candidate;
	}
	return [];
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
async function mintCodingPlanKey(oauthAccessToken, context) {
	const headers = { Authorization: `Bearer ${await businessLogin(oauthAccessToken, context)}` };
	const { organizationId, projectId } = await defaultProject(headers, context);
	const keysUrl = `${BUSINESS_BASE}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
	const apiKey = trimmedString((asKeyList(await zaiGet(keysUrl, headers, "api key list", context)).find((entry) => entry.name === KEY_NAME) ?? await zaiPost(keysUrl, { name: KEY_NAME }, headers, "api key create", context))?.apiKey);
	if (apiKey === void 0) throw new ZaiSignInError(`Z.AI created no key named "${KEY_NAME}"`, "ZAI_NO_KEY");
	const secretKey = trimmedString((await zaiGet(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, headers, "api key copy", context))?.secretKey);
	if (secretKey === void 0) throw new ZaiSignInError(`Z.AI returned no secret for the key named "${KEY_NAME}"`, "ZAI_NO_SECRET");
	return `${apiKey}.${secretKey}`;
}

//#endregion
//#region src/oauth.ts
/** Z.AI's own desktop client id; the authorize page rejects any other. */
const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
/** The page the human signs in on. */
const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
/** The endpoint that turns an authorization code into an OAuth access token. */
const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
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
const REDIRECT_URI = "zcode://zai-auth/callback";
/**
* The authorization answer one query string carries.
* @param params - the parsed query.
* @returns its code and state, either of which may be absent.
*/
function fromQuery(params) {
	const code = params.get("code");
	const state = params.get("state");
	return {
		...code === null ? {} : { code },
		...state === null ? {} : { state }
	};
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
function parseAuthorizationAnswer(input) {
	const value = input.trim();
	if (value.length === 0) return {};
	if (URL.canParse(value)) return fromQuery(new URL(value).searchParams);
	const separator = value.indexOf("#");
	if (separator >= 0) return {
		code: value.slice(0, separator),
		state: value.slice(separator + 1)
	};
	if (value.includes("code=")) return fromQuery(new URLSearchParams(value));
	return { code: value };
}
/**
* The page to send the human to.
* @param state - the value this attempt expects echoed back.
* @param redirectUri - the address the browser is redirected to afterwards.
* @returns the authorize URL.
*/
function authorizeUrl(state, redirectUri) {
	return `${AUTHORIZE_URL}?${new URLSearchParams({
		redirect_uri: redirectUri,
		response_type: "code",
		client_id: CLIENT_ID,
		state
	}).toString()}`;
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
async function exchangeCode(answer, context) {
	const accessToken = trimmedString((await zaiPost(TOKEN_URL, {
		provider: "zai",
		code: answer.code,
		redirect_uri: answer.redirectUri,
		state: answer.state
	}, {}, "token exchange", context))?.zai?.access_token);
	if (accessToken === void 0) throw new ZaiSignInError("Z.AI token exchange returned no access token", "ZAI_NO_ACCESS_TOKEN");
	return accessToken;
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
async function runZaiSignIn(conversation, options = {}) {
	const context = {
		fetch: options.fetch ?? fetch,
		signal: conversation.signal
	};
	const state = randomUUID();
	const redirectUri = options.redirectUri ?? REDIRECT_URI;
	const answer = parseAuthorizationAnswer(await conversation.ask({
		url: authorizeUrl(state, redirectUri),
		redirectUri
	}));
	if (answer.code === void 0 || answer.code.length === 0) throw new ZaiSignInError("Z.AI sign-in produced no authorization code", "ZAI_NO_CODE");
	if (answer.state !== void 0 && answer.state !== state) throw new ZaiSignInError("Z.AI returned an authorization code for a different sign-in attempt", "ZAI_STATE_MISMATCH");
	return mintCodingPlanKey(await exchangeCode({
		code: answer.code,
		state,
		redirectUri
	}, context), context);
}

//#endregion
//#region src/index.ts
const name = "zai-coding-plan";
/** Services this plugin cannot work without. */
const inject = [
	"commands",
	"userQuestions",
	"credentials",
	"settings"
];
/** The pi-ai adapter's settings section, where a provider route's profile lives. */
const PI_AI_NS = settingsNamespace("llm-pi-ai");
/** The question id the sign-in conversation answers under. */
const QUESTION_ID = "zai-redirect";
/**
* Resolve the configuration, supplying the defaults a deployment did not override.
* @param config - the plugin's entry configuration.
* @returns the values one run uses.
*/
function resolve(config) {
	return {
		provider: config.provider ?? "zai",
		ref: config.credentialRef ?? "ZAI_API_KEY",
		redirectUri: config.redirectUri
	};
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
function conversationFor(ctx, run) {
	return {
		signal: run.signal,
		async ask(request$1) {
			const item = (await ctx.userQuestions.ask({
				...run.agent === void 0 ? {} : { agent: run.agent },
				signal: run.signal,
				questions: [{
					id: QUESTION_ID,
					header: "Z.AI",
					question: "Open this page, sign in, then paste the address your browser ends on.",
					detail: `${request$1.url}\n\nYour browser cannot open ${request$1.redirectUri}; that address — or just the code inside it — is what to paste back.`
				}]
			})).answers.find((entry) => entry.id === QUESTION_ID);
			return item?.custom ?? item?.selected[0] ?? "";
		}
	};
}
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
async function store(ctx, resolved, key) {
	await ctx.credentials.set(credentialRef(resolved.ref), key);
	if ((ctx.settings.describe().find((descriptor) => descriptor.ns === PI_AI_NS)?.value)?.providers?.[resolved.provider] !== void 0) return;
	await ctx.settings.mutate(PI_AI_NS, [{
		op: "set",
		path: ["providers", resolved.provider],
		value: { apiKeyEnv: resolved.ref }
	}]);
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
function apply(ctx, config = {}) {
	const resolved = resolve(config);
	return ctx.commands.register({
		name: "zai-login",
		description: `Sign in to Z.AI's GLM Coding Plan and configure the ${resolved.provider} route`,
		async handler(run) {
			try {
				await store(ctx, resolved, await runZaiSignIn(conversationFor(ctx, run), { ...resolved.redirectUri === void 0 ? {} : { redirectUri: resolved.redirectUri } }));
				return {
					kind: "success",
					text: `Signed in to Z.AI. The ${resolved.provider} route is configured — its models are now selectable.`
				};
			} catch (error) {
				return {
					kind: "error",
					text: `Z.AI sign-in failed: ${error instanceof Error ? error.message : String(error)}`
				};
			}
		}
	});
}

//#endregion
export { KEY_NAME, REDIRECT_URI, ZaiSignInError, apply, conversationFor, inject, name, parseAuthorizationAnswer, runZaiSignIn, store };