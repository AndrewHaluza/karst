/**
 * Pinning test for the destructive-action taxonomy (UI-R10b, NDL-126 §9.1).
 *
 * A taxonomy is only load-bearing if it cannot silently drift from the controls
 * it classifies, so these assertions run in BOTH directions:
 *
 * - every taxonomy member is used by a real `DestructiveButton` in the React
 *   app (no invented members);
 * - every taxonomy member that crosses postMessage is a real message type, and
 *   every irreversible message type is IN the taxonomy (so a new irreversible
 *   message cannot ship with an unmarked control);
 * - the taxonomy covers exactly the `DestructiveButton action=` controls the
 *   app actually mounts — a drop from either side is a parity break.
 *
 * Since phase 4 the settings view IS the React app, so the "what the view
 * renders" half scans the app source: `DestructiveButton`'s `action` prop is
 * typed to this closed union (R10b's STATIC check, `tsc` — a member the
 * component cannot render silently cannot ship either), and each site emits
 * `data-karst-action` for the RUNTIME sweep. Component tests pin the emitted
 * attribute per control (AgentsSection/ApproachesSection/PresetsSection/
 * QualitySection `.test.tsx`).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESTRUCTIVE_ACTIONS,
  DESTRUCTIVE_MESSAGE_TYPES,
  isDestructiveAction,
  parseSettingsMessage,
  type SettingsWebviewMessage,
} from './messages.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every `DestructiveButton action=…` in the React app, in mount-file order.
 *
 * Two spellings the sections use: the plain `action="name"` and, where the
 * literal needs a `satisfies` annotation, `action={'name' satisfies
 * DestructiveAction}`. Only this component may carry a destructive action (R07
 * primitives own the danger variant), so scanning the app source for its
 * `action` values IS the "what does the view render" half.
 */
function appDestructiveActions(): string[] {
  const appDir = join(HERE, 'app');
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tsx')) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/action=\{?'([a-z][a-z-]+)['][^}]*\}/g)) {
          found.add(m[1]!);
        }
        for (const m of text.matchAll(/\baction="([a-z][a-z-]+)"/g)) {
          if (!text.slice(0, m.index).includes('DestructiveButton')) continue;
          found.add(m[1]!);
        }
      }
    }
  };
  walk(appDir);
  return [...found].sort();
}

const APP_DESTRUCTIVE_ACTIONS = appDestructiveActions();

describe('DestructiveAction taxonomy', () => {
  it('is non-empty and has no duplicate members', () => {
    expect(DESTRUCTIVE_ACTIONS.length).toBeGreaterThan(0);
    expect(new Set(DESTRUCTIVE_ACTIONS).size).toBe(DESTRUCTIVE_ACTIONS.length);
  });

  it('maps every member to a DestructiveButton the React app actually mounts', () => {
    for (const action of DESTRUCTIVE_ACTIONS) {
      expect(
        APP_DESTRUCTIVE_ACTIONS,
        `${action} is in the taxonomy but no DestructiveButton mounts it`,
      ).toContain(action);
    }
  });

  it('covers every DestructiveButton action the React app has', () => {
    // The reverse direction: a destructive control with no taxonomy member would
    // be an unclassified destructive action — and DestructiveButton's `action`
    // prop is typed to this union, so such a control could not even compile.
    expect(APP_DESTRUCTIVE_ACTIONS.length).toBeGreaterThan(0);
    expect(APP_DESTRUCTIVE_ACTIONS).toEqual([...DESTRUCTIVE_ACTIONS].sort());
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
      expect(
        APP_DESTRUCTIVE_ACTIONS,
        `${action} is neither a message nor a mounted DestructiveButton`,
      ).toContain(action);
    }
  });

  it('leaves clear-token OUT of the taxonomy (parity with the secondary treatment)', () => {
    // Pinned on purpose. `clear-token` destroys a stored credential and so meets
    // R10b's definition, but the React app ships it as the non-danger
    // `Button`/secondary treatment (TicketingSection), matching the vanilla
    // render the phase 4 gate compares baselines against. Treating it here would
    // smuggle a visible change into a migration that must be additive.
    expect(DESTRUCTIVE_ACTIONS).not.toContain('clear-token');
    expect(APP_DESTRUCTIVE_ACTIONS).not.toContain('clear-token');
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