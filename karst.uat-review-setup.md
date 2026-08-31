# Configuring the UAT and Review stages

**Audience: an agent.** This is a runbook, not a tour. It is written to be
executed by a coding agent that has been asked to configure — or repair — the
`uat:` and `review:` blocks of this project's `karst.yml`, and it is complete
enough that no other file needs to be read to do that correctly.

A human reading it gets the same contract, stated as rules rather than prose.

**Where this file came from.** Karst wrote it beside the `karst.yml` it
scaffolded for this project. It is reference material, not configuration:
nothing reads it, editing it changes nothing, and deleting it breaks nothing —
the next scaffold writes a fresh copy. It describes the karst version that
installed it; if karst's behavior and this file ever disagree, karst wins.

---

## 0. The five rules you may not break

Read these before editing anything. Every failure mode in §7 is one of them
violated.

1. **A gate is a process exit code.** Nothing an agent *says* can pass a stage.
   Do not configure a gate whose command reports success unconditionally
   (`|| true`, `echo ok`, a `script` that only prints) — that is a vacuous pass
   and karst has no way to detect it.
2. **Review must ask a question UAT did not.** `review.requireIndependentSignal`
   defaults to `true`, and a violation is a **failure**, not a warning. The
   comparison is over the gates that actually **ran**, by invocation identity
   (`repo` + `command` + `args`) — not over the configured lists.
3. **"Nothing ran" is never green.** A stage that resolved no gate, or whose
   every gate reported no exit code, **parks** the ticket (`nothing-to-run`).
   Removing gates to make a stage pass makes it stop instead.
4. **A per-repository `gates` list REPLACES the global list for that repository.**
   It is never additive. A repo listed under `uat.repositories.<n>.gates` or
   `review.repositories.<n>.gates` runs exactly those gates and nothing else.
5. **`karst.yml` is committed.** Never put a credential value in it. `secrets:`
   keys are **key names only**, and the validator rejects a mapping-with-values
   outright.

---

## 1. When this runbook applies

Apply it when any of these is true:

- the project has no `uat:` / `review:` block and the default probe pipeline
  finds nothing (a Go, Rust, Java, Python or polyglot repo — see §2);
- a ticket parked at `uat` or `review` with `nothing-to-run` or
  `capability-missing`;
- a ticket failed `review` with `review asked no question uat does not: …`;
- the project's gates are wrong (too slow, wrong repo, wrong script).

Do **not** apply it to change a verdict you dislike. A failing gate is a
finding about the code, not about the config.

---

## 2. What happens with no configuration at all

Both blocks are optional. Absent, each stage **probes** the target repository's
`package.json` for known scripts, cheapest first, and runs whichever exist:

| Stage | Probed scripts (in order) |
|---|---|
| `uat` | `test`, `test:integration`, `e2e`, `test:e2e`, `cypress`, `playwright` |
| `review` | `lint`, `typecheck`, `build`, `format:check` |

A discovered gate takes the **script's own name** as its gate name and is
**not required** — a script that is simply absent says nothing. A gate you
**declare** is required: if its script does not exist, that is a failure,
because the config names a question the repository cannot answer.

`test` is deliberately absent from review's probe list. UAT already ran it on
the same worktree; review re-asking it is exactly the duplication rule 2 exists
to catch.

**Implication for non-Node repositories:** no `package.json` means no probe
result, which means `nothing-to-run` at both stages. Those projects **must**
declare `kind: command` gates (§4).

---

## 3. Inputs to gather before editing

Do all of this before writing a single line of YAML.

1. **Read the manifest.** Note every key under `repositories:` — those names are
   the only legal keys under `review.repositories` (an unknown name is a load
   **failure**), and they are the values a gate's `repo:` field is matched
   against.
2. **For each repository, probe its build tooling.** In the repo root:
   - `package.json` → read `scripts` verbatim. Do not assume `test` exists, and
     do not assume `test` runs tests (some repos alias it).
   - no `package.json` → identify the toolchain: `go.mod`, `Cargo.toml`,
     `pyproject.toml`/`tox.ini`, `pom.xml`/`build.gradle`, `Makefile`.
