# opencode2 (v2.0.24) live verification

Spike: **SPIKE-OPENCODE2-V2-0-24-LIVE**. First of four opencode2 tickets; blocks
"opencode2 core: plumbing", "opencode2 bridge + interactive session",
"opencode2 permissions + instructions". No production code was changed.

Input: `docs/plans/2026-10-06-opencode-v2-conformance-gap-report.md` and
`src/agent/__fixtures__/opencode-v2/` (spike SPIKE-OPENCODE-V2-CONFORMANCE).
That report's "section 0" wrongly claims v2 is unpublished; v2 **is** published
(see install). Everything below is **live**, observed against the published
`@opencode/cli@2.0.24` on darwin-arm64, 2026-10-06. Where a claim comes from the
binary's strings rather than a run it is marked `source`.

## Verdict summary

| # | Item | Verdict |
| --- | --- | --- |
| 1 | `--standalone` reliability (>=10 TUI + >=10 headless) | **PASS**, with a latency tail (TUI first token can exceed 8 s; 20 s window was 10/10) |
| 2 | `OPENCODE_CONFIG_CONTENT` permissions | **PASS** (config key is `permission`, singular object; shell action is `shell`, config key `bash`; last-match-wins; CC wins over project) |
| 3 | `instructions: [<file>]` | **FAIL for the config key** (ignored); **PASS via `AGENTS.md`** (reaches prompt, base retained, resume re-reads) |
| 4 | top-level `model: provider/model#effort` preselects TUI | **PASS** |
| 5 | Prompt delivery byte-identical | **only `stdin` is byte-identical**; positional/`--`/`--file` are not; TUI slash command runs with newlines kept |
| 6 | `.opencode/agents/*.md` + `--agent` | **PASS** |
| 7 | `permission.asked`/`.replied`; `question.*` | `permission.*` **PASS** (live); **no `question.*`** — questions use a `form.*` subsystem |
| 8 | Bridge `setup()` sees `KARST_OPENCODE_HEADLESS` under `--standalone` | **PASS** |
| 9 | `session export <id>` existing vs missing | existing exit 0 + JSON; missing exit 1 + stderr; cumulative usage at `info.tokens` |
| 10 | Slow git-snapshot loop | **characterized**: per-step shadow-git snapshots under the data dir; `snapshot:false` removes them. The 60 s figure did not reproduce; a second cost is the ancestor file-watcher |

## 0. Install, isolation, harness

### Install (isolated prefix)

```
$ mkdir -p <scratch>/v2 && cd <scratch>/v2 && npm init -y
$ npm install @opencode/cli@2.0.24
added 2 packages, and audited 3 packages in 5s
$ <scratch>/v2/node_modules/.bin/opencode2 --version
opencode v2.0.24
```

`npm view @opencode/cli@2.0.24` reports `bin = { opencode: 'bin/opencode.exe',
opencode2: 'bin/opencode.exe' }` — the package ships an **`opencode2` alias** in
addition to `opencode`, which is the clean way to avoid the v1 `opencode` on
`PATH`. The launcher is a Mach-O arm64 binary (`file` → `Mach-O 64-bit
executable arm64`).

Isolation environment (every command below ran with these, sourced from
`<scratch>/lib.sh`):

```
XDG_CONFIG_HOME=<scratch>/xdg/config
XDG_DATA_HOME=<scratch>/xdg/data        # opencode.db lives here, never the user's
XDG_CACHE_HOME=<scratch>/xdg/cache
XDG_STATE_HOME=<scratch>/xdg/state
OPENCODE_DISABLE_AUTOUPDATE=1
OPENCODE_API_KEY=<user's opencode-go key>   # see providers, below
```

The user's v1 (`~/.opencode/bin/opencode` 1.18.32), its 19.9 GB
`~/.local/share/opencode/opencode.db` and the user's own v2 service were never
touched. Only `~/.local/share/opencode/auth.json` was **read** (to source the
`opencode-go` key into `OPENCODE_API_KEY` and to copy auth into the isolated
store).

### Providers (why `OPENCODE_API_KEY` and not the auth file)

v2 auto-loads providers from `https://models.dev`. `opencode-go` declares
`env: ["OPENCODE_API_KEY"]`; the copied `auth.json` alone did **not** enable it.
With the env var set, `opencode-go/*` resolves and runs; without it,
`opencode-go/mimo-v2.5` → `provider.no-route: Model unavailable`. Live catalog
(34 `opencode-go` models, 13 with `#effort` variants) was read from
`GET /api/model`. Models used: `opencode-go/mimo-v2.5` (chat) and
`opencode-go/deepseek-v4.1-flash` (fast tool turns).

