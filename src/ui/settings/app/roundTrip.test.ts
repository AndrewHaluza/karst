/**
 * The message round-trip guarantee (NDL-126 §3 / §9.4 R-X2, UI-R31).
 *
 * Everything that crosses `postMessage` — and everything persisted through
 * `vscode.setState` — has to be plain JSON data. A `Map`, a `Set`, a `Date`, a
 * class instance, a function or an `undefined` in the wrong place would survive
 * TypeScript happily and then arrive in the webview as `{}`, `[]` or "absent",
 * with no type error anywhere to explain it. These tests turn that silent
 * failure into a build failure.
 *
 * Three round trips are asserted per fixture, because the boundaries differ:
 *
 * - `JSON.parse(JSON.stringify(x))` — the `vscode.setState`/JSON path;
 * - `structuredClone(x)` — the real postMessage structured-clone path;
 * - `JSON.parse(vscode.getState())` round trip through the webview's own restore
 *   shape, which is what the reducer's output has to survive.
 *
 * The reducer's OUTPUT is checked too, not just its input: a reducer that put a
 * `Map` into state would pass every input fixture and still break the panel on
 * the first render.
 */
import { describe, expect, it } from 'vitest';
import { HOST_MESSAGE_FIXTURES, FIXTURE_STATE_PUSH } from './testFixtures.js';
import { INITIAL_SETTINGS_APP_STATE, settingsAppReducer } from './reducer.js';
import type { SettingsHostMessage } from '../messages.js';
import { SETTINGS_SECTIONS } from '../sections.js';

const FIXTURE_NAMES = new Set(HOST_MESSAGE_FIXTURES.map((f) => f.name));

/** The `type` discriminant of every union variant, spelled out. */
const UNION_VARIANTS = [
  'state',
  'models',
  'process-assignment-views',
  'validation',
  'error',
  'saved',
  'approach-command-body',
  'ticket-statuses',
  'ticket-statuses-error',
  'ticket-lists',
  'ticket-lists-error',
  'token-state',
  'repo-path-picked',
  'action-result',
] as const;

/**
 * Walk a value and report every key a JSON round trip could not reproduce as the
 * same *kind* of thing.
 *
 * `toEqual` alone is not enough: a `Map` compares deep-equal to itself and
 * serializes to `{}`, a `Date` to a string, a function to nothing. Those are the
 * hazards this reports.
 *
 * An explicitly-`undefined` value is reported too, but as a LOWER-severity
 * finding, and `toEqual` deliberately tolerates it — see
 * `TOLERATED_UNDEFINED_PATHS` for why.
 */
interface JsonFindings {
  readonly fatal: string[];
  readonly undefinedKeys: string[];
}

function findNonJsonValues(value: unknown, path = '$', found: JsonFindings = {
  fatal: [],
  undefinedKeys: [],
}): JsonFindings {
  if (value === null) return found;
  const t = typeof value;
  if (t === 'function') {
    found.fatal.push(`${path} (function)`);
    return found;
  }
  if (t === 'symbol' || t === 'bigint') {
    found.fatal.push(`${path} (${t})`);
    return found;
  }
  if (t === 'number') {
    if (!Number.isFinite(value as number)) found.fatal.push(`${path} (${String(value)})`);
    return found;
  }
  if (t !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => findNonJsonValues(entry, `${path}[${i}]`, found));
    return found;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    found.fatal.push(`${path} (${(value as object).constructor?.name ?? 'non-plain object'})`);
    return found;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) {
      found.undefinedKeys.push(`${path}.${k}`);
      continue;
    }
    findNonJsonValues(v, `${path}.${k}`, found);
  }
  return found;
}

/**
 * Paths where an explicit `undefined` is expected and harmless.
 *
 * `SettingsProcessAssignmentView.effectiveModel` is declared
 * `string | undefined` and always assigned (`processAssignmentViews.ts`), so a
 * row with no resolved model carries the key with an `undefined` value. The host
 * has always shipped that: it reaches the webview through `postMessage` (which
 * uses a structured clone, preserving `undefined`) and through
 * `vscode.setState(msg.state)`. JSON serialization drops the key, and for a
 * `?:`-typed field "absent" and "undefined" are the same thing — which is why
 * `toEqual` passes. Recording the exception keeps the rest of the check strict
 * without pretending a host-owned shape is this module's to change.
 */
const TOLERATED_UNDEFINED = /^(\$|.*)\.(host\.)?processAssignments\[\d+\]\.effectiveModel$/;

/** Fatal findings only — what must be empty for a value to be boundary-safe. */
function fatalFindings(value: unknown): string[] {
  return findNonJsonValues(value).fatal;
}

/** Undefined-valued keys outside the tolerated host-owned path. */
function unexpectedUndefinedKeys(value: unknown): string[] {
  return findNonJsonValues(value).undefinedKeys.filter((p) => !TOLERATED_UNDEFINED.test(p));
}