3. **Time the candidate commands** where cheap to do so, or read CI config
   (`.github/workflows/*`) for what the project already runs and how long it
   takes. A gate is killed at **15 minutes** (§6).
4. **Classify each candidate into UAT or review**, using the split in §4.1.
   Write the classification down before configuring — rule 2 is decided by this
   step, not by the YAML.
5. **Check for existing configuration** you would be replacing, including
   per-repo overrides that may be invisible in the Settings UI (a
   `uat.repositories` entry for a repository that is no longer declared is
   preserved on disk but not rendered).

---

## 4. The decision procedure

### 4.1 Which stage does a check belong to?

The two stages ask different questions, and that difference is what keeps the
pair meaningful:

- **UAT — "does the changed system still behave?"** Runtime behavior: unit
  tests, integration tests, e2e suites.
- **Review — "is the diff itself sound?"** Properties of the code: lint, type
  checks, formatting, static analysis, "does it compile/bundle".

A check that runs the test suite belongs to UAT. A check that never executes the
product's behavior belongs to review. If a check would land in both, it belongs
to UAT and review needs a different one.

### 4.2 Which gate kind?

| Situation | Kind |
|---|---|
| the repo has a `package.json` script that already does it | `script` |
| anything else (Go, Rust, Python, Java, a binary, a repo-local script) | `command` |

- `kind: script` runs `npm test` for the script literally named `test`, and
  `npm run <script>` for every other name.
- `kind: command` is **argv-based and spawned without a shell**. There is no
  quoting surface, no pipes, no `&&`, no globbing, no environment expansion.
  `command` is the executable; every argument is a separate `args` entry.

```yaml
# WRONG — this is not a shell; the whole string is one executable name
- { name: lint, kind: command, command: "cargo clippy -- -D warnings" }
# RIGHT
- { name: lint, kind: command, command: cargo, args: [clippy, --, -D, warnings] }
```

If a check genuinely needs shell composition, put it in a script in the
repository (`Makefile` target, `scripts/ci-lint.sh`) and invoke that file as the
command. Do not try to smuggle a pipeline into `args`.

### 4.3 Global list, `repo:` scope, or per-repo override?

Three mechanisms, in increasing specificity:

1. **Global `gates:`** — applies to every target repository.
2. **A gate's own `repo: <name>`** — that entry applies only to that repository,
   and is filtered out for every other one. Use this to *add* one repo's gate to
   an otherwise shared list.
3. **`repositories.<name>.gates`** — **replaces** the whole global list for that
   repository. Use this only when the repo's gates share nothing with the
   global set. If you use it, restate every gate that repo still needs.

Empty is indistinguishable from absent at both levels: an empty
`repositories.<n>.gates` is "no override", and an empty top-level `gates:` is
"no config" (so the probe runs).

### 4.4 Fix budget

`uat.maxFixAttempts` and `review.maxFixAttempts` each default to **3**, are
independent, and neither narrows the other's gate. After the budget is spent,
the ticket parks instead of resuming a fix session. `fix` always returns to
`uat` — a fix made for a review finding is still unvalidated code.

Lower the budget for expensive suites; raise it only when a gate is genuinely
flaky-but-self-correcting, which is a repository defect worth fixing instead.

### 4.5 The findings lane (review, Lane B)

An agent core reads each target's diff against its base branch and files
findings. Configured under `review.findings`, and **on by default**:

| Key | Default | Effect |
|---|---|---|
| `enabled` | `true` | `false` → the lane never runs and contributes nothing |
| `blockingSeverity` | `high` | a finding at or above this severity **fails** review to `fix`; `none` → advisory only (findings are still recorded as evidence) |
| `maxFindings` | `50` | findings beyond this are truncated **by severity, worst first** — never by document order |

Severities are a closed set, lowercase, exactly: `critical`, `high`, `medium`,
`low`, `info`. `blockingSeverity` additionally accepts `none`.

Choosing a value:

- `high` (default) — critical and high findings block. Correct for most projects.
- `critical` — only production-breaking findings block. Use while proving the
  lane out on a noisy codebase.
