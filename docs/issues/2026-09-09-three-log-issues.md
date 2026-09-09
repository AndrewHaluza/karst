# Three reported log/UI issues — investigation and upstream reports

Ticket: `LOG-ISSUES` (karst ticket 450), filed 2026-09-07 14:11:53 UTC, investigated
2026-09-09. **No code changes in karst** — this document is the deliverable: a
verified write-up of each defect with reproduction steps, ready to paste into the
respective tracker.

Environment used for verification:

| Item | Value |
| --- | --- |
| macOS | 26.6.2 (darwin 25.6.0, arm64) |
| Cursor | 3.19.13 (`/Applications/Cursor.app`) |
| VS Code (stable) | installed, used for the API comparison |
| karst extension | `karst.karst-1.0.0` (bundled `dist/extension.js`) |
| git | 2.50.1 (Apple Git-155) |

Summary of verdicts:

| # | Reported as | Verified verdict | Owner |
| --- | --- | --- | --- |
| 1 | "QuickPick writes a readonly `.label`, `show()` rejects, picker closes silently" | Real defect, but the readonly write is `SourceControl.label`, not a QuickPick item | **karst** (not upstream) |
| 2 | GitHub PR extension scans karst worktrees, logs missing-remote errors | Not reproducible on this machine — extension is not installed and the logs have rotated | **ms-vscode.vscode-pull-request-github**, pending fresh evidence |
| 3 | Slug generator duplicates the worktree prefix | Confirmed, root cause isolated | **karst** |

---

## Issue 1 — write to the readonly `SourceControl.label` throws

**Verdict: real, and it is karst's bug, not the host's.** The reporter's framing
("QuickPick writes to a readonly `.label` on list items") does not match the code:
the bundled extension contains exactly one write to a `.label` property, and it is
on a `vscode.SourceControl`, not on a QuickPick item.

### Evidence

`src/extension.ts:2378` (bundled as `label=R` in `dist/extension.js`, the only
`.label =` write in the bundle):

```ts
const scmHost: ScmHost = {
  createView: (id, title) => {
    const sc = vscode.scm.createSourceControl(id, title);
    sc.inputBox.visible = false;
    return {
      setTitle: (next) => {
        (sc as any).label = next;   // ← readonly in the API, getter-only at runtime
      },
```

`vscode.d.ts` declares `SourceControl.label` as `readonly label: string`. The `as any`
cast is what lets this compile. At runtime the extension-host object really is
getter-only — verified by decompiling both hosts:

* Cursor `out/vs/workbench/api/node/extensionHostProcess.js`, `ExtHostSourceControl`:
  `get id(){...}get label(){return this._label}get rootUri(){...}` — **no `set label`.**
* The neighbouring `ExtHostSourceControlResourceGroup` in the same file *does* have
  `get label(){return this._label}set label(n){...}` — so the missing setter is
  specific to the source control itself, not a minifier artifact.
* VS Code stable's own bundle shows the same shape (6 `get label(){return this._label}`
  sites, of which the source-control one has no setter). **The hosts agree; the API
  contract is being violated by karst.**

Extension code is ESM and therefore strict mode, so the assignment does not fail
silently — it throws `TypeError: Cannot set property label of #<Object> which has
only a getter`. Whatever async flow calls `setTitle` (the karst SCM view retitling
when the active ticket changes) rejects at that point, which is consistent with the
reported "picker flashes closed with no output" if the throw happens inside the
same handler that then never gets to show its result.

### Reproduction

1. Install `karst.karst-1.0.0` in Cursor 3.19.x or VS Code stable.
2. Open a karst project and let the karst SCM view register.
3. Trigger anything that retitles the SCM view (switch the active ticket).
4. Observe the `TypeError` and the aborted handler.

Minimal, host-only repro (no karst needed) in any extension:

```ts
const sc = vscode.scm.createSourceControl('demo', 'Demo');
(sc as any).label = 'Renamed';  // TypeError: … has only a getter
```

### Recommended fix (for the karst tracker — deliberately not applied here)

Drop the cast and the write. The source control's title is fixed at
`createSourceControl(id, title)`; to change it, dispose and recreate the source
control, or move the ticket name into the resource **group** label, which is
writable by contract. Also delete the `as any` — it is the only reason a
readonly-API violation type-checked.

---

## Issue 2 — GitHub Pull Requests extension scans karst worktrees

**Verdict: not reproducible on this machine as of 2026-09-09; report is filed but
needs fresh evidence before it can go upstream.**

What was checked, and what was found:

* `~/.cursor/extensions` and `~/.vscode/extensions` contain **only** `karst.karst-1.0.0`
  (plus a `.bak` copy). `ms-vscode.vscode-pull-request-github` is not installed in
  either editor, nor in any profile under
  `~/Library/Application Support/{Code,Cursor}/User/profiles`.
* No log line matching `missing remote`, `no remote`, or a worktree path plus an
  error survives in `~/Library/Application Support/Cursor/logs` or
  `.../Code/logs`. The oldest retained Cursor session is `20260909T015046`, i.e.
  the logs from the original 2026-09-07 observation have rotated away.
* The only worktree-related lines still present are from the built-in git extension
  and show the scan is currently **off**:
  `2026-09-09 12:22:23.000 [info] [Git][getWorktreesFS] Worktree detection is disabled, skipping worktree detection`
  (`logs/20260909T015046/window3/exthost/vscode.git/Git.log`, 12 occurrences between
  12:22:23 and 12:31:20 local time). This is consistent with the noise having been
  silenced by disabling worktree detection rather than fixed.