### `--standalone` is mandatory

A bare invocation (no `--standalone`) tries the shared background service and
collides with an already-running service:

```
Error: Managed service port 49374 on 127.0.0.1 is already in use by another process.
Configure another port with `opencode service set port <port>` and start the service again.
```

Also, per-spawn env (`OPENCODE_API_KEY`, `OPENCODE_CONFIG_CONTENT`,
`KARST_OPENCODE_HEADLESS`) only reaches a server **karst starts itself**. Every
verification run therefore passed `--standalone`.

## 1. `--standalone` reliability

Exact argv (headless): `opencode2 run --standalone --format json --model
opencode-go/mimo-v2.5 "reply with exactly: ok"`.
Exact argv (TUI): `opencode2 --standalone --prompt "reply with exactly: tui-ok"`
under a PTY (200x50), Ctrl-C after the turn.

- **Headless: 10/10**, exit 0, assistant text exactly `ok`.

  ```
  run 1  rc=0 dur=4.56s TEXT-OK      run 6  rc=0 dur=2.82s TEXT-OK
  run 2  rc=0 dur=4.07s TEXT-OK      run 7  rc=0 dur=2.77s TEXT-OK
  run 3  rc=0 dur=3.66s TEXT-OK      run 8  rc=0 dur=3.64s TEXT-OK
  run 4  rc=0 dur=3.72s TEXT-OK      run 9  rc=0 dur=3.41s TEXT-OK
  run 5  rc=0 dur=4.69s TEXT-OK      run 10 rc=0 dur=3.65s TEXT-OK
  ```

- **TUI: 10/10** (assistant `session.text.ended.text == "tui-ok"` and
  `session.execution.succeeded` present in the bridge event stream). Timing
  caveat: at an **8 s** window only **5/10** had started the model step; at
  **20 s** all 10 completed. So the failures were latency, not stalls — but the
  first-token tail is real and worth a generous timeout.

- **Per-spawn env reaches the engine and its plugins.** The plugin `setup()`
  observed `OPENCODE_API_KEY` (engine auth worked) and, with
  `KARST_OPENCODE_HEADLESS=1 KARST_PROBE=envprobe` in the spawn env, received
  both (see item 8 / `live-plugin-setup.json`).

## 2. `OPENCODE_CONFIG_CONTENT` permissions

**Correction to the gap report.** The v2 config key is **`permission`**
(singular, an object keyed by action, each value `allow|deny|ask` or a
`{pattern: action}` map). The ordered array `{action,resource,effect}` is the
*resolved internal* form surfaced by `GET /api/agent` and by the plugin
context — not the input shape. The shell action name is **`shell`** internally;
the config key is **`bash`** (confirmed by `"bash","shell"` in the binary's
alias map and by the resolved rules). This corrects the report's "ordered array
of `{action, resource, effect}`" and its guess that the shell action might be
`shell` — the config side is `bash`.

Live resolution via `GET /api/agent` (`project` dir with `opencode.json`):

```
# A: project opencode.json  { "permission": { "bash": "allow", "edit": "allow" } }
  {"action":"shell","resource":"*","effect":"allow"}
  {"action":"edit","resource":"*","effect":"allow"}
  {"action":"browser","resource":"*","effect":"deny"}

# B: same project + OPENCODE_CONFIG_CONTENT
#    { "permission": { "bash": "deny", "edit": "ask" } }
  {"action":"shell","resource":"*","effect":"allow"}     # from project
  {"action":"edit","resource":"*","effect":"allow"}      # from project
  {"action":"shell","resource":"*","effect":"deny"}      # CC appended AFTER
  {"action":"edit","resource":"*","effect":"ask"}        # CC appended AFTER
  {"action":"browser","resource":"*","effect":"deny"}
```

Because the rule list is ordered and **last matching rule wins**, the
`OPENCODE_CONFIG_CONTENT` rules override the project `opencode.json`. (Full
array in `live-agent-permissions-resolved.json`.)

Live behavioural results:

- **edit deny refuses a file edit.** With `{"permission":{"edit":"deny"}}` the
  `write` tool is removed from the model's catalog. With `edit` and `bash` both
  denied, a "create probe.txt" prompt produced **no file** and the model
  answered: *"I don't have a file-writing tool available…"*. (With `edit` denied
  but `bash` allowed, the model fell back to `shell printf > probe.txt` — deny
  `edit` alone is not a write barrier.)
