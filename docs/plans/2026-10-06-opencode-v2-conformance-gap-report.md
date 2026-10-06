# opencode v2 conformance — gap report

Spike: SPIKE-OPENCODE-V2-CONFORMANCE. Input to: "opencode v2 support (v1 + v2 side by side)".
Subject: `src/agent/opencode.ts`. No production code was changed.
Fixtures: `src/agent/__fixtures__/opencode-v2/` (see its README).

## Verdict summary

| # | Area | Verdict |
| --- | --- | --- |
| 1 | Headless `run` flags | **broken** (`--pure`, `--dir`, `--variant` rejected; exit 1) |
| 2 | Headless prompt argument | **broken** (`--` duplicates the prompt; every prompt is wrapped in quotes) |
| 3 | NDJSON shape | **changed** (sessionID, text, error OK; `step_finish` and usage broken) |
| 4 | TUI launch | **broken** (`--model` rejected); `--session`, `--prompt` OK |
| 5 | `karst-bridge.js` loads | **broken** (v1 plugin shape fails to load) |
| 6 | Bridge events and payloads | **changed** (`session.idle`, `session.status`, `session.updated` not seen) |
| 7 | `--pure` disables the bridge | **broken** (no `--pure`; no replacement found) |
| 8 | `OPENCODE_PERMISSION` | **broken** (ignored) |
| 9 | `.opencode/commands/karst-*.md` | **OK** |
| 10 | `opencode agent list` | **broken** (subcommand gone; HTTP API only) |
| 11 | Resume of a v1 session | **OK by id**; hidden from `session list` for non-git dirs |
| 12 | Shared database with v1 | **broken** (v1 cannot open a database v2 has used) |

Evidence level: "live" means observed against the built v2.0.24. "source" means
read from the `v2.0.24` source only. Both are marked per item.

## 0. Install and test setup

- No published v2 binary or npm package exists. npm `latest` is 1.18.34. GitHub
  releases stop at v1.18.x. The `2.0` branch is a stale April snapshot
  (package version 1.4.3), not v2.
- The real v2 is git tag `v2.0.24` (2026-10-06, no GitHub release). Built with
  `bun run script/build.ts --single` using bun 1.4.2 installed under the
  scratchpad (system bun is 1.4.0, the build needs ≥1.4.2). Package: `packages/cli`.
- Isolation: own `XDG_*` dirs and a copied binary. The user's v1
  (`~/.opencode/bin/opencode`, 1.18.32), real data dir and the user's own v2
  service process were not touched.
- Model calls used `opencode-go/mimo-v2.5` through credentials the user entered
  in the isolated v2 store. v1 baseline and v1-session creation used a local mock
  OpenAI-compatible server.
- Test-harness behaviour to know about (not karst gaps, but they cost time):
  - `run` without `--server` spawns `serve --stdio` per call; several of these
    stalled with no output. Running against one long-lived `serve` was reliable.
  - A run in a git repo can take 60 s or more: the server fires hundreds of
    `git add/diff-files/ls-files/write-tree` calls (snapshots), roughly one
    every 13 ms. Plain text turns took 5–7 s.
  - `run --format json` output reached the file late in several runs.

## 1. Headless `run` flags — broken (live)

karst builds: `run --format json --pure --dir <cwd> [--auto] [--model m] [--variant v] [--session id] -- <prompt>`.

| Flag | v2.0.24 | Evidence |
| --- | --- | --- |
| `--format json` | OK | |
| `--pure` | **rejected** | `Unrecognized flag: --pure in command opencode run`, exit 1 |
| `--dir` | **rejected** | `run` help lists no such flag; run uses its cwd |
| `--variant` | **rejected** | variant is now part of the model: `--model provider/model#variant` |
| `--model` | OK, syntax extended | `--model opencode-go/mimo-v2.5#high` parsed; unknown variant gives `{"type":"error",…,"error":{"type":"provider.no-route","message":"Variant unavailable for opencode-go/mimo-v2.5: high"}}` |
| `--session` | OK, semantics changed | "Session ID to continue, **or to create if it does not exist**". A stale id silently starts a new session. |
| `--auto` | accepted | "Auto-approve permissions that are not explicitly denied" |
| `--agent` | accepted | listed in `run --help` (not exercised) |
| `--standalone`, `--server URL` | new | default is a shared background service |

Changes needed:
- Drop `--pure` and `--dir` for v2. Pin the working directory with the spawn
  `cwd` (karst already passes it).