### What the upstream report needs (reproduction to run when the extension is back)

1. Install `ms-vscode.vscode-pull-request-github` and sign in.
2. Open a repository that contains karst worktrees at `<repo>/.karst/worktrees/<slug>`
   — these are *linked* worktrees on local-only branches (`karst/<slug>`) that have
   **no upstream remote by design**; they are never pushed.
3. Ensure worktree detection is on (`"git.detectWorktrees": true` — it is off in this
   configuration, which is what currently masks the issue).
4. Open the **GitHub Pull Request** output channel and reload the window.
5. Expected: the extension ignores repositories with no matching remote.
   Observed (2026-09-07): one missing-remote error per karst worktree, repeated on
   every rescan.

### Argument for upstream

A linked worktree of an already-known repository is not a separate GitHub project.
The extension should either resolve a worktree to its common git dir (the parent
repository's remotes) or skip repositories with no GitHub remote silently — a
missing remote is an ordinary, expected state, not an error worth an output line.

**Status: hold.** Do not file until the log lines can be captured verbatim; the
report as it stands has a mechanism but no quotable error text.

---

## Issue 3 — the worktree slug repeats the ticket key inside the title

**Verdict: confirmed, root cause isolated, reproducible from data alone.**

### Mechanism

Two independent derivations both run off the ticket **title**, and the slug then
concatenates them:

1. `src/store/titleKey.ts` → `slugifyTitleKey(title)` derives the ticket **key**
   from the title when the user did not type one:
   `"Log issues"` → `LOG-ISSUES` (uppercased, word-boundary truncation at 32 chars).
2. `src/runtime/slug.ts` → `worktreeSlug({id, key, title})` builds the worktree slug
   as `` `${key} ${title}` `` lowercased, non-alphanumerics collapsed to `-`, then
   **`.slice(0, 60)`**.

When the key was derived from the title, step 2 concatenates the title with a
lowercased copy of itself:

```
key  = "LOG-ISSUES"   (derived from the title)
title= "Log issues"
slug = "log-issues" + "-" + "log-issues" = "log-issues-log-issues"
```

The 60-character cap then truncates the *second*, still-informative copy, so the
distinguishing tail of a long title is exactly what gets lost.

### Evidence on disk

`ls /Users/nd/Work/projects/karst/.karst/worktrees/` (2026-09-09):

```
log-issues-log-issues
bug-with-state-using-superpowers-bug-with-state-using-superp
diifs-in-source-controll-issue-diifs-in-source-controll-issu
dynamic-graph-fixes-dynamic-graph-fixes
dynamic-graph-fixes-fu1-dynamic-graph-fixes
dynamic-graph-fixes-fu1-fu1-dynamic-graph-fixes
dynamic-graph-fixes-fu1-fu1-fu1-dynamic-graph-fixes
dynamic-graph-fixes-fu1-fu1-fu1-fu1-dynamic-graph-fixes
dynamic-graph-fixes-fu1-fu1-fu1-fu1-fu1-dynamic-graph-fixes
dynamic-graph-fixes-fu1-fu1-fu1-fu1-fu1-fu1-dynamic-graph-fi
```

The reporter's example `review-missing-spots-of-review-missing-spots-of-migration-fr`
is the same shape (that ticket lives in another project's database and was not
re-queried here).

Follow-up tickets make it compound. From the live registry
(`globalStorage/karst.karst/karst.db`):

```
DYNAMIC-GRAPH-FIXES                 | Dynamic graph fixes
DYNAMIC-GRAPH-FIXES-fu1             | Dynamic graph fixes
DYNAMIC-GRAPH-FIXES-fu1-fu1         | Dynamic graph fixes
DYNAMIC-GRAPH-FIXES-fu1-fu1-fu1     | Dynamic graph fixes
DYNAMIC-GRAPH-FIXES-fu1-fu1-fu1-fu1 | Dynamic graph fixes
```

Each follow-up appends `-fu1` to the key while the title stays put, so the key half
grows without bound and eats the 60-char budget that the title half needed. At six
follow-ups the title is already being cut (`…-dynamic-graph-fi`).

### Reproduction

1. Create a karst ticket with a title and **no** explicit key, e.g. `Log issues`.
2. Confirm the derived key in the ticket form preview: `LOG-ISSUES`.
3. Spin the ticket.
4. `ls <repo>/.karst/worktrees/` → `log-issues-log-issues`.
5. Repeat with a title of 40+ characters to see the second copy truncated mid-word.

### Recommended fix (for the karst tracker — deliberately not applied here)

`worktreeSlug` should not re-append the title when the key was derived from it.
Options, cheapest first:

* Slugify the key, slugify the title, and drop the title segment when the key
  segment already **starts with** it (covers the `-fu1` chains too, since the key
  keeps the title as its prefix).
* Or: record on the ticket whether the key was user-supplied or title-derived, and
  build the slug from key-only in the derived case.

Either way the slug must stay **rename-invariant and stable** — changing the rule
relocates existing worktrees, so any fix needs a migration or must apply to newly
created worktrees only. That constraint is the reason this was documented rather
than patched under a "no code changes" ticket.