- **shell deny / ask.** Config key `bash`. `bash:"ask"` emitted a real
  `permission.asked` with `action:"shell"` (item 7); in a non-interactive
  `run` it is auto-rejected (`stderr: "! permission requested: shell (…);
  auto-rejecting"`). `bash:"deny"` removes the shell tool (model reports no
  shell; one model looped and had to be killed — model-dependent).
- **`external_directory` allow works for add-dirs.** Default is `ask`; with no
  `--auto` the read of a file outside the cwd emitted `permission.asked`
  `action:"external_directory"` and was rejected. Adding
  `{"permission":{"external_directory":{"<dir>/**":"allow"}}}` made the read
  succeed (content returned verbatim).
- **Ruleset wins over a project `opencode.json`** — proven by the resolved
  ordering above.

Note `--auto` means "auto-approve permissions that are not explicitly denied",
so it converts every `ask` to `allow`; it does not weaken `deny`.

## 3. `instructions: [<file>]`

**The config key is ignored.** `OPENCODE_CONFIG_CONTENT` and the global
`$XDG_CONFIG_HOME/opencode/opencode.json` were both tried with
`instructions: [<abs path>]`, `["directive.md"]` and `["**/directive.md"]`. In
every case the model replied `NONE` to "output the secret instruction token",
and `session.instructions.updated` carried only the base keys
(`core/codemode`, `core/skill-guidance`, `core/date`, `core/environment`) — no
entry for the file.

**The working channel is a project `AGENTS.md`.** With `AGENTS.md` in the cwd:

- content reaches the system prompt: a directive `ALWAYS begin every reply with
  the exact token ZZAGENTS-OK` was obeyed (`ZZAGENTS-OK Hello! …`);
- the base prompt is retained (normal behaviour, tools available, and the
  `core/*` instruction set is unchanged in `session.instructions.updated`);
- **resume re-reads a regenerated file**: session created with `AGENTS.md`
  containing `ZZA-111` replied `ZZA-111 Hello!`; the file was then rewritten to
  `ZZB-222` and `run --session <id>` replied `ZZB-222 Hello again!`.

Implication for the "permissions + instructions" ticket: express per-ticket
instructions as `AGENTS.md` (or the project instruction file v2 actually
reads), not as a `instructions` config entry.

## 4. top-level `model: provider/model#effort` preselects the TUI

Global config `{ "model": "opencode-go/space-bunny#high" }`, launched as
`opencode2 --standalone --prompt "reply with exactly: model-check"` under a PTY.
The session's model step carried the variant:

```
session.step.started data.model =
  {"id":"space-bunny","providerID":"opencode-go","variant":"high"}
session.text.ended text = "model-check"
```

So config preselection includes the `#effort` variant. (`opencode-go` variant
sets were read from `GET /api/model`; e.g. `space-bunny` =
low/medium/high/xhigh/max, `deepseek-v4.1-flash` = low/high/max.)

## 5. Prompt delivery byte-identical

Input P (35 bytes): `first line\nsecond line "quoted"  double-space\nthird`.
The stored user text was read from the bridge event
`session.inbox.enqueued.data.item.payload.text`.

