# Investigation: Why does "resume session" spawn a new session with context?

Date: 2026-08-14
Ticket: MAKE-INVESTIGATION-ABOUT

## Question

> Why instead on resume session we're spawning new with context? Observed with
> opencode, but the rest might have same issue. I have done ticket, clicked from
> sidebar to run session — spawned terminal with a new session and context
> inserted, but it's possible to run just previous session by session key/name.

## TL;DR

Resume-by-id is a **two-step contract**: karst must (a) *capture* the interactive
session id while a session runs, and (b) *pass that id* to the CLI on the next
launch. opencode fails **both** steps, so the sidebar button always falls back to
a fresh, fully-seeded session. Claude, Codex and Antigravity satisfy both — the
issue is opencode-specific, not shared.

1. **opencode never captures a session id.** The generated hook bridge
   (`.opencode/plugins/karst-bridge.js`, rendered by
   `src/agent/opencode.ts` `renderHookBridge`) handles `session.idle`,
   `session.error`, `permission.*`, `question.*`, `session.status` — but has **no
   `session.created` handler**. `dispatchHook` only persists a session id on
   `SessionStart` (`src/hooks/dispatch.ts:288`), so opencode sessions leave
   `tickets.session_id = NULL`.
2. **Even a captured id would be dropped.** `OpencodeAdapter.capabilities.resume`
   is `false` and `buildInteractiveCommand` deliberately omits `opts.resume`
   (`src/agent/opencode.ts:512-527`), on the now-stale rationale that the opencode
   TUI has no interactive resume flag. Verified against the installed CLI
   (opencode 1.18.18): the TUI **does** accept `-s, --session <id>` and
   `-c, --continue`.

Because `shouldResumeSession` (`src/agent/resumeDecision.ts:21-33`) requires a
non-null `sessionId` that matches the resolved provider, it always returns false
for opencode. The sidebar button therefore reads "Start · re-seed from context"
(`sessionAction.ts:63-75`) and `openSession` composes the full seed
(`extension.ts:4974-5016`). Result: a brand-new opencode session with the whole
ticket context re-inserted.

## Evidence

### The resume decision gate

`shouldResumeSession` (`src/agent/resumeDecision.ts:21-33`) returns true only when:

- `sessionId` is non-null (a session was captured at SessionStart);
- `sessionProvider` is non-null and equals the provider this launch resolves to;
- the ticket is at `impl` or `fix`.

`sessionAction` (`src/agent/sessionAction.ts:63-75`) is a *preview* of that same
predicate: with no captured id it returns `{ kind: 'start' }`, i.e. "re-seed from
context". That is the sidebar verb the user saw.

### Step (a): session-id capture is `SessionStart`-only

`dispatchHook` (`src/hooks/dispatch.ts:288-295`):

```ts
if (payload.hook_event_name === 'SessionStart' && payload.session_id) {
  setSessionId(store, ticketId, payload.session_id, lifecycleProvider);
}
```

The three working cores deliver a `SessionStart` event through their own channel:

- **Claude** — native hooks (`src/agent/claude.ts` `resume: true`,
  `--resume <id>` at `buildInteractiveCommand`).
- **Codex** — `bridge.cjs` maps the CLI's own `SessionStart` event
  (`src/agent/codex.ts:205`, `resume: true`, `resume <id>`).
- **Antigravity** — `agyConversationWatch` synthesizes `SessionStart` from the
  conversation DB (`src/agent/antigravity.ts:118-122` `resume: true`,
  `--conversation <id>`).

opencode has no such path. Its `KarstBridge.event` handler
(`src/agent/opencode.ts:420-469`) handles only:

- `session.idle` → `session.idle`
- `session.error` → `session.error`
- `permission.asked`/`question.asked` → `permission.asked`
- `permission.replied`/`question.replied` → `permission.replied`
- `session.status` (busy/retry) → `session.status`

There is no `session.created` branch. opencode's plugin `event` hook *does*
receive `session.created` (docs + SDK: `EventSessionCreated` carries
`properties.info: Session` with `id` and `directory`), so the id IS available at
the bridge — it is just not bridged.

### Step (b): the adapter drops the resume id even if one existed

`src/agent/opencode.ts:512-527`:

```ts
readonly capabilities: AgentCapabilities = {
  lifecycleEvents: true,
  resume: false,          // <-- would block --session even with a captured id
  interactiveUsage: true,
};

// `opts.sessionName` and `opts.resume` are deliberately dropped: the opencode
// TUI has no launch-time session-name flag and no interactive resume flag ...
buildInteractiveCommand(opts) { /* never reads opts.resume */ }
```

That comment is now factually wrong for the installed opencode (1.18.18):

```
$ opencode --help
  -c, --continue      continue the last session
  -s, --session       session id to continue
      --fork          fork the session when continuing (use with --continue or --session)
```

The original plan (`docs/plans/007-opencode-agent-core-plan.md:40`) even lists
`-s/--session <id>` and `-c/--continue` as TUI flags — the `resume: false`
rationale there was that *"the TUI does NOT print its session id to stdout →
interactive resume capture is not available"*. That capture gap is exactly the
one the plugin bridge now closes (the id rides `session.created`), but the
adapter was never updated.

### Live DB confirmation (this ticket's own session)

The opencode session running this very investigation was launched with intent
`c6964ece-4802-4c0a-b009-416b6ae9afe4` (provider `opencode`, purpose
`implementation`). Its intent row is still `pending` and `tickets.session_id` /
`session_provider` are `NULL` — proof that no `SessionStart` was ever dispatched
for an opencode session, so no resume target exists to continue.

## Why the "rest" do NOT have the same issue

Claude / Codex / Antigravity each capture `session_id` at `SessionStart` and each
advertise `resume: true` with a working launch-time resume flag. A ticket whose
impl session ended, whose id was captured, and whose provider is unchanged will
get a `--resume`-style continuation from the sidebar button. The one shared trap
(which can look like the same bug) is that resume is gated to `impl`/`fix` — a
ticket parked at a gate/ship stage, or already `done`, *intentionally* opens a
fresh session (verbs `resume`/`reopen` in `sessionAction.ts`). That is by design,
not the capture gap described here.

## What a fix would look like

1. `renderHookBridge` (`src/agent/opencode.ts`): add a `session.created` branch
   that POSTs `SessionStart` with `session_id` from `input.info.id` and `cwd`
   from `input.info.directory` (the same normalized vocabulary the other events
   use).
2. `OpencodeAdapter`: flip `capabilities.resume` to `true` and forward
   `opts.resume` as `-s <id>` in `buildInteractiveCommand` (the TUI supports it).
3. Update the pinned expectations: `opencode.test.ts` "declares truthful
   conservative capabilities" (`resume: false` → `true`), and the 
   `session.created` bridge case would need its own plugin-fixture test.

This ticket is the investigation; the fix is a follow-up decision.