- `none` — nothing blocks; findings are recorded and shown. Use when the lane's
  output is not yet trusted but you still want the evidence.
- `enabled: false` — the lane costs no tokens. Only reach for this if the
  project must make no AI call during review.

The lane can never break the stage. A call that fails, times out, or answers in
prose contributes zero findings and logs one line; the verdict is then decided
by the gates. The single environmental exception: `enabled: true` with **no
agent core available** parks the ticket `capability-missing`.

---

## 5. Schema reference (exact)

Everything below is enforced at load. A violation is a `ManifestError` naming
the field, and the manifest does not load.

### 5.1 A gate

```yaml
- name: e2e            # required, non-empty string — the name in the verdict and the log
  kind: command        # required: script | command
  script: test:e2e     # required when kind: script — non-empty string
  command: npx         # required when kind: command — non-empty string
  args: [playwright, test]   # optional, kind: command only, list of strings
  repo: frontend       # optional — restrict this entry to one repository
  report: ...          # optional, uat only — parsed, read by nothing (inert)
```

### 5.2 `uat:`

```yaml
uat:
  maxFixAttempts: 3          # positive integer, default 3            — WIRED
  gates: [ <gate>, ... ]     #                                        — WIRED
  repositories:
    <any name>:              # NOT cross-checked against repositories:
      gates: [ <gate>, ... ] #                                        — WIRED
      env: { KEY: value }    #                                        — INERT
      secrets: [KEY_NAME]    # key NAMES only, never values           — INERT
      testDir: e2e           #                                        — INERT
  testDir: e2e               #                                        — INERT
  env: { BASE_URL: "..." }   #                                        — INERT
  secrets: [STRIPE_KEY]      # key NAMES only, never values           — INERT
  passthrough: [HOME, PATH]  #                                        — INERT
  origins: [https://api.stripe.com]   # absolute URLs with a scheme   — INERT
  authBootstrap: { path: .auth/state.json, secrets: [SESSION_TOKEN] } # INERT
  author: { agent: uat-author, enabled: true }                        # INERT
```