| Path | argv | stored text | byte-identical |
| --- | --- | --- | --- |
| positional, no `--` | `run … "<P>"` | `"first line\nsecond line \"quoted\"  double-space\nthird"` (wrapped in literal `"`; inner `"` escaped) | **no** |
| positional with `--` (karst's current form) | `run … -- "<P>"` | the quoted string **twice** (duplicated) | **no** |
| **stdin** | `run … < P` (no message positional) | `first line\nsecond line "quoted"  double-space\nthird` | **yes** |
| `--file` | `run … --file P "summarize the attached file"` | `"summarize the attached file"\n\n<file name="P.txt">\n<P>\n</file>` | **no** |
| TUI `--prompt` slash command | `opencode2 --standalone --prompt "/karst-probe argone\nbody line two\nbody line three"` | `KARST-PROBE-COMMAND-EXECUTED\nArguments received: [argone\nbody line two\nbody line three]` | n/a (command expanded) |

Findings: **`stdin` is the only byte-identical headless path.** Positional
prompts are wrapped in literal double quotes (the report's mangling, still
present in 2.0.24); `--` *duplicates* the prompt; `--file` quotes the text and
inlines a `<file>` block. The TUI `--prompt` slash command **runs**: the command
template was substituted, `$ARGUMENTS` received everything after the command
name, and newlines in the multi-line argument were preserved. Fixture:
`live-prompt-delivery.json`.

## 6. `.opencode/agents/*.md` and `--agent`

Created `.opencode/agents/probe-agent.md` (frontmatter `mode: primary`,
`model: …`, body "Always begin every reply with the literal token
PROBE-AGENT-OK"). Run:
`opencode2 run --standalone --auto --format json --model opencode-go/mimo-v2.5
--agent probe-agent "Say hello."` →

```
session.step.started data.agent = "probe-agent"
session.text.ended  text = "PROBE-AGENT-OK\n\nHello! 👋 Karst probe agent here…"
```

Discovery path `agents/` (plural) works, `--agent <id>` selects it, and the
agent's body instruction is applied. (The report's "discovery not tested" is now
answered.) `opencode debug agents` cannot be used headlessly here because it
attaches to the shared service; use `GET /api/agent` on a `--standalone` server.

## 7. `permission.asked` / `.replied` and `question.*`

Real events captured live, both from an `ask` rule:

```
{"type":"permission.asked","data":{"id":"per_…","sessionID":"ses_…",
 "action":"shell","resources":["echo karst-ask-probe"],"save":["echo *"],
 "source":{"type":"tool","messageID":"msg_…","id":"call_…"}}}
{"type":"permission.replied","data":{"sessionID":"ses_…",
 "requestID":"per_…","reply":"reject"}}

{"type":"permission.asked","data":{"…","action":"external_directory",
 "resources":["<scratch>/outside/*"],"save":["<scratch>/outside/*"], …}}
{"type":"permission.replied","data":{"…","reply":"reject"}}
```

In a non-interactive `run`, the request is auto-rejected ("This non-interactive
run cannot ask the user for permission"), the tool fails
(`session.tool.failed`), and the run finishes (exit 0). The plugin context also
exposes `ctx.permission = { hook, list, get, reply }`, so a bridge can answer
requests programmatically. Fixture: `live-permission-events.ndjson`.

**No `question.*` events exist.** `strings` on the binary shows
`permission.asked`, `permission.replied`, `permission.rejected`,
`form.created`, `form.replied`, `form.cancelled`, `form.list` — there is a
`question` tool and a `question` permission action, but the user-question flow
is the **`form.*`** elicitation subsystem (e.g. `session.form.reply`), not
`question.asked`. A bridge that wants to observe clarifications must listen for
`form.created`/`form.replied`/`form.cancelled`.

## 8. Bridge `setup()` sees `KARST_OPENCODE_HEADLESS`

Plugin at `.opencode/plugins/karst-probe.js` using the v2 module contract
`export default { id, async setup(ctx) { … } }`. Running
`opencode2 run --standalone --format json --model opencode-go/mimo-v2.5 "…"`
with `KARST_OPENCODE_HEADLESS=1 KARST_PROBE=envprobe` in the spawn env:

```
{"probe":"setup","pid":42631,"cwd":"<scratch>/work/probe",
 "env_karst_opencode_headless":"1","env_karst_probe":"envprobe",
 "ctx_keys":["app","location","options","agent","aisdk","command","event",
  "experimental","generate","model","provider","integration","mcp","permission",
  "plugin","reference","rpc","skill","storage","tool","vcs","websearch",
  "worktree","session","shell"]}
```

**PASS.** The spawn env reaches the plugin process under `--standalone`.
Fixture: `live-plugin-setup.json`.

Important bridge API note (cost me a detour): `ctx.event.subscribe(cb)` is
**not** a callback registrar — it treats `cb` as a stream transform. The event
stream is `for await (const e of ctx.event.subscribe())`. Events arrive as
`{id, created, type, durable?, location?, data}`; the payload is under `data`.
Observed text-turn event types: `integration.updated`, `model.updated`,
`provider.updated`, `agent.updated`, `command.updated`, `skill.updated`,
`websearch.updated`, `reference.updated`, `plugin.updated`, `session.created`,
`session.inbox.enqueued`, `session.execution.started`,
`session.instructions.updated`, `session.inbox.delivered`,
`session.usage.updated`, `session.renamed`, `session.step.started`,
`session.reasoning.started/delta/ended`, `session.text.started/delta/ended`,
`session.step.streamed`, `session.step.ended`, `session.execution.succeeded`,
`location.shutdown`. Still **absent** vs the report's table: `session.idle`,
`session.status`, `session.updated` (use `session.execution.*` and
`session.usage.updated`). Fixture: `live-events-baseline.ndjson`.

## 9. `session export <id>`

```
$ opencode2 session export ses_eee428b44ffefhpMUg4ojL8SqW --standalone
exit=0
{"info":{"id":"ses_…","projectID":"…","cost":0.00242,
  "tokens":{"input":16094,"output":2,"reasoning":13,
            "cache":{"read":1408,"write":0}},
  "outcome":"succeeded","time":{…},"location":{…}},
 "messages":[ … ]}

$ opencode2 session export ses_DOESNOTEXIST000 --standalone
exit=1
stdout: (empty)
stderr: Session not found: ses_DOESNOTEXIST000
```

So a **pre-check is safe**: missing id → exit 1 + `Session not found: <id>` on
stderr; existing id → exit 0 + JSON. Cumulative usage is `info.tokens`
(`{input, output, reasoning, cache:{read,write}}`, **no `total`**) and
`info.cost`. Fixture: `live-session-export-missing.txt` (and the prior
`session-export.json`).

## 10. Slow git-snapshot loop

Characterized with a `git` shim prepended to `PATH` that logs argv then execs
`/usr/bin/git`.

- **Mechanism.** After steps that touch the workspace, v2 records a snapshot in
  a **shadow git repo** under `$XDG_DATA_HOME/opencode/snapshot/<project>/<hash>`
  (so it is data-dir scoped, never the user's repo). Per snapshot it runs,
  against that shadow repo with `--work-tree <project>`:
  `ls-files --others --exclude-standard -z -- .`,
  `diff-files --name-only -z -- .`, `write-tree`, plus `add --all --sparse …`
  and a `diff` between two tree hashes. Cost scales with working-tree size and
  with the number of steps.
- **Measured.** 3000-file repo, tool run ("create out.txt, then shell ls"):
  snapshot **ON** = 12.70 s, 36 git calls, 21 shadow calls; **OFF**
  (`{"snapshot":false}`) = 6.61 s, 11 calls, 0 shadow calls. Small repo tool
  run: ON 42 calls / 27 shadow, 10.76 s vs OFF 9.14 s. Text-only turn, clean
  tree, 3000 files: 3.19 s vs 2.59 s.
- **Mitigation.** `{"snapshot": false}` (top-level config, also settable in
  `OPENCODE_CONFIG_CONTENT`) removes the shadow-git work entirely. Gate/headless
  runs that do not need undo/revert should set it.
- **The report's "60 s / one call every 13 ms" did not reproduce** in this
  environment even on a 3000-file repo. Two secondary costs are more likely the
  60 s culprit: (a) the **file watcher** subscribes to ancestor directories up
  to `/` (`/`, `/private`, `/Users`, `/Users/nd`, the project tree, skill dirs
  under `~/.claude` and `~/.agents`) — see the standalone startup logs — and
  (b) provider latency. A `run` that lands in `/private/tmp` (as the report's
  scratch dirs did) sits under `/private`, which the watcher covers.

Fixture: `live-git-snapshot-calls.txt`.

## Not verified / caveats

- Only `2.0.24` was tested; v2 changes daily.
- Shell `deny` is **model-dependent**: one model cleanly reports "no shell
  tool", another loops until killed. Bridge/core code should bound the run and
  not assume a denial yields a clean finish.
- The TUI was driven under a PTY with a fixed window; a real interactive model
  switch inside the TUI was not exercised (item 4 used config preselection).
- `question.*` is concluded absent from binary strings + the live event
  catalog; a live `form.created` was not triggered (would need a model to ask a
  question).
- Env reaches only a server karst starts (`--standalone` or `--server`); the
  shared background service ignores per-spawn env.

## Fixtures added

`src/agent/__fixtures__/opencode-v2/` (the prior conformance fixtures were
restored from the dangling spike commit `d2000bad`, which was not on `develop`,
so the follow-up tickets have their input), plus new live fixtures:

| File | Shows |
| --- | --- |
| `live-events-baseline.ndjson` | full bridge event stream + payloads for a text turn (v2 `data` shape) |
| `live-permission-events.ndjson` | real `permission.asked`/`.replied` for `shell` and `external_directory` |
| `live-agent-permissions-resolved.json` | resolved `build` permission rules, project-only vs project+`OPENCODE_CONFIG_CONTENT` (precedence) |
| `live-plugin-setup.json` | plugin `setup()` env + `ctx` key surface |
| `live-prompt-delivery.json` | stored user text per delivery path; which path is byte-identical |
| `live-session-export-missing.txt` | missing-id exit code and stderr |
| `live-git-snapshot-calls.txt` | shadow-git invocation shapes/counts |
