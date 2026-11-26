/**
 * The graph launch id (T1370).
 *
 * A graph hook channel carries the ticket's `karstLaunch` query param, but the
 * dispatch path reads that param to reject a stale ticket generation. A graph
 * session is not launched by a ticket generation at all, so it needs an id of
 * its own shape: one fixed prefix that marks the event as the graph's, plus
 * the run it belongs to. The round-trip is the whole contract — a malformed or
 * foreign id parses to null, never to a half-read one.
 */

import { describe, it, expect } from 'vitest';
import { graphLaunchId, parseGraphLaunchId, isGraphLaunchId } from './graphLaunchId.js';

describe('graphLaunchId', () => {
  it('round-trips a node and a planner launch', () => {
    const node = graphLaunchId({ graphRunId: 12, runId: 345, role: 'node' });
    const planner = graphLaunchId({ graphRunId: 12, runId: 7, role: 'planner' });
    expect(parseGraphLaunchId(node)).toEqual({ graphRunId: 12, runId: 345, role: 'node' });
    expect(parseGraphLaunchId(planner)).toEqual({ graphRunId: 12, runId: 7, role: 'planner' });
    expect(isGraphLaunchId(node)).toBe(true);
    expect(isGraphLaunchId(planner)).toBe(true);
  });

  it('carries a fixed graph- prefix so a ticket generation can never be mistaken for it', () => {
    // Ticket launch ids are randomUUID(); the prefix is what dispatch keys on.
    expect(graphLaunchId({ graphRunId: 1, runId: 2, role: 'node' })).toMatch(/^graph-/);
    expect(graphLaunchId({ graphRunId: 1, runId: 2, role: 'node' })).not.toMatch(
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
    ]) {
      expect(parseGraphLaunchId(bad)).toBeNull();
    }
    expect(parseGraphLaunchId(undefined)).toBeNull();
    expect(parseGraphLaunchId(null)).toBeNull();
  });

  it('refuses an id it could not round-trip (negative or non-integer parts)', () => {
    expect(() => graphLaunchId({ graphRunId: -1, runId: 2, role: 'node' })).toThrow();
    expect(() => graphLaunchId({ graphRunId: 1.5, runId: 2, role: 'node' })).toThrow();
    expect(() => graphLaunchId({ graphRunId: 1, runId: Number.NaN, role: 'node' })).toThrow();
  });
});
