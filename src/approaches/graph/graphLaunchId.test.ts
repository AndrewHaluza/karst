/**
 * The graph launch id (T1370).
 *
 * A graph hook channel carries the ticket's `karstLaunch` query param, but the
 * dispatch path reads that param to reject a stale ticket generation. A graph
 * session is not launched by a ticket generation at all, so it needs an id of
 * its own shape: one fixed prefix that marks the event as the graph's, the
 * run it belongs to, and the run's generation (the endpoint's secret part —
 * run ids alone are guessable). The round-trip is the whole contract — a malformed or
 * foreign id parses to null, never to a half-read one.
 */

import { describe, it, expect } from 'vitest';
import { graphLaunchId, parseGraphLaunchId, isGraphLaunchId } from './graphLaunchId.js';

const GEN = '019ab3c2-7d10-7e4f-8a2b-3c4d5e6f7a8b';

describe('graphLaunchId', () => {
  it('round-trips a node and a planner launch', () => {
    const node = graphLaunchId({ graphRunId: 12, runId: 345, role: 'node', generation: GEN });
    const planner = graphLaunchId({ graphRunId: 12, runId: 7, role: 'planner', generation: GEN });
    expect(node).toBe(`graph-12-node-345-${GEN}`);
    expect(parseGraphLaunchId(node)).toEqual({ graphRunId: 12, runId: 345, role: 'node', generation: GEN });
    expect(parseGraphLaunchId(planner)).toEqual({ graphRunId: 12, runId: 7, role: 'planner', generation: GEN });
    expect(isGraphLaunchId(node)).toBe(true);
    expect(isGraphLaunchId(planner)).toBe(true);
  });

  it('carries a fixed graph- prefix so a ticket generation can never be mistaken for it', () => {
    // Ticket launch ids are randomUUID(); the prefix is what dispatch keys on.
    expect(graphLaunchId({ graphRunId: 1, runId: 2, role: 'node', generation: GEN })).toMatch(/^graph-/);
    expect(graphLaunchId({ graphRunId: 1, runId: 2, role: 'node', generation: GEN })).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
  });

  it('parses a non-graph id (a ticket generation) to null', () => {
    expect(parseGraphLaunchId('0b9d1d0e-3f6c-4c0f-9d55-2b1f2a7c4e11')).toBeNull();
    expect(parseGraphLaunchId('graph-gen-1')).toBeNull();
    expect(isGraphLaunchId('0b9d1d0e-3f6c-4c0f-9d55-2b1f2a7c4e11')).toBe(false);
  });

  it('parses a malformed id to null rather than a partial one', () => {
    for (const bad of [
      '',
      'graph-',
      'graph-12',
      'graph-12-node',
      'graph-12-node-',
      'graph-x-node-3',
      'graph-12-worker-3',
      'graph-12-node-3-4',
      'graph--12-node-3',
      'graph-12-node-3 ',
      // T1370: the generation suffix is required, and must be a UUID.
      'graph-12-node-3',
      'graph-12-node-3-notauuid',
      `graph-12-node-3-${GEN} `,
      `GRAPH-12-node-3-${GEN}`,
      `graph-12-NODE-3-${GEN}`,
      `graph-12-node-3-${GEN}-x`,
    ]) {
      expect(parseGraphLaunchId(bad)).toBeNull();
    }
    expect(parseGraphLaunchId(undefined)).toBeNull();
    expect(parseGraphLaunchId(null)).toBeNull();
  });

  it('refuses an id it could not round-trip (negative or non-integer parts)', () => {
    expect(() => graphLaunchId({ graphRunId: -1, runId: 2, role: 'node', generation: GEN })).toThrow();
    expect(() => graphLaunchId({ graphRunId: 1.5, runId: 2, role: 'node', generation: GEN })).toThrow();
    expect(() => graphLaunchId({ graphRunId: 1, runId: Number.NaN, role: 'node', generation: GEN })).toThrow();
    expect(() => graphLaunchId({ graphRunId: 1, runId: 2, role: 'node', generation: 'gen-1' })).toThrow(RangeError);
    expect(() => graphLaunchId({ graphRunId: 1, runId: 2, role: 'node', generation: '' })).toThrow(RangeError);
  });
});