- Fold `effort` into `--model <model>#<effort>`.
- Decide what a stale resume id should do. v2 will not fail.
- Choose `--standalone` or a karst-owned server. A bare `run` talks to the
  background service, so per-run env (`OPENCODE_PERMISSION`, config) does not
  reach it.
- The old note about `--dir` and nested worktrees (1.18.18) is untested on v2.

## 2. Headless prompt argument — broken (live)

v2 stores each argument wrapped in literal double quotes.

- `run … "reply with exactly: ok"` → user message `"reply with exactly: ok"`.
- `run … -- "say hi"` (karst's form) → user message `"say hi" "say hi"`:
  the prompt is duplicated.
- `run … -- "--- yaml --- say ok"` → `"--- yaml --- say ok" "--- yaml --- say ok"`.

Models mostly cope, but multi-line seeds, YAML frontmatter and exact-output
prompts are changed. Changes needed: for v2 pass the prompt without `--` (or
test `--` plus no positional) and verify the stored text equals the input.
This needs an upstream bug check. It may be fixed later than 2.0.24.

## 3. NDJSON shape — changed (live)

Matches the parser:
- top-level `sessionID` on every event.
- `{"type":"text","part":{"type":"text","text":…}}`.
- `{"type":"error",…}` with `error.type` and `error.message`
  (new `timestamp`; `parseOpencodeJsonl` throws on it, as before).

Breaks the parser:
- **`step_finish` is emitted only for tool-call steps.** A text-only turn has no
  `step_finish` at all (`run-text.ndjson`); the final text step of a tool turn
  has none either (`run-tool-auto.ndjson`). v1 always ended with one
  (`v1-baseline-run-text.ndjson`).
- `tokens` has no `total`: `{input, output, reasoning, cache:{read,write}}`.
  The adapter already sums when `total` is missing, so that part is fine.
- The values are per step. The parser keeps the last `step_finish`, so v2 gives
  `usage` undefined for text-only turns and only the tool step for tool turns.
- Tool name is `shell` (v1: `bash`). `tool_use.part.state` has `status`, `input`,
  `output`.

Cumulative usage in v2 is at `info.tokens` of `opencode session export <id>`
(`session-export.json`), and in the `session.usage.updated` event (item 6).

Changes needed: stop reading usage from `step_finish`. Either sum
`step_finish` and add the missing last step, or read the cumulative session
total after the run. Add a fixture-driven test per file in the fixtures dir.

## 4. TUI launch — broken (live)

karst builds: `opencode [--session id] [--model m] [extra…] [--prompt p]`.

- `--session`, `--prompt`: accepted (TUI starts; alarm ended it after 10 s).
- `--model`: `Unrecognized flag: --model in command opencode`, exit 1.
- `--variant`, `--pure`: also rejected (karst already drops `--variant`).
- New top-level flags: `--auto`, `--continue`, `--standalone`, `--server`.

Changes needed: stop passing `--model` to v2. Model preselection by config is
the likely replacement (v2 config has a top-level `model`), not verified in the
TUI. A full interactive launch was not exercised (no TTY here).

## 5. Bridge plugin load — broken (live)

v1 shape: `export const KarstBridge = async ({directory, worktree}) => ({event})`.

Server log: `loading plugin … .opencode/plugins/karst-bridge.js`, then
`failed to load plugin … Plugin must export a default definition with an id and
an effect or setup function. (SchemaError(Missing key ["default"]))`.

So path auto-discovery still works, but the module contract changed:
`export default { id, setup(ctx) { … } }`. A v2-shaped probe loaded; its
context has `event`, `session`, `permission`, `location`, `worktree`, `shell`, etc.

Changes needed: a second generated bridge for v2 (`export default {id, setup}`
reading `ctx.event.subscribe()`), selected by detected version.

## 6. Bridge events and payloads — changed (live unless noted)

Events arrive as `{id, created, type, durable?, location?, data}`. The payload
is under **`data`**, not `properties`. `sessionID` is flat in `data`.

| Bridge uses | v2 |
| --- | --- |
| `session.created` | present. `data.sessionID`, `projectID`, `location`. Flat id; not nested in `info`. |
| `session.idle` | **not observed** (in schema). Use `session.execution.succeeded`. |
| `session.status` busy/retry | **not observed** (in schema). Use `session.execution.started`; `session.retry.scheduled` in schema. |
| `session.error` | in schema; not triggered. Also `session.execution.failed`, `session.execution.interrupted` (source). |
| `session.updated` (tokens) | **not observed**. Use `session.usage.updated`: `data.tokens` = `{input, output, reasoning, cache:{read,write}}`, cumulative (553/76/47 after one step), no `total`. |
| `permission.asked` / `.replied` | in schema (`id`, `sessionID`, `action`, `resources`); not triggered live. |
| `question.asked` / `.replied` | **no match found in the schema** (source grep). Unverified. |

`extractUsage` already falls back to `input.tokens`, so with `data` as the
payload it can read `session.usage.updated`. `extractSessionId` reads
`properties`; it must read `data`.

Changes needed: map `session.execution.started` → busy, `session.execution.*`
end events → idle/failed, `session.usage.updated` → usage, read `event.data`.
Trigger a real permission ask on v2 (an `ask` rule) before trusting item
`permission.*`.

## 7. `--pure` — broken (live for the flag, source for the rest)

The flag does not exist, so a headless run cannot be isolated from plugins by
flag. Headless runs in the worktree would load the bridge and post events for
gate sessions. The `OPENCODE_PURE` equivalent was not found in the source.
Changes needed: a v2 way to keep gate runs from firing the bridge (for
example a bridge that checks a per-session marker), or run gates from a
directory without the plugin. Needs a decision.

## 8. `OPENCODE_PERMISSION` — broken (live + source)

- Live: server started with `OPENCODE_PERMISSION={"bash":"deny","edit":"deny"}`;
  `echo karst-envperm` ran and returned its output.
- Source: no code reads the variable. It remains only in ported docs.
- v2 config key is `permissions`, an ordered array of
  `{action, resource, effect: allow|deny|ask}`; the **last matching rule wins**.
  Known actions: `edit`, `external_directory`, `question`. The shell action name
  was not confirmed (tool is `shell`).
- `OPENCODE_CONFIG_CONTENT` (inline JSON config) is read by core and is passed
  to the server process.
- A live test of `OPENCODE_CONFIG_CONTENT` with `permissions` deny rules was
  inconclusive (the run did not finish in time). **Not verified** that it blocks
  shell, or that it wins over a project `opencode.json`.
- A plain `echo` ran without a prompt and without `--auto`.

Changes needed: for v2, express planning mode as a `permissions` ruleset
(`edit` deny, `external_directory` rules for add-dirs) in `OPENCODE_CONFIG_CONTENT`,
and verify live that shell is denied or asked. Note the env reaches only a
server karst starts itself.

## 9. Commands — OK (live)

`.opencode/commands/karst-probe.md` appears in `command.list`
(`init`, `review`, `karst-probe`). Nothing to change.

## 10. `opencode agent list` — broken (live)

No `agent` subcommand. The API works: `agent.list` returned `Build`, `General`,
`Explore`, `Compaction`, `Title`, `Summary`, `Plan`. Names are display names
(v1 ids were `build`, `plan`). `.opencode/agents/*.md` discovery was not tested.

## 11. Resume of a v1 session — OK by id (live)

Created with v1.18.32 in a non-git dir and in a git repo (shared fresh data dir),
then opened by v2:
- `session list` in the git repo shows the v1 session (migrated).
- `session list` in the non-git dir is **empty** (upstream #53450 confirmed).
- `run --session <v1 id>` finds both sessions, in the original dir and in another
  dir. The non-git one resolves by id.
- Side effect: a resume with a bad model rewrote the stored model of the session
  (`nonexistent/x`).

karst resumes by id, never by list, so this is OK. Add a test that resumes a
v1 id on v2.

## 12. Shared database — broken (live + source)

After v2 touched a data dir, v1 refused to run in it:
`Database is not empty and has no session table`. On the `latest`, `dev`,
`beta`, `next` and `prod` channels v2 uses `opencode.db`, the same file as v1,
and has a built-in v1 migration. A v1 and v2 pair on one `XDG_DATA_HOME`
corrupts v1.

Changes needed: when both versions are installed, give v2 its own data dir or
`OPENCODE_DB`, and never run v2 against the user's real v1 data dir.

## Not verified

- A real `permission.asked` / `.replied` event, and `question.*`.
- Planning permissions through `OPENCODE_CONFIG_CONTENT` (item 8).
- A full TUI session, and TUI model preselection by config.
- `.opencode/agents/*.md` discovery and `--agent`.
- The 60 s+ git snapshot loop is observed, not diagnosed. It may be specific to
  scratch dirs in `/private/tmp`.
- Only 2.0.24 was tested. v2 changes daily.
