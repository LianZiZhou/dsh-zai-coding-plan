# dsh-zai-coding-plan

A DSH plugin that signs you in to **Z.AI's GLM Coding Plan** from the chat and leaves the `zai` provider ready to use.

Z.AI issues nothing an inference request can use directly: the browser sign-in ends in a short-lived OAuth token, and the durable `id.secret` key is minted from it afterwards through Z.AI's business API. This plugin runs that whole sequence behind one slash command, then does the two things that make the result usable — it stores the key under a credential reference, and it declares the pi-ai route that reads it.

Host-only. There is no browser half to install: the conversation rides `ctx.userQuestions`, which the chat already renders.

## Install

```bash
dsh plugin --profile <name> add dsh-zai-coding-plan
```

That reconciles the profile's bundle stack against the installed packages and mounts the plugin through its own `cordis.patch.yml`. Restart the profile afterwards.

## Use

Type `/zai-login` in any conversation.

1. The chat asks a question whose detail carries a `chat.z.ai` link. Open it and sign in.
2. Z.AI sends your browser to `zcode://zai-auth/callback?code=…`, which **no browser can open**. That address is the answer — copy it from the address bar (or copy just the code inside it) and paste it into the question.
3. The plugin exchanges the code, mints the key, stores it as `ZAI_API_KEY`, and writes the `zai` route into your settings.

GLM models are then in the model picker, and the Z.AI console lists a key named `deepseek-harness`.

Signing in again reuses that key rather than making another, so revoking it in the Z.AI console signs this harness out and leaves keys made by other clients alone.

## What it writes

| Where | What |
|---|---|
| credential store | the minted `id.secret` key, under the reference `ZAI_API_KEY` |
| `settings.yaml` | `llm-pi-ai.providers.zai = { apiKeyEnv: ZAI_API_KEY }` |

The profile names the reference rather than carrying the key, so `settings.yaml` never holds a secret. An existing profile for that route is left exactly as it is — it may carry an endpoint, a narrowed model list, or a different reference this sign-in has no business rewriting.

## Configuration

Every field is optional. Add them to the plugin's row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: zai-coding-plan
      name: 'dsh-zai-coding-plan'
      config:
        provider: zai
        credentialRef: ZAI_API_KEY
        redirectUri: zcode://zai-auth/callback
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `zai` | The pi-ai route to configure. A deployment on the mainland endpoint points this at its own route. |
| `credentialRef` | `ZAI_API_KEY` | The reference the minted key is stored under, and the one the route's profile names. |
| `redirectUri` | `zcode://zai-auth/callback` | The redirect to ask Z.AI for. See below. |

## Known limitations

- **These are Z.AI's private endpoints.** The client id, the authorize page, the token body, the redirect allowlist, and the whole business-API sequence mirror Z.AI's own desktop client. Z.AI can change any of them without notice, and has: the loopback redirects this flow was first built against are refused today with `Redirect URI not registered for this client`. `redirectUri` covers the next such move without a release; nothing covers a changed token body or business-API shape.
- **The code is copied by hand.** `zcode://zai-auth/callback` is a scheme no browser hands back to this process. A desktop that registers itself as the `zcode://` handler could capture it instead; this plugin does not, because doing so takes the scheme away from Z.AI's own client for as long as it is registered — and it is worthless when the browser and the harness are not on the same machine.
- **No test reaches Z.AI.** `tests/fake-zai.ts` answers the whole endpoint sequence, so a change on Z.AI's side is found by a human signing in, not by CI. Every failure names the step that broke.
- **Requires the pi-ai adapter.** The route it configures belongs to `@deepseek-ai/dsh-llm-pi-ai`, which ships in `dsh-base`. Without it the credential is stored and the route declaration goes nowhere.

## Development

```bash
npm install --legacy-peer-deps   # published dsh rc packages disagree on peer ranges
npm run typecheck
npm test
npm run build
```

The `--legacy-peer-deps` flag is for the local type install only: these packages are peer dependencies supplied by the host at runtime.

## Credit

The Z.AI protocol — the client id, the endpoint sequence, and the key-provisioning steps — is mirrored from [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi), which reverse-engineered ZCode's desktop sign-in. This plugin is an independent DSH implementation of the same protocol.

## Licence

MIT.
