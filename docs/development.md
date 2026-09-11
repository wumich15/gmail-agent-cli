# Development

## Project layout

| Path | Contents |
| --- | --- |
| `src/cli.ts` | Public command registration and help. |
| `src/commands/` | Command handlers; some older handlers are not exposed. |
| `src/core/` | Orchestration, policy, action planning, locks, retries. |
| `src/auth/`, `src/config/` | Google OAuth, credentials, configuration. |
| `src/gmail/`, `src/calendar/` | Mail and Calendar service adapters and operations. |
| `src/ai/`, `src/rules/` | Hosted classification and drafting plus deterministic rules. |
| `src/gateway/` | Publisher-operated GPT gateway: Google identity verification, request restrictions, quotas, and server-side OpenAI access. |
| `src/ui/`, `src/docs/` | The loopback browser front-end (`gmail ui`) and the shared command reference that terminal help and the web Commands view both render. |
| `src/state/`, `src/summary/`, `src/logging/` | SQLite state, reporting, diagnostics. |
| `src/unsubscribe/` | Unsubscribe support used by older handlers. |
| `tests/` | Unit/integration checks and helpers. |
| `evals/` | Placeholder evaluation runner, not a completed quality benchmark. |
| `docs/` | Public documentation and archived design material. |
| `dist/`, `node_modules/` | Generated output and dependencies; ignored. |

User setup should not depend on local internal planning notes. Consult current source and tests when archived design descriptions disagree with behavior.

## Build and validate

Use Node.js 22.19 or newer and pnpm. The Node minimum reflects the locked `undici` dependency. Native bindings may need platform build tools.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

With `OPENAI_API_KEY` set, `pnpm test:gpt` makes two `store:false` calls using synthetic mail only: one through the production classifier and one through the production drafting path. It uses `GMAIL_AGENT_MODEL` and `GMAIL_AGENT_COMPOSE_MODEL` when set, otherwise the app defaults. This is the opt-in live GPT check; the normal unit suite never spends API credits or sends content off-device.

`pnpm test:integration` is reserved for a future integration suite; its configured `tests/integration/` directory is currently absent, so the command reports no tests. For source-mode help, run `pnpm dev --help`. Build before inspecting `node dist/cli.js --help` so it reflects current source. `src/cli.ts` defines which handlers are exposed to users.

## Configuration

Setup creates `config.json` in the platform data directory listed in the README. Edit only non-secret settings there. The schema is strict; unknown properties are rejected. Quit active runs before editing. There is no exposed `gmail config` command.

| Setting or environment variable | Behavior |
| --- | --- |
| `GMAIL_AGENT_OAUTH_CLIENT_ID`, `GMAIL_AGENT_OAUTH_CLIENT_SECRET` | Desktop OAuth configuration needed for each authenticated development run. |
| `GMAIL_AGENT_AI_GATEWAY_URL` | Development override for the included GPT gateway. HTTPS required except on loopback. |
| `OPENAI_API_KEY` | AI credential fallback after OS credential lookup, for headless use. Only consulted for a hosted provider. |
| `timezone` | IANA timezone confirmed during setup. |
| `model`, `composeModel` | Separate models for classification and drafting. |
| `GMAIL_AGENT_MODEL`, `GMAIL_AGENT_COMPOSE_MODEL` | Live overrides of saved model names. |
| `aiProvider` | `managed`, `openai`, or `openai-compatible`. |
| `aiBaseUrl` | Required for `openai-compatible`; ignored for `managed` and `openai`. |
| `GMAIL_AGENT_AI_PROVIDER`, `GMAIL_AGENT_AI_BASE_URL` | Seed a newly created config; do not override an existing file on every run. |
| `concurrency` | Defaults: `gmailReads: 8`, `aiCalls: 5`, `calendarWrites: 2`. Parallelism does not increase quota. |
| `aiEnabled` | A real off switch: false means no classification or drafting call is made, whatever credentials exist. Set it through `gmail setup`. |
| `automationEnabled` | Legacy field; not an operational off switch. |
| `schemaVersion` | `3`. A `1` file records its effective legacy AI state; a `2` file using the former local provider moves to Included GPT and discards incompatible local settings. Migrated files are rewritten in place. |
| `GMAIL_AGENT_RATE_LIMIT_RPS` | Advanced read-equivalent rate override for a verified quota. |

Prefer `gmail setup` over editing the file: it writes the same fields and validates them. Hand-editing still works for advanced cases.

`managed` authenticates the signed-in user to the publisher gateway with a short-lived Google ID token; it never sends the gateway a Gmail access or refresh token. `openai` and `openai-compatible` are development/advanced paths that require a user key and a Responses API endpoint with Structured Outputs; Chat Completions compatibility alone is insufficient. Production users do not install a local model runtime.

Config written during sign-in is reloaded into the running process (`core/bootstrap.ts`'s `reloadConfig`), so a provider chosen during first-run setup takes effect in that same run rather than the next one.

The process does not load `.env` automatically. Keep real credentials, local state, and logs outside Git.

## Gmail performance

The implementation uses Gmail history for incremental work, a cache-first path that skips history discovery entirely while the local cache is fresh, reusable cached assessments, a persisted reply-protection Sent-thread index (`sent_threads`, topped up rather than rebuilt), gzip/partial-response fields, concurrent individual reads, grouped local commits, and grouped label changes.

If a run seems to stall *after* reading finishes, the phase to suspect is reply protection: the Sent index gates every Trash action, and building it from scratch pages the whole `SENT` label. That is a one-time cost per account now; a run that pays it says so on stderr. Cache snapshots do not pre-classify mail: the first AI cleanup can still need fresh reads and assessments. Expired history can require a full rescan.

The shared limiter targets **275 message-read equivalents per minute** within a rolling budget. This is a pacing target, not a latency guarantee or Google's universal quota. Retry and auxiliary calls also consume budget. Work and cache default to eight concurrent reads. The old `GMAIL_AGENT_BATCH_HYDRATION` and `GMAIL_AGENT_BATCH_SIZE` variables no longer select multipart read batching.

Google's current limits differ for new and previously active projects. New-project defaults include 6,000 units per minute per user per project; `messages.get` costs 20 units. Verify the actual Cloud Console allocation before changing pacing. Keys in the same project share quota, and Google prohibits using extra projects to circumvent limits. See [Gmail usage limits](https://developers.google.com/workspace/gmail/api/reference/quota), [API key project association](https://docs.cloud.google.com/docs/authentication/api-keys), and [API Terms §2(d)](https://developers.google.com/terms).

Measure full scans, incremental scans, retries, and auxiliary calls separately. Prefer reducing duplicate calls, maintaining history checkpoints, and honoring backoff before raising concurrency. Partial responses reduce bandwidth but do not change a method's documented quota-unit cost. See Google's [performance guidance](https://developers.google.com/workspace/gmail/api/guides/performance) and [sync guidance](https://developers.google.com/workspace/gmail/api/guides/sync).

## Documentation maintenance

`src/docs/command-reference.ts` is the single source for command documentation: `gmail help`, `gmail help <command>`, and the `gmail ui` Commands view all render it, and `tests/unit/command-reference.test.ts` fails if it stops matching the commands registered in `src/cli.ts` or the commands listed in [commands.md](commands.md). Adding a command therefore means editing `src/cli.ts` and that reference together; the prose in `commands.md` and README examples still need updating by hand.

Public setup must not depend on ignored local notes.
