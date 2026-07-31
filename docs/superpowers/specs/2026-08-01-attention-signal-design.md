# Attention signal: activity-bar badge + status item

Ticket: 869ea4c0p — [FEAT] Extention logo menu item should be improved

## Problem

Karst's activity-bar logo carries no state. When the Tickets panel is collapsed
or the user is in another view, nothing tells them a ticket is waiting on them —
an agent asked a question, a confirm stage is parked, a gate failed. The signal
exists in the data (`needsUser`, the `input`/`failed` facets) but never reaches a
surface the user sees with the panel closed.

The 19 contributed commands are also palette-only (`contributes.menus` is
absent), but title-bar and context-menu actions are explicitly **out of scope**
for this spec.

## Scope

In scope:

- A numeric badge on the activity-bar container icon (`media/karst.svg`).
- A status-bar item naming the count in words, with a click target.
- A `karst.showAttention` command that lists the waiting tickets.

Out of scope: view title-bar actions, ticket-row context menus, any change to
the existing focused-ticket status item or the deps-fault status item.

## The attention set

A ticket needs attention when `facetOf(t)` is `input` or `failed`.

`facetOf` (`src/ui/sidebar/facets.ts`) derives from `ticketGlyph`, so a ticket
lands in exactly one bucket: `needsUser` makes amber win over red, and amber maps
to `input`, red to `failed`. Reusing it is what keeps the badge, the sidebar
chip counts, and the row dots from ever disagreeing.

- `input` — agent asked a question (`agentState === 'waiting'`), or the ticket is
  parked at a pending confirm stage.
- `failed` — current stage failed (gate failure, failed transition).

## Components

### `src/ui/attention.ts` (new, host-agnostic)

```ts
export type AttentionKind = 'input' | 'failed';

export interface AttentionItem {
  ticketId: number;
  /** `t.key`, falling back to `#<id>` — the same fallback the status bar uses. */
  key: string;
  /** `t.title ?? ''`; the QuickPick detail line omits it when empty. */
  title: string;
  stage: string;
  kind: AttentionKind;
  /** Derived phrase, e.g. `agent asked a question`. */
  reason: string;
}

export interface AttentionSummary {
  count: number;
  /** Status-bar label, e.g. `$(bell) 2 need you`. */
  text: string;
  /** Multi-line tooltip, one line per item. */
  tooltip: string;
  /** True when any item is `failed` — drives the warning background. */
  warning: boolean;
  /** Badge tooltip, e.g. `2 tickets need your input`. */
  badgeTooltip: string;
}

export function attentionItems(tickets: readonly TicketWithStages[]): AttentionItem[];
export function attentionSummary(items: readonly AttentionItem[]): AttentionSummary | null;
```

`reason` is derived, never stored — the `stages` table holds no failure text, so
inventing one would be a lie:

| Condition                          | `reason`                          |
| ---------------------------------- | --------------------------------- |
| `agentState === 'waiting'`         | `agent asked a question`          |
| pending confirm stage              | `awaiting confirmation · <stage>` |
| current stage failed               | `<stage> failed`                  |

Sort: `failed` before `input`, then by `updatedAt` ascending — the
longest-waiting ticket surfaces first.

`attentionSummary` returns `null` for an empty list. Nothing is shown when
nothing is wrong; a permanent "all good" indicator is noise, the rule
`buildDepsIndicator` already follows.

Tooltip caps at 10 lines and appends `…and N more` — a tooltip is not a list
view. The QuickPick is the full list.

### `AttentionManager` (in `src/ui/attention.ts`)

```ts
export interface AttentionHost {
  setStatus(text: string, tooltip: string, warning: boolean): void;
  hideStatus(): void;
  setBadge(value: number, tooltip: string): void;
  clearBadge(): void;
}

