/**
 * Pinning test for the destructive-action taxonomy (UI-R10b, NDL-126 §9.1).
 *
 * A taxonomy is only load-bearing if it cannot silently drift from the controls
 * it classifies, so these assertions run in BOTH directions:
 *
 * - every taxonomy member is a real, destructive control the vanilla view
 *   renders with the shared danger variant (no invented members);
 * - every taxonomy member that crosses postMessage is a real message type, and
 *   every irreversible message type is IN the taxonomy (so a new irreversible
 *   message cannot ship with an unmarked control);
 * - the taxonomy covers exactly the `k-btn--danger` / `k-iconbtn--danger`
 *   controls the vanilla view actually has — a drop from both sides is a parity
 *   break the phase 4 gate would only catch visually.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DESTRUCTIVE_ACTIONS,
  DESTRUCTIVE_MESSAGE_TYPES,
  isDestructiveAction,
  parseSettingsMessage,
  type SettingsWebviewMessage,
} from './messages.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The control each taxonomy member corresponds to in the vanilla view. */
const VANILLA_CONTROL: Readonly<Record<(typeof DESTRUCTIVE_ACTIONS)[number], string>> = {
  'delete-agent': 'data-delete-agent',
  'uninstall-approach': 'data-uninstall',
  'discard-approach': 'id="approachDrawerDelete"',
  'remove-preset': 'data-remove-preset',
  'remove-service': 'data-remove-service',
  'remove-port': 'data-remove-port',
  'remove-binding': 'data-remove-bind',
  'remove-dependency': 'data-remove-dep',
  'remove-signal': 'data-remove-signal',
  'remove-gate': 'data-remove-gate',
  'remove-override': 'data-remove-override',
};

const vanillaHtml = readFileSync(join(HERE, 'webview.html'), 'utf8');

/**
 * Every control the vanilla view renders with the shared danger variant,
 * identified by whichever handle its opening tag carries.
 *
 * Scoped to the enclosing tag rather than to the `--danger` string itself,
 * because the vanilla markup is built by string concatenation and the danger
 * class is often followed by a size modifier before the handle: the class order
 * is `k-btn k-btn--danger k-btn--sm` on one line and `class="ctx-item
 * k-btn--danger"` on another. Scraping a fixed distance from the class token
 * silently finds nothing on the second shape and quietly drops the control from
 * the taxonomy — which is the exact drift this test exists to catch.
 */
function vanillaDangerControls(html: string): string[] {
  const found = new Set<string>();
  const TOKEN = '--danger';
  for (let i = html.indexOf(TOKEN); i !== -1; i = html.indexOf(TOKEN, i + TOKEN.length)) {
    const start = html.lastIndexOf('<', i);
    const end = html.indexOf('>', i + TOKEN.length);
    if (start === -1 || end === -1) continue;
    const tag = html.slice(start, end);
    const data = tag.match(/\bdata-([a-z][a-z-]*)=/);
    const id = tag.match(/\bid="([^"]+)"/);
    found.add(data ? `data-${data[1]}` : (id ? `id="${id[1]}"` : 'UNIDENTIFIED'));
  }
  return [...found].sort();
}

const VANILLA_DANGER_CONTROLS = vanillaDangerControls(vanillaHtml);

describe('DestructiveAction taxonomy', () => {
  it('is non-empty and has no duplicate members', () => {
    expect(DESTRUCTIVE_ACTIONS.length).toBeGreaterThan(0);
    expect(new Set(DESTRUCTIVE_ACTIONS).size).toBe(DESTRUCTIVE_ACTIONS.length);
  });

  it('maps every member to a control the vanilla view actually renders', () => {
    for (const action of DESTRUCTIVE_ACTIONS) {
      const attr = VANILLA_CONTROL[action];
      expect(attr, `${action} has no mapped vanilla control`).toBeDefined();
      expect(vanillaHtml, `${action} -> ${attr} is not in webview.html`).toContain(attr);
    }
  });

  it('covers every danger-variant control the vanilla view has', () => {
    // The reverse direction: a danger control with no taxonomy member would be a
    // destructive action the React port could render with the wrong treatment.
    expect(VANILLA_DANGER_CONTROLS.length).toBeGreaterThan(0);
    expect(VANILLA_DANGER_CONTROLS).not.toContain('UNIDENTIFIED');
    const mapped = DESTRUCTIVE_ACTIONS.map((a) => VANILLA_CONTROL[a]).sort();
    expect(mapped).toEqual(VANILLA_DANGER_CONTROLS);
  });

  it('agrees with the message union in both directions', () => {
    for (const type of DESTRUCTIVE_MESSAGE_TYPES) {
      // Every declared destructive message type is a real, parseable message…
      expect(
        parseSettingsMessage({ type, name: 'a', id: 'b' }),
        `${type} is not accepted by parseSettingsMessage`,
      ).not.toBeNull();
      // …and it is classified as destructive.
      expect(
        DESTRUCTIVE_ACTIONS.includes(type),
        `${type} crosses postMessage but is missing from DESTRUCTIVE_ACTIONS`,
      ).toBe(true);
    }
  });

  it('drops a taxonomy member that is not a message type and not a local control', () => {
    const localOnly = DESTRUCTIVE_ACTIONS.filter(
      (a) => !(DESTRUCTIVE_MESSAGE_TYPES as readonly string[]).includes(a),
    );
    for (const action of localOnly) {
      expect(DESTRUCTIVE_MESSAGE_TYPES as readonly string[]).not.toContain(action);
      expect(VANILLA_CONTROL[action], `${action} is neither a message nor a local control`)
        .toBeDefined();
    }
  });

  it('leaves clear-token OUT of the taxonomy (parity with the secondary treatment)', () => {
    // Pinned on purpose. `clear-token` destroys a stored credential and so meets
    // R10b's definition, but the vanilla view ships it as `k-btn--secondary` and
    // the phase 4 gate compares baselines against that render. Treating it here
    // would smuggle a visible change into a migration that must be additive.
    expect(DESTRUCTIVE_ACTIONS).not.toContain('clear-token');
    expect(vanillaHtml).toContain('id="clearTokenBtn"');
    expect(isDestructiveAction('clear-token')).toBe(false);
  });
});

describe('isDestructiveAction', () => {
  it('accepts every member and nothing else', () => {
    for (const action of DESTRUCTIVE_ACTIONS) {
      expect(isDestructiveAction(action)).toBe(true);
    }
    for (const value of ['save', 'set-token', '', 'constructor', '__proto__', null, 7, {}]) {
      expect(isDestructiveAction(value), `${JSON.stringify(value)} must not be destructive`).toBe(
        false,
      );
    }
  });
});

describe('the taxonomy is reachable from the message union', () => {
  it('every destructive message type is a member of SettingsWebviewMessage', () => {
    // Compile-time half: declaring the list against the message union's own
    // discriminant means adding a name here that the union does not carry is a
    // `tsc` error before any test runs. The runtime half — that each name is
    // still parseable — is the loop in the describe block above.
    const declared: ReadonlyArray<SettingsWebviewMessage['type']> =
      DESTRUCTIVE_MESSAGE_TYPES;
    expect(declared).toEqual([...DESTRUCTIVE_MESSAGE_TYPES]);
  });
});