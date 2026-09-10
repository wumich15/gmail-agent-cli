# Development

## Project layout

| Path | Contents |
| --- | --- |
| `src/cli.ts` | Public command registration and help. |
| `src/commands/` | Command handlers; some older handlers are not exposed. |
| `src/core/` | Orchestration, policy, action planning, locks, retries. |
| `src/auth/`, `src/config/` | Google OAuth, credentials, configuration. |
| `src/gmail/`, `src/calendar/` | Mail and Calendar service adapters and operations. |
| `src/ai/`, `src/rules/` | Classification, drafting, deterministic rules. |
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

`pnpm test:integration` is reserved for a future integration suite; its configured `tests/integration/` directory is currently absent, so the command reports no tests. For source-mode help, run `pnpm dev --help`. Build before inspecting `node dist/cli.js --help` so it reflects current source. `src/cli.ts` defines which handlers are exposed to users.

## Configuration

Setup creates `config.json` in the platform data directory listed in the README. Edit only non-secret settings there. The schema is strict; unknown properties are rejected. Quit active runs before editing. There is no exposed `gmail config` command.

| Setting or environment variable | Behavior |
| --- | --- |
| `GMAIL_AGENT_OAUTH_CLIENT_ID`, `GMAIL_AGENT_OAUTH_CLIENT_SECRET` | Desktop OAuth configuration needed for each authenticated development run. |
| `OPENAI_API_KEY` | AI credential fallback after OS credential lookup; key presence activates AI. |
| `timezone` | IANA timezone confirmed during setup. |
| `model`, `composeModel` | Separate models for classification and drafting. |
| `GMAIL_AGENT_MODEL`, `GMAIL_AGENT_COMPOSE_MODEL` | Live overrides of saved model names. |
| `aiProvider` | `openai` or `openai-compatible`. |
| `aiBaseUrl` | Required when using `openai-compatible`. |
| `GMAIL_AGENT_AI_PROVIDER`, `GMAIL_AGENT_AI_BASE_URL` | Seed a newly created config; do not override an existing file on every run. |
| `concurrency` | Defaults: `gmailReads: 8`, `aiCalls: 5`, `calendarWrites: 2`. Parallelism does not increase quota. |
| `aiEnabled`, `automationEnabled` | Legacy fields; do not rely on them as operational off switches for the public CLI. |
| `GMAIL_AGENT_RATE_LIMIT_RPS` | Advanced read-equivalent rate override for a verified quota. |

For an existing configuration, change `aiProvider` and `aiBaseUrl` in the file to switch endpoints. Both AI paths still require a key and compatible Responses API support; Chat Completions compatibility alone is insufficient. Finish Google setup before enabling AI and start a new command after configuring an endpoint: the first sign-in process does not reload the config it just created. Remove AI credentials to avoid AI calls; use root `--dry-run` to preview cleanup.

The process does not load `.env` automatically. Keep real credentials, local state, and logs outside Git.

## Gmail performance

The implementation uses Gmail history for incremental work, reusable cached assessments, gzip/partial-response fields, concurrent individual reads, grouped local commits, and grouped label changes. Cache snapshots do not pre-classify mail: the first AI cleanup can still need fresh reads and assessments. Expired history can require a full rescan.

The shared limiter targets **275 message-read equivalents per minute** within a rolling budget. This is a pacing target, not a latency guarantee or Google's universal quota. Retry and auxiliary calls also consume budget. Work and cache default to eight concurrent reads. The old `GMAIL_AGENT_BATCH_HYDRATION` and `GMAIL_AGENT_BATCH_SIZE` variables no longer select multipart read batching.

Google's current limits differ for new and previously active projects. New-project defaults include 6,000 units per minute per user per project; `messages.get` costs 20 units. Verify the actual Cloud Console allocation before changing pacing. Keys in the same project share quota, and Google prohibits using extra projects to circumvent limits. See [Gmail usage limits](https://developers.google.com/workspace/gmail/api/reference/quota), [API key project association](https://docs.cloud.google.com/docs/authentication/api-keys), and [API Terms §2(d)](https://developers.google.com/terms).

Measure full scans, incremental scans, retries, and auxiliary calls separately. Prefer reducing duplicate calls, maintaining history checkpoints, and honoring backoff before raising concurrency. Partial responses reduce bandwidth but do not change a method's documented quota-unit cost. See Google's [performance guidance](https://developers.google.com/workspace/gmail/api/guides/performance) and [sync guidance](https://developers.google.com/workspace/gmail/api/guides/sync).

## Documentation maintenance

Update Commander help, the [command reference](commands.md), and README examples together when commands change. Public setup must not depend on ignored notes. The planned browser front-end should render the maintained reference rather than introduce an independent copy.
