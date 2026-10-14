import { describe, expect, it } from 'vitest';
import { dockerNames } from './dockerNames.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import {
  listRelayPorts, parseRelayPorts, publishRelay, relayName, relayRunArgs, removeAllRelays, unpublishRelay,
} from './dockerPorts.js';

const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' });
const m = { hostPort: 4100, sandboxPort: 3000 };

describe('dockerPorts relay (arch:AC-32)', () => {
  it('publishes ONE declared port on 127.0.0.1 from an unprivileged relay labelled for its container', () => {
    const args = relayRunArgs(names, m);
    expect(args.slice(0, 4)).toEqual(['run', '--detach', '--name', relayName(names, m)]);
    expect(args).toEqual(expect.arrayContaining([
      '--publish', '127.0.0.1:4100:3000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--label', `karst.relay=${names.container}`, '--label', 'karst.ports=4100:3000',
      '--env', `TARGET_HOST=${names.container}`, '--env', 'TARGET_PORT=3000', '--env', 'LISTEN_PORT=3000', OPENCODE_IMAGE,
    ]));
    expect(args.filter((a) => a === '--publish')).toHaveLength(1);
    expect(args.slice(0, -1).join(' ')).not.toMatch(/0\.0\.0\.0|--privileged|docker\.sock|--network/);
    expect(relayName(names, m)).toBe(`${names.container}-port-4100`);
  });

  it('publish: replaces a stale relay, runs it, then joins it to the internal ticket network', async () => {
    const proc = fakeDockerProcess();
    await expect(publishRelay(proc, names, m)).resolves.toEqual({ ok: true });
    expect(proc.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['rm --force', 'run --detach', 'network connect']);
    expect(proc.calls[2]!.args).toEqual(['network', 'connect', names.network, relayName(names, m)]);
  });

  it('publish: a busy host port is portTaken; any other failure is not; a failed join removes the relay', async () => {
    const busy = fakeDockerProcess({ 'docker run': { code: 125, stderr: 'Bind for 127.0.0.1:4100 failed: port is already allocated' } });
    await expect(publishRelay(busy, names, m)).resolves.toMatchObject({ ok: false, portTaken: true });
    const other = fakeDockerProcess({ 'docker run': { code: 125, stderr: 'no such image' } });
    await expect(publishRelay(other, names, m)).resolves.toMatchObject({ ok: false, portTaken: false });
    const join = fakeDockerProcess({ 'docker network connect': { code: 1, stderr: 'nope' } });
    await expect(publishRelay(join, names, m)).resolves.toMatchObject({ ok: false, portTaken: false });
    expect(join.calls.at(-1)!.args).toEqual(['rm', '--force', relayName(names, m)]);
  });

  it('unpublish removes exactly that relay', async () => {
    const proc = fakeDockerProcess();
    await unpublishRelay(proc, names, m);
    expect(proc.calls.map((c) => c.args)).toEqual([['rm', '--force', relayName(names, m)]]);
  });

  it('lists running relays of this container only; null when docker cannot answer', async () => {
    expect(parseRelayPorts('4100:3000\nbad\n4101:3001\n\n')).toEqual([
      { hostPort: 4100, sandboxPort: 3000 }, { hostPort: 4101, sandboxPort: 3001 },
    ]);
    const proc = fakeDockerProcess({ 'docker ps': { stdout: '4100:3000\n' } });
    await expect(listRelayPorts(proc, names)).resolves.toEqual([m]);
    expect(proc.calls[0]!.args).toEqual(['ps', '--filter', `label=karst.relay=${names.container}`, '--format', '{{.Label "karst.ports"}}']);
    await expect(listRelayPorts(fakeDockerProcess({ 'docker ps': { code: 1 } }), names)).resolves.toBeNull();
  });

  it('removes every relay of this container (and no other)', async () => {
    const proc = fakeDockerProcess({ 'docker ps': { stdout: 'a1\nb2\n' } });
    await removeAllRelays(proc, names);
    expect(proc.calls[0]!.args).toEqual(['ps', '--all', '--quiet', '--filter', `label=karst.relay=${names.container}`]);
    expect(proc.calls[1]!.args).toEqual(['rm', '--force', 'a1', 'b2']);
    const none = fakeDockerProcess();
    await removeAllRelays(none, names);
    expect(none.calls).toHaveLength(1);
  });
});
