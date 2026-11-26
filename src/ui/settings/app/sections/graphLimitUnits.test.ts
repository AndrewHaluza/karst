/**
 * Unit tests for the graph limit display units (spec Edit 2).
 *
 * The invariant: a limit value round-trips EXACTLY between the display unit and
 * the manifest seconds / bytes. `toDisplay` picks the largest unit with a whole
 * amount, `fromDisplay` gives the canonical value back.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAPH_LIMITS,
  GRAPH_COMMAND_TIMEOUT_CEILING,
  GRAPH_HARD_CEILINGS,
} from '../../../../manifest/graphConfig.js';
import {
  fromDisplay,
  humanDuration,
  limitError,
  limitHint,
  limitKind,
  toDisplay,
  unitsFor,
} from './graphLimitUnits.js';
import type { GraphLimitField } from './approachDraft.js';

const FIELDS = Object.keys(GRAPH_HARD_CEILINGS) as GraphLimitField[];

describe('limitKind', () => {
  it('classifies every limit field by its key suffix', () => {
    const kinds = Object.fromEntries(FIELDS.map((field) => [field, limitKind(field)]));
    expect(kinds).toEqual({
      maxParallel: 'count',
      maxNodeRuns: 'count',
      maxExpertRuns: 'count',
      maxReplans: 'count',
      maxActivations: 'count',
      maxGraphWallSeconds: 'duration',
      maxAgentWallSeconds: 'duration',
      maxAgentIdleSeconds: 'duration',
      maxArtifactBytes: 'bytes',
      maxLogBytes: 'bytes',
      maxAggregateArtifactBytes: 'bytes',
      maxAggregateWorkspaceBytes: 'bytes',
    });
  });

  it('gives the unit list of each kind, and none for a count', () => {
    expect(unitsFor('maxGraphWallSeconds')).toEqual(['s', 'min', 'hours']);
    expect(unitsFor('maxLogBytes')).toEqual(['KiB', 'MiB', 'GiB']);
    expect(unitsFor('maxParallel')).toEqual([]);
  });
});

describe('toDisplay', () => {
  it('picks the largest duration unit with a whole amount', () => {
    expect(toDisplay('maxGraphWallSeconds', 86400)).toEqual({ amount: 24, unit: 'hours' });
    expect(toDisplay('maxGraphWallSeconds', 3600)).toEqual({ amount: 1, unit: 'hours' });
    expect(toDisplay('maxGraphWallSeconds', 5400)).toEqual({ amount: 90, unit: 'min' });
    expect(toDisplay('maxGraphWallSeconds', 60)).toEqual({ amount: 1, unit: 'min' });
    expect(toDisplay('maxGraphWallSeconds', 5401)).toEqual({ amount: 5401, unit: 's' });
    expect(toDisplay('maxGraphWallSeconds', 59)).toEqual({ amount: 59, unit: 's' });
  });

  it('picks the largest byte unit with a whole amount', () => {
    expect(toDisplay('maxAggregateWorkspaceBytes', 21474836480)).toEqual({ amount: 20, unit: 'GiB' });
    expect(toDisplay('maxArtifactBytes', 104857600)).toEqual({ amount: 100, unit: 'MiB' });
    expect(toDisplay('maxArtifactBytes', 1024)).toEqual({ amount: 1, unit: 'KiB' });
    expect(toDisplay('maxArtifactBytes', 1536)).toEqual({ amount: 1.5, unit: 'KiB' });
  });

  it('shows a byte value that is whole in no unit as a fraction of KiB', () => {
    expect(toDisplay('maxLogBytes', 1000)).toEqual({ amount: 0.9765625, unit: 'KiB' });
  });

  it('shows a count as a plain number with no unit', () => {
    expect(toDisplay('maxParallel', 4)).toEqual({ amount: 4, unit: null });
  });
});

describe('fromDisplay', () => {
  it('returns canonical seconds for each duration unit', () => {
    expect(fromDisplay('maxAgentIdleSeconds', 30, 's')).toBe(30);
    expect(fromDisplay('maxAgentIdleSeconds', 30, 'min')).toBe(1800);
    expect(fromDisplay('maxAgentIdleSeconds', 2, 'hours')).toBe(7200);
  });

  it('returns canonical bytes for each byte unit', () => {
    expect(fromDisplay('maxLogBytes', 1, 'KiB')).toBe(1024);
    expect(fromDisplay('maxLogBytes', 10, 'MiB')).toBe(10485760);
    expect(fromDisplay('maxAggregateWorkspaceBytes', 20, 'GiB')).toBe(21474836480);
  });

  it('converts a non-whole amount', () => {
    expect(fromDisplay('maxGraphWallSeconds', 1.5, 'hours')).toBe(5400);
    expect(fromDisplay('maxArtifactBytes', 0.5, 'MiB')).toBe(524288);
  });

  it('returns a count unchanged', () => {
    expect(fromDisplay('maxReplans', 3, null)).toBe(3);
  });
});

describe('round trip (invariant)', () => {
  const SAMPLES = [1, 59, 60, 61, 1000, 1024, 1536, 3600, 5400, 5401, 86400, 1048575, 1048576, 21474836480];

  it('gives back the exact value for every field and sample', () => {
    for (const field of FIELDS) {
      for (const value of [...SAMPLES, DEFAULT_GRAPH_LIMITS[field], GRAPH_HARD_CEILINGS[field]]) {
        const shown = toDisplay(field, value);
        expect(fromDisplay(field, shown.amount, shown.unit), `${field} ${value}`).toBe(value);
      }
    }
  });
});

describe('limitHint', () => {
  it('reads the default and the max from the imported constants', () => {
    expect(limitHint('maxGraphWallSeconds')).toBe('default 24 h · max 72 h');
    expect(limitHint('maxAgentIdleSeconds')).toBe('default 30 min · max 2 h');
    expect(limitHint('maxArtifactBytes')).toBe('default 100 MiB · max 100 MiB');
    expect(limitHint('maxAggregateWorkspaceBytes')).toBe('default 20 GiB · max 100 GiB');
  });

  it('prints plain numbers for a count, with no time unit', () => {
    expect(limitHint('maxParallel')).toBe('default 4 · max 8');
    for (const field of FIELDS.filter((f) => limitKind(f) === 'count')) {
      expect(limitHint(field)).toBe(
        `default ${DEFAULT_GRAPH_LIMITS[field]} · max ${GRAPH_HARD_CEILINGS[field]}`,
      );
    }
  });

  it('formats the command timeout ceiling the same way', () => {
    expect(humanDuration(GRAPH_COMMAND_TIMEOUT_CEILING)).toBe('2 h');
    expect(humanDuration(90)).toBe('90 s');
    expect(humanDuration(120)).toBe('2 min');
  });
});

describe('limitError', () => {
  it('accepts a positive whole canonical value at or under the ceiling', () => {
    expect(limitError('maxActivations', 'Activations', '1000', null)).toBeNull();
    expect(limitError('maxGraphWallSeconds', 'Graph lifetime', '1.5', 'hours')).toBeNull();
  });

  it('refuses a value over the ceiling with the max in human units', () => {
    expect(limitError('maxActivations', 'Activations', '2000', null)).toBe(
      'Activations must be 1000 or less.',
    );
    expect(limitError('maxGraphWallSeconds', 'Graph lifetime', '73', 'hours')).toBe(
      'Graph lifetime must be 72 h or less.',
    );
  });

  it('refuses an empty, zero, negative or non-whole canonical value', () => {
    const message = 'Activations must be a whole number above 0.';
    expect(limitError('maxActivations', 'Activations', '', null)).toBe(message);
    expect(limitError('maxActivations', 'Activations', '0', null)).toBe(message);
    expect(limitError('maxActivations', 'Activations', '-3', null)).toBe(message);
    expect(limitError('maxActivations', 'Activations', '2.5', null)).toBe(message);
    expect(limitError('maxActivations', 'Activations', 'abc', null)).toBe(message);
    expect(limitError('maxAgentIdleSeconds', 'Agent idle time', '1.5', 's')).toBe(
      'Agent idle time must be a whole number above 0.',
    );
  });
});
