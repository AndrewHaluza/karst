/**
 * The design system's webview-side runtime (§ `docs/ui/DESIGN-SYSTEM.md` §5) —
 * the async-action lifecycle every control that posts to the host must go
 * through (UI-R11–R14, R18, R32).
 *
 * Before this existed, `aria-busy` appeared ZERO times in the entire UI. Of
 * roughly ninety controls, three had any pending state at all (`ship-ticket`,
 * `merge-pr`, `refresh-prs`) — each an ad-hoc local boolean set before the round
 * trip and cleared by the next unconditional `state` push, so a merge that was
 * refused and a merge that succeeded cleared the button identically. Two more
 * showed an OPTIMISTIC checkmark that never waited for the host at all. The rest
 * — archive, delete, spin, resume, save-agent, install, create-manifest — were
 * fire-and-forget: click a button that writes to disk and nothing anywhere
 * acknowledges the click.
 *
 * Four properties are structural here rather than left to per-control
 * discipline, because per-control discipline is what produced the above:
 *
 *  1. Pending is entered LOCALLY on click, never on the host's reply. The round
 *     trip is the thing being reported; waiting for it to report itself is how a
 *     button ends up looking dead for two seconds.
 *  2. Pending is keyed by CONTROL, so a second activation is dropped rather than
 *     queued. `welcome`'s "Create karst.yml" writes a file and was re-clickable
 *     throughout the await.
 *  3. A watchdog always arms. A control may never be stuck pending — and its
 *     expiry reports "unknown", which is a DIFFERENT claim from "failed" and
 *     must stay worded as one. The host may legitimately never reply (the panel
 *     closed, the action opened a modal the user abandoned).
 *  4. The label never changes. `Save` → `Saving…` → `Save` mutates the
 *     accessible name mid-action and reflows the control; the spinner carries
 *     the meaning instead, via `[aria-busy]` in [[designComponents]].
 *
 * Emitted as plain statements (no wrapping `<script>`), exactly like
 * [[providerIdentity]]'s JS blob, so it can be injected as the first lines of an
 * existing block and picked up by `injectCsp`'s nonce pass.
 *
 * `designRuntime.test.ts` evaluates THIS STRING against a fake DOM rather than
 * re-implementing it in TypeScript — a TS twin would be precisely the
 * mirror-drift this ticket exists to remove.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How long a control may stay pending before the runtime gives up on the host.
 * Long enough for a real `gh pr merge` or a worktree spin; short enough that a
 * dead panel does not look merely slow forever.
 */
export const PENDING_WATCHDOG_MS = 45_000;

/** Success flash dwell, in step with `--k-dur-flash-done`. */
const FLASH_DONE_MS = 2400;

/** Success toast dwell. Errors never auto-dismiss. */
const TOAST_SUCCESS_MS = 6000;

/** Hard cap on any message that reaches a toast — see UI-R32. */
const MAX_TOAST_CHARS = 240;

/** Placeholder swapped for the runtime; sits as the first statement in each webview's `<script>`. */
export const DS_JS_MARKER = '/*KARST_DS_JS*/';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The runtime source. Lives as a real sibling `.js` file
 * (`designRuntime.webview.js`) rather than a TS template-literal string — a
 * linter and editor can process it — because it ships into an HTML document
 * that no bundler touches, the same trade [[providerIdentity]] already makes.
 * Its correctness is held by evaluating that file's exact text in
 * `designRuntime.test.ts`. The four tunable constants above are baked in by a
 * plain placeholder swap, the same mechanism `injectDesignSystem` already uses
 * for the markers themselves.
 */
export function designRuntimeJs(): string {
  return readFileSync(join(HERE, 'designRuntime.webview.js'), 'utf8')
    .replace('__KARST_WATCHDOG_MS__', String(PENDING_WATCHDOG_MS))
    .replace('__KARST_FLASH_DONE_MS__', String(FLASH_DONE_MS))
    .replace('__KARST_TOAST_SUCCESS_MS__', String(TOAST_SUCCESS_MS))
    .replace('__KARST_MAX_TOAST_CHARS__', String(MAX_TOAST_CHARS))
    .trim();
}