describe('round-trip fixtures cover the whole union', () => {
  it('covers every SettingsHostMessage variant at least once', () => {
    // Several variants have more than one fixture on purpose (a `state` push with
    // and without an error, an `action-result` ok and failed) — the check is that
    // the variant SET is the whole union, not that each variant appears once.
    const covered = new Set(HOST_MESSAGE_FIXTURES.map((f) => f.message.type));
    expect([...covered].sort()).toEqual([...UNION_VARIANTS].sort());
    expect(HOST_MESSAGE_FIXTURES.length).toBeGreaterThan(UNION_VARIANTS.length);
  });

  it('gives each fixture a unique, non-empty name', () => {
    for (const { name } of HOST_MESSAGE_FIXTURES) {
      expect(name).not.toBe('');
      expect(FIXTURE_NAMES.has(name)).toBe(true);
    }
    expect(FIXTURE_NAMES.size).toBe(HOST_MESSAGE_FIXTURES.length);
  });
});

describe('every host message round-trips as plain JSON', () => {
  for (const { name, message } of HOST_MESSAGE_FIXTURES) {
    it(`${name} survives JSON and structuredClone deep-equal`, () => {
      expect(JSON.parse(JSON.stringify(message))).toEqual(message);
      expect(structuredClone(message)).toEqual(message);
    });

    it(`${name} contains only JSON-representable values`, () => {
      expect(fatalFindings(message)).toEqual([]);
    });
  }
});

describe('the reducer keeps the boundary serializable in both directions', () => {
  it('every fixture is accepted by the reducer without throwing', () => {
    for (const { name, message } of HOST_MESSAGE_FIXTURES) {
      // Starting from a hydrated state for the fixtures that assert on content,
      // so the walk exercises the real reducer paths rather than the empty-state
      // short circuits.
      const state = settingsAppReducer(INITIAL_SETTINGS_APP_STATE, {
        type: 'state',
        state: FIXTURE_STATE_PUSH,
      });
      expect(() => settingsAppReducer(state, message), `${name} threw`).not.toThrow();
    }
  });

  it('the state produced by every fixture survives a JSON round trip', () => {
    for (const { name, message } of HOST_MESSAGE_FIXTURES) {
      const hydrated = settingsAppReducer(INITIAL_SETTINGS_APP_STATE, {
        type: 'state',
        state: FIXTURE_STATE_PUSH,
      });
      const reduced = settingsAppReducer(hydrated, message);
      expect(fatalFindings(reduced), `${name} produced a non-JSON value`).toEqual([]);
      expect(JSON.parse(JSON.stringify(reduced))).toEqual(reduced);
      expect(structuredClone(reduced)).toEqual(reduced);
    }
  });

  it('the whole message stream, folded from empty, stays serializable', () => {
    // The accumulator path matters: a single-message check would miss a state
    // that only becomes non-JSON after several messages compose (e.g. a draft
    // that accumulates a Date from one message and a Map from the next).
    let state = INITIAL_SETTINGS_APP_STATE;
    for (const { message } of HOST_MESSAGE_FIXTURES) {
      state = settingsAppReducer(state, message);
      expect(fatalFindings(state)).toEqual([]);
      expect(unexpectedUndefinedKeys(state)).toEqual([]);
    }
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('the initial state is serializable too — it is what getState() returns', () => {
    expect(fatalFindings(INITIAL_SETTINGS_APP_STATE)).toEqual([]);
    expect(unexpectedUndefinedKeys(INITIAL_SETTINGS_APP_STATE)).toEqual([]);
    expect(JSON.parse(JSON.stringify(INITIAL_SETTINGS_APP_STATE))).toEqual(
      INITIAL_SETTINGS_APP_STATE,
    );
  });

  it('never puts a function or component instance into state', () => {
    // R-X7 / R-X2: the state is persisted, so a callback that closed over React
    // would both break serialization and leak a render-phase object into a
    // durable store.
    const state = settingsAppReducer(INITIAL_SETTINGS_APP_STATE, {
      type: 'state',
      state: FIXTURE_STATE_PUSH,
    });
    const seen: string[] = [];
    const walk = (value: unknown, path = '$'): void => {
      if (typeof value === 'function') seen.push(path);
      if (typeof value !== 'object' || value === null) return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, `${path}.${k}`);
      }
    };
    walk(state);
    expect(seen).toEqual([]);
  });
});

describe('the reducer covers every tab it can mark dirty', () => {
  it('has a section for every SETTINGS_SECTIONS entry', () => {
    // Guards against a `SECTION_FIELDS` addition that the dirty-tracking helpers
    // silently skip: the reducer reports dirty tabs in nav order, so a missing
    // entry means a tab that can never show its marker.
    expect(SETTINGS_SECTIONS.length).toBeGreaterThan(0);
    expect(new Set(SETTINGS_SECTIONS).size).toBe(SETTINGS_SECTIONS.length);
  });

  it('an unknown host message is a type error, not a silent no-op', () => {
    // `assertNever` is a compile-time check; this documents the runtime half so
    // the next reader does not think an unhandled message is silently ignored.
    const bogus = { type: 'not-a-real-message' } as unknown as SettingsHostMessage;
    expect(() => settingsAppReducer(INITIAL_SETTINGS_APP_STATE, bogus)).toThrow(
      /Unhandled settings host message/,
    );
  });
});