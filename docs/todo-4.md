# new ticket
> **Area A: ✅ DONE** on branch `feat/create-ticket-flow-drawer`.
> - prompt prefill after fetch — `webview.html` desc prefilled from brief on both
>   `state` (:289) and `brief` (:708) messages; label renamed Description→Prompt.
> - suggest — `✦ Suggest` approach button + `suggestApproach` action + auto-suggest.
- ~~prompt it not prefiled after ticket fetched~~
- ~~suggest~~ (approach-suggest)

# Settings page

## approaches page

need to fully rework UI with UX, use /frontend-designer; show me options before implementing

not installed cannot be enabled out ouf the box, since they're not installed yet

approaches commands should be swapped 

today - /rpi:karst
should be - /karst:rpi


from settings page user should be able to see command content in a drawer, by clicking on the command

## agents page

> **Design: ✅ APPROVED** — `docs/superpowers/specs/2026-07-13-settings-agents-page-design.md`
> Layout **Option 1 · Provenance roster** (grouped Yours / From-approaches on a
> left spine, enable/disable per agent, header mirrors the create dropdown).
> Mockup: scratchpad `agents-mockup.html`.

we have pre-installed agents (karst.yml), but they're not installed and not enabled on settings UI

but on create page they're visible in the subagents dropdown for direct implementation with a subagent

agents from approaches should have more specific name in the list - today we show custom agents with only name - that's ok, 

but from approaches - "code-reviewr (approaches)" should include which approach owns it

UI\UX should be reworked - options with design, before implementing anything;  use /frontend-designer

## services
> **✅ DONE** — commit `1bb815f` renamed port slot `http`→`port` (karst.yml + settings UI).

why port variable even named http?
  in the karst.yml   `health: http://{host}:{http}/`
same on the settings UI

http should be replaced with port on the both places


## tickets list
> **Area D: ✅ DONE** — spec `docs/superpowers/specs/2026-07-13-tickets-list-label-and-path-design.md`.
> - D1 label template — manifest `ticketLabelTemplate` ({key}{title}{id}{status}{stage}{repos},
>   default `{key} — {title}`); engine `store/ticketLabelTemplate.ts`; Settings › General
>   field + live preview. Commit `7a6dbb3`.
> - D2 relative worktree path — sidebar now applies `worktreePathDisplay` (shared
>   `ui/worktreePath.ts`). Commit `d32629c`.

~~ticket lable should be configured by user in the settings - template string with variables~~

~~"Worktrees /Users/nd/Work/projects/tatto-timer", but `worktreePathDisplay: relative`~~