export class AttentionManager {
  constructor(host: AttentionHost) {}
  render(items: readonly AttentionItem[]): void;
}
```

Same shape as the existing `StatusBarManager`: injected host, no `vscode`
import, unit-tested with a fake.

`render` on an empty list calls `hideStatus()` + `clearBadge()`.

### Badge — `src/ui/sidebar/host.ts`

`WebviewView.badge = { value, tooltip }` paints the number on the activity-bar
container icon. `makeSidebarViewHost` is the only place holding the real
`WebviewView`, so it owns the binding and its `SidebarViewHost` gains:

```ts
setBadge(badge: { value: number; tooltip: string } | undefined): void;
```

`AttentionHost.setBadge(value, tooltip)` / `clearBadge()` are the manager's
verbs; `extension.ts` adapts them to this single nullable setter. The two shapes
are deliberate — the manager never expresses "badge zero", and the host never
needs to know why.

Two behaviours are load-bearing:

1. **Cache across resolve.** In a cold window the user may never have opened the
   Tickets view, so no `WebviewView` exists and the badge cannot be set. The
   host stores the last value and applies it inside `resolveWebviewView`. Without
   this the badge is absent in exactly the case the ticket cares about most.
2. **Zero clears, never renders.** At count 0 set `badge = undefined`. Assigning
   `{ value: 0 }` renders a `0` bubble on the icon.

The badge is a number only — VS Code exposes no badge color — so severity is
carried by the status item's warning background and by the tooltip text.

### Status item — `src/extension.ts`

A second `vscode.StatusBarItem`, `StatusBarAlignment.Left`, priority `50`:
between the deps item (`0`) and the focused-ticket item (`100`). Left to right
that reads: tools broken → what needs you → where you are.

- `text`: `$(bell) 2 need you`
- `backgroundColor`: `statusBarItem.warningBackground` only when a `failed` item
  is present.
- `tooltip`: the summary tooltip.
- `command`: `karst.showAttention`.
- Hidden at count 0.

The existing focused-ticket item and deps item are untouched.

### `karst.showAttention` command

Contributed as `Karst: Show Tickets Needing You` (icon `$(bell)`). Opens a
QuickPick over `attentionItems`:

```
$(warning) KAR-3 · uat gate failed         Fix login redirect
$(bell)    KAR-7 · agent asked a question  Add rate limiting
```

Selecting an entry calls `dashboard.openDashboard(ticketId)`.

The command is palette-reachable even when nothing is waiting; in that case it
shows an information message `No tickets need your input.` rather than an empty
picker.

QuickPick construction stays in `extension.ts` (it is `vscode` API); the item
list and every label/detail string come from the pure module.

## Project scoping

The attention read calls `listTickets(store, { projectId })`.

The DB lives in global storage and is shared by every IDE window. An unscoped
read would make window A's badge count window B's tickets. The `projectId`
arrives as a getter, not a value — binding happens during activation and can
re-resolve when the manifest reloads — matching what `SidebarViewManager`
already takes.

## Refresh wiring

`extension.ts` calls `provider.refresh()` from 22 sites. Adding a second call at
each is how the badge goes stale on the one path someone forgets.

`SidebarViewManager` gains:

```ts
onRefresh(cb: () => void): void;
```

fired at the end of the existing `refresh()`. `extension.ts` registers one
subscriber that recomputes the attention set and calls `AttentionManager.render`.
All 22 existing call sites are unchanged.

Only one subscriber is supported (last registration wins), matching how
`SidebarViewHost.onResolve` already behaves — this is wiring, not an event bus.

## Data flow

```
ticket mutation
  → provider.refresh()                 (22 existing call sites)
  → SidebarViewManager.refresh()
      → push state to webview          (existing)
      → onRefresh subscriber           (new)
          → listTickets({ projectId })
          → attentionItems()
          → AttentionManager.render()
              → status item text/color/tooltip/command   (or hide)
              → WebviewView.badge                        (or clear)
```

## Error handling

- The `onRefresh` subscriber wraps its body in try/catch and reports through
  `logError` to the Karst output channel. A failed attention repaint must never
  break the sidebar push that just succeeded.
- A `listTickets` throw (store closed during shutdown) renders as "no attention"
  — hide, do not crash.
- `setBadge` before the first `resolveWebviewView` is a cached no-op, not an
  error.

## Testing

`src/ui/attention.test.ts` (pure, no `vscode`):

- empty list → `attentionSummary` returns `null`
- `agentState: 'waiting'` → one `input` item, reason `agent asked a question`
- pending confirm stage → `input`, reason names the stage
- failed current stage → `failed` item, `warning: true`
- mixed set → `failed` sorted before `input`, then oldest `updatedAt` first
- `AttentionManager.render([])` → `hideStatus` + `clearBadge`, never `setBadge(0, …)`
- tooltip caps at 10 lines with an `…and N more` overflow line
- `setBadge` issued before resolve is applied on the first resolve (fake host)

`src/ui/sidebar/panel.test.ts`:

- `onRefresh` subscriber fires on every `refresh()`
- `refresh()` still pushes state when no subscriber is registered

Written RED first, per the repo's strict TDD rule.

## Files

| File                          | Change                                            |
| ----------------------------- | ------------------------------------------------- |
| `src/ui/attention.ts`         | new — derivation + `AttentionManager`             |
| `src/ui/attention.test.ts`    | new — unit tests                                  |
| `src/ui/sidebar/host.ts`      | add `setBadge` + resolve-time cache               |
| `src/ui/sidebar/panel.ts`     | add `onRefresh`                                   |
| `src/ui/sidebar/panel.test.ts`| cover `onRefresh`                                 |
| `src/extension.ts`            | status item, command registration, refresh wiring |
| `package.json`                | contribute `karst.showAttention`                  |

## Rejected alternatives

- **Extend `StatusBarManager`.** It models one focused ticket (`StatusTicket`);
  folding a global count in breaks that interface and its tests, and the badge
  still needs a separate owner.
- **Own it inside `SidebarViewManager`.** It holds the ticket list already, but
  the badge lives on `WebviewView` — which the manager deliberately does not hold
  — and the status item must keep working when the sidebar has never resolved.
- **Fold the count into the existing focused-ticket item.** The count would
  vanish whenever no ticket is focused, which is the state the ticket is about.
- **Count dependency faults too.** Already covered by the deps status item; a
  single catch-all number would say less, not more.
