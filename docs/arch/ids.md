<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/arch/ids.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'arch:IDS-01'):
  awk "/^## \[@arch:IDS-01\]/,/END_DOC_BLOCK: \[@arch:IDS-01\]/" docs/arch/ids.md
-->
# Entity ids (`src/model/entityId.ts`)

How a ticket, a draft and a planning session are named in every text a human or agent reads. Related: `docs/arch/prompt-metrics.md` (`arch:RESIDENT`, why the self-id is one line), `docs/arch/cli.md` (id arguments).

## [@arch:IDS-01] Every visible id goes through entityId.ts

Three numeric entities, one prefixed form, built only by `src/model/entityId.ts` (display-only: derived from the integer primary keys, no schema change).

| Prefix | Entity | The number is |
|---|---|---|
| `T<n>` | ticket | `tickets.id` |
| `D<n>` | draft (planning proposal) | `planning_proposals.id` |
| `P<n>` | planning session | the planning session id |

- **`#N` is GitHub PR only.** Never build `#<entity id>` in text; use `formatId(kind, n)`, `formatTicketRef(id, key)` (`T583 · ABC-123`, or `T583` when the key is blank) or `ticketRefOrUnknown(id)` (`unknown ticket` for 0/invalid).
- **The ticket key stays the provider's id** (`ABC-123`). It is not replaced by `T<n>`; the two are shown together as `T583 · ABC-123`.
- **`parseId(text, expectedKind?)`** is the only parser for id arguments:

| Input | Without `expectedKind` | With `expectedKind` |
|---|---|---|
| `T583`, `d7`, `P2` (prefix case-insensitive) | that kind | that kind; throws `wrong id kind` if the prefix is another kind |
| `583` (bare) | throws (needs a prefix) | `expectedKind` |
| `#583` (legacy) | throws | `expectedKind` |
| `T583 · ABC-123` | `T583` (the trailing ` · KEY` is stripped) | same |
| `T0`, `T05`, `X1`, empty | throws | throws |

- **Self-id in the context header.** The session's own id is one line, `You are working on T<n> (KEY).` (plus `This is a sub-task of T<m>.`), in the facts/instruction layer. When facts are delivered the narrative heading drops the id (`# Ticket: KEY — title`); a narrative render without a facts layer sets `headingId`, and the `all` render heads `# Ticket: T<n> · KEY — title`. One line, not a section: see `@arch:RESIDENT`.
- **Planning texts.** The preamble opens `PLANNING session P<n>` and cites drafts as `D<n>`; binding a draft writes `Planned in P<session> as D<draft>.` into the brief. `draft propose` prints `ref`; `dependsOn` and `id` accept `D<n>`.
- **Ratchet.** `src/model/entityId.ratchet.test.ts` fails when non-test source (outside `src/ui`) builds `#${…}` from an entity id; allowed `#N` forms (PR numbers, revision counters, run rows, hashes) are listed in its `ALLOWED` pattern.
- **Webview surfaces** (`src/ui`, excluded from the ratchet) follow in a follow-up ticket.
END_DOC_BLOCK: [@arch:IDS-01]
