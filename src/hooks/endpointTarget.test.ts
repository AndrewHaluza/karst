/**
 * The hook request target guard (T1370): the `karstLaunch` id is the
 * endpoint's shared secret. A ticket launch id is a UUID; a graph session id
 * carries its run's UUID generation as the secret part. A graph-shaped id
 * without that part is guessable and is refused before dispatch.
 */

import { describe, it, expect } from 'vitest';
import { parseHookRequestTarget } from './endpoint.js';

const UUID = '0b9d1d0e-3f6c-4c0f-9d55-2b1f2a7c4e11';
const GEN = '019ab3c2-7d10-7e4f-8a2b-3c4d5e6f7a8b';

describe('parseHookRequestTarget — graph launch ids', () => {
  it('admits a ticket UUID launch id', () => {
    expect(parseHookRequestTarget(`/hooks?karstLaunch=${UUID}`)).toEqual({ kind: 'ok', launchId: UUID });
  });

  it('admits a graph launch id with its generation suffix', () => {
    const id = `graph-7-node-31-${GEN}`;
    expect(parseHookRequestTarget(`/hooks?karstLaunch=${id}`)).toEqual({ kind: 'ok', launchId: id });
    const planner = `graph-7-planner-4-${GEN}`;
    expect(parseHookRequestTarget(`/hooks?karstLaunch=${planner}`)).toEqual({ kind: 'ok', launchId: planner });
  });

  it.each(['graph-7-node-31', 'graph-7-node-31-notauuid', `graph-7-worker-31-${GEN}`, `graph-7-node-31-${GEN}x`])(
    'refuses %s',
    (id) => {
      expect(parseHookRequestTarget(`/hooks?karstLaunch=${id}`)).toEqual({ kind: 'bad-request' });
    },
  );
});