**INERT** = validated at load, preserved across a Settings save, and read by
**nothing**. Declaring one emits a load-time notice (host log, and `karst
context`'s stderr). Do not add inert keys to solve a problem — they will not
solve it. Do not delete a user's existing inert keys either; they are a
statement of intent that survives.

`uat.repositories` accepts **any** key name. A typo'd or since-removed
repository name is preserved on disk, matches nothing, and is invisible in the
Settings UI — check spelling by hand.

### 5.3 `review:`

```yaml
review:
  maxFixAttempts: 3               # positive integer, default 3
  requireIndependentSignal: true  # boolean, default true
  openChanges: false              # boolean, default false — auto-reveal the Changes panel
  gates: [ <gate>, ... ]
  findings:
    enabled: true                 # boolean, default true
    blockingSeverity: high        # critical|high|medium|low|info|none, default high
    maxFindings: 50               # positive integer, default 50
  repositories:
    backend:                      # MUST be a declared repository — unknown name = load failure
      gates: [ <gate>, ... ]
```

`review:` carries no `env`, `secrets`, `testDir`, `origins` or `author`. It
reads the diff and runs gates; it has nothing to bootstrap.

---

## 6. How a gate is executed

- **Spawned without a shell**, `detached`, with the target **worktree root** as
  `cwd` — not the original repository directory.
- **How `command` is found.** A bare name (`pytest`, `go`, `cargo`) is a **PATH
  lookup**, and the PATH is the one the **extension host** inherited — not a
  login shell's, so a tool installed only by a shell rc file or activated only
  inside a virtualenv will not be found. A command containing a separator
  (`./gradlew`, `.venv/bin/pytest`) is resolved against the gate's `cwd`, so a
  project-local toolchain works without touching PATH; prefer that form when a
  repository ships its own tooling.
- **Timeout: 15 minutes.** A gate that exceeds it is killed (process tree) and
  the run reports the timeout. Split or narrow anything slower.
- **Output cap: 1 MiB**, bounded as it streams.
- Exit `0` = pass. Any other code = fail. Killed/signalled reports code `null`,
  which is **not** a pass — it means the gate never answered.
- Gates run **asynchronously**; they never block the extension host.
- Two entries in one directory resolving to the same `command` + `args` are one
  question asked twice and are **deduplicated by invocation identity**. If a
  duplicate was `required` anywhere, the survivor stays required.

Repository entries sharing a `repoPath` collapse to **one worktree**, so their
gate lists are unioned against that single target.

---

## 7. Verdict rules — what your config will produce

### 7.1 UAT

Passes **iff** every gate that ran exited `0` **and** at least one gate ran.

| Situation | Outcome |
|---|---|
| no gate resolved / none ran | **parked** `nothing-to-run` |
| any gate exited non-zero | **failed** → `fix` |
| every gate that ran is also run by review | **passed with a warning** (advisory, unlike review's rule 2) |
| otherwise | **passed** |

### 7.2 Review — first match wins, in this order

| # | Condition | Outcome |
|---|---|---|
| R3 | no gate resolved, or none ran | **parked** `nothing-to-run` |
| R4 | a target's `package.json` will not parse | **failed** (repo defect an agent can fix — outranks R5, because it is the actionable sentence) |
| R5 | any gate exited non-zero | **failed** → `fix` |
| R6 | findings lane has no agent core to ask | **parked** `capability-missing` |
| R6 | a finding at or above `blockingSeverity` | **failed** → `fix` |
| R7 | `requireIndependentSignal` and no gate that ran is absent from UAT's set | **failed** → `fix` |
| R9 | otherwise | **passed** → `ship` |

R5 outranks R6 and R7 deliberately: a red gate is cheaper to act on than a
finding or a config critique, so it wins the wording.

Note the ordering consequence: a gate failure **short-circuits before any AI
call is made**, so a project whose gates fail early never pays for the findings
lane.

---

## 8. Failure playbook

Match on the message; each row is cause → fix.

| Message / symptom | Cause | Fix |
|---|---|---|
| `no gates configured and package.json defines none of: …` | probe found nothing and nothing was declared | declare gates for that stage (§4.2). Non-Node repo → `kind: command` |
| `no gates configured and this repository has no package.json` | the non-Node case: nothing declared, and there is no file to probe | declare `kind: command` gates (§4.2, §9.3). Do **not** add a `package.json` whose scripts only shim out to the real toolchain |
| `cannot read package.json: …` (parked, `capability-missing`) | environmental — permissions, unreadable path | not an agent fix; report it. Declaring all-`command` gates does bypass the probe entirely |
| review failed with a `package.json` parse error | malformed `package.json` in a target | fix the JSON in the repository |
| `no gate ran: <names>` | gates resolved but every one was killed or never answered | check the 15-minute timeout and whether a Stop aborted the run |
| `gates failed: <names>` | the gate did its job | fix the code, not the config |
| `review findings: 2 critical, 1 high` | Lane B blocked at `blockingSeverity` | address the findings; lower the threshold only as a deliberate, stated decision |
| `review asked no question uat does not: …` | rule 2 — review's effective gates are a subset of UAT's | **add a review gate UAT does not run** (lint/typecheck/build). Setting `requireIndependentSignal: false` is the escape hatch, not the answer |
| `uat asked no question review does not: …` (warning) | the mirror case, advisory only | add a `uat.gates` entry review does not run |
| `review.repositories "x" is not a declared repository` | name not under `repositories:` | fix the name; the error lists the known ones |
| `… must be a list of key names, never a mapping with values` | a value was written into `secrets:` | remove it — treat it as a leaked credential and rotate |
| a declared gate fails with npm's "Missing script" | a declared gate is required and its script is absent | add the script, or switch the gate to `kind: command` |
| a load notice naming an inert key | the key has no consumer | expected; either remove it or accept the notice (see §5.2) |

---

## 9. Worked configurations

### 9.1 Node monorepo, two repositories

```yaml
uat:
  maxFixAttempts: 3
  gates:
    - { name: test, kind: script, script: test }
    - { name: e2e,  kind: command, command: npx, args: [playwright, test], repo: frontend }
  repositories:
    frontend:
      # REPLACES the global list for this repo — restate everything it needs.
      gates:
        - { name: test, kind: script, script: test:unit }
        - { name: e2e,  kind: command, command: npx, args: [playwright, test] }

review:
  maxFixAttempts: 3
  requireIndependentSignal: true
  openChanges: false
  gates:
    - { name: lint,      kind: script, script: lint }
    - { name: typecheck, kind: script, script: typecheck }
  findings:
    enabled: true
    blockingSeverity: high
    maxFindings: 50
```

### 9.2 Polyglot: Go backend, Rust worker, Node frontend

No `package.json` in two of three repositories, so every gate for those is
`kind: command`.

```yaml
uat:
  gates:
    - { name: test, kind: command, command: go,    args: [test, ./...],      repo: backend }
    - { name: test, kind: command, command: cargo, args: [test],             repo: worker }
    - { name: test, kind: script,  script: test,                             repo: frontend }

review:
  gates:
    - { name: vet,    kind: command, command: go,    args: [vet, ./...],           repo: backend }
    - { name: clippy, kind: command, command: cargo, args: [clippy, --, -D, warnings], repo: worker }
    - { name: lint,   kind: script,  script: lint,                                 repo: frontend }
  findings: { enabled: true, blockingSeverity: high }
```

Each repository is asked a behavior question at UAT and a different, static
question at review — rule 2 holds per target.

### 9.3 Python repository, findings advisory only

The case that most often reads as "karst does not support this project". It
needs no shim script and no `package.json`: a declared gate list is consulted
**before** the probe, so the probe never runs. `python -m` is used rather than
the bare `pytest`/`ruff` console scripts so the gate follows whichever
interpreter is first on the inherited PATH (§6) instead of a separately
installed entry point.

```yaml
uat:
  gates:
    - { name: pytest, kind: command, command: python, args: [-m, pytest, -q] }

review:
  gates:
    - { name: ruff, kind: command, command: python, args: [-m, ruff, check, .] }
    - { name: mypy, kind: command, command: python, args: [-m, mypy, .] }
  findings:
    enabled: true
    blockingSeverity: none   # recorded as evidence, never blocks
```

If the interpreter is a project virtualenv that is **not** on the extension
host's PATH, name it by path — a command containing a separator resolves
against the worktree root (§6):

```yaml
    - { name: pytest, kind: command, command: .venv/bin/python, args: [-m, pytest, -q] }
```

---

## 10. Verify before you claim it works

Do all of these. Do not report success on any subset.

1. **The manifest loads.** Open Settings (or run `karst context <ticket-key>`)
   and confirm no `Invalid karst.yml …` error. A load failure means the file is
   not in effect at all.
2. **Read the load notices.** Every inert key you wrote is reported. If you see
   a notice for a key you expected to *do* something, you configured an inert
   key — go back to §5.
3. **Run each gate command by hand, in a worktree**, exactly as configured —
   same executable, same argv, same `cwd`. Confirm the exit code is what you
   expect and the runtime is under 15 minutes.
4. **Check rule 2 by hand:** list the gates UAT will run and the gates review
   will run, per repository. At least one review gate must be absent from UAT's
   list, compared as command + args, not as name.
5. **Drive one real ticket through `uat` and `review`.** The config is only
   proven by a stage that reached a verdict; a manifest that loads has proven
   nothing about what runs.
6. State plainly which of the above you actually ran.

---

## 11. Editing surface

Both blocks are fully editable in **Settings → Quality** — `maxFixAttempts`,
`gates`, per-repository overrides, `requireIndependentSignal` and the
`findings` triple. The gate editor is shared between UAT and review, and a
per-repo override is seeded with a copy of the current global list (it still
**replaces** it).

Settings Save is **tab-scoped**: saving the Quality tab writes `uat` and
`review` and nothing else. Hand-editing `karst.yml` is equally valid — the
Save path overlays `uat` and `review` on the file as it is on disk, so a
yml-only key elsewhere is not lost.
