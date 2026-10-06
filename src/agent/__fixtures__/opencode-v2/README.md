# opencode v2 fixtures

Real output from opencode **v2.0.24** (built from git tag `v2.0.24` of
`anomalyco/opencode`, darwin-arm64), recorded 2026-10-06 for
SPIKE-OPENCODE-V2-CONFORMANCE. Model: `opencode-go/mimo-v2.5`.
Local paths are replaced with `<scratch>`. See
`docs/plans/2026-10-06-opencode-v2-conformance-gap-report.md`.

| File | What it shows |
| --- | --- |
| `run-text.ndjson`, `run-text-2.ndjson` | Text-only turn: `step_start`, `text`. No `step_finish`. |
| `run-tool-auto.ndjson` | Tool turn with `--auto`: `step_start`, `tool_use` (tool `shell`), `step_finish` (per-step tokens, no `total`), `step_start`, `text`. |
| `run-tool-noauto.ndjson` | Same turn without `--auto`. A plain `echo` runs without a prompt. |
| `run-error-variant-unavailable.ndjson` | `--model provider/model#variant` with an unknown variant. |
| `run-error-provider-auth.ndjson` | Provider 401: `error.type: "provider.auth"`. |
| `run-no-dashdash-quoted-prompt.ndjson`, `run-dashdash-duplicated-prompt.ndjson` | Streams for the prompt-mangling runs. The mangling is visible in the session, not the stream. |
| `session-export.json` | `opencode session export`: cumulative `info.tokens` (no `total`), per-message tokens, `"say hi" "say hi"` user text. |
| `plugin-events.ndjson` | Events a v2-shaped plugin received through `ctx.event.subscribe()`. Catalog `*.updated` events and text/reasoning deltas are removed. |
| `v1-baseline-run-text.ndjson` | v1.18.32 for comparison. It ends with `step_finish`. |

The stream files are NOT run through `parseOpencodeJsonl` here. No test
consumes them yet. The follow-up ticket should add the conformance tests.
