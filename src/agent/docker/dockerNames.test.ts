import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SSH_DOCKER_CORES } from '../sandboxCores.js';
import { sshProjectPrefix, sshSandboxName } from '../ssh/sshNames.js';
import { sbxName } from '../sbx/sbxName.js';
import { dockerNames, dockerNamesFromContainer } from './dockerNames.js';

const INSTALL_ID = 'f'.repeat(32);
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8);

describe('dockerNames', () => {
  it('suffixes every object off the sbx name', () => {
    const input = { projectRoot: '/p', ticketId: 7, core: 'opencode2' };
    const base = sbxName(input);
    expect(dockerNames(input)).toEqual({
      container: base,
      proxy: `${base}-proxy`,
      network: `${base}-net`,
      repoVolume: `${base}-repo`,
      dataVolume: `${base}-data`,
    });
  });

  it('names local docker exactly as before: the bare project root hash, no install id', () => {
    const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' });
    expect(names).toEqual({
      container: `karst-${digest('/p')}-7-opencode`,
      proxy: `karst-${digest('/p')}-7-opencode-proxy`,
      network: `karst-${digest('/p')}-7-opencode-net`,
      repoVolume: `karst-${digest('/p')}-7-opencode-repo`,
      dataVolume: `karst-${digest('/p')}-7-opencode-data`,
    });
  });

  it('throws on an unsafe core', () => {
    expect(() => dockerNames({ projectRoot: '/p', ticketId: 7, core: 'Bad Core' })).toThrow(/not a docker core/);
  });
});

describe('dockerNames installId (remote, T1399)', () => {
  it('hashes projectRoot NUL installId, the same prefix sshSandboxName produces', () => {
    const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode2', installId: INSTALL_ID });
    expect(names.container).toBe(`karst-${digest(`/p\0${INSTALL_ID}`)}-7-opencode2`);
    expect(names.container).toBe(sshSandboxName('/p', INSTALL_ID, 7, 'opencode2'));
    expect(names.container.startsWith(`${sshProjectPrefix('/p', INSTALL_ID)}-`)).toBe(true);
  });

  it('differs from the local name and from another install id on the same path', () => {
    const local = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' }).container;
    const a = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode', installId: INSTALL_ID }).container;
    const b = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode', installId: 'e'.repeat(32) }).container;
    expect(a).not.toBe(local);
    expect(b).not.toBe(a);
  });
});

describe('dockerNamesFromContainer', () => {
  it('suffixes the five objects off a validated container name', () => {
    const base = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode', installId: INSTALL_ID }).container;
    expect(dockerNamesFromContainer(base)).toEqual({
      container: base,
      proxy: `${base}-proxy`,
      network: `${base}-net`,
      repoVolume: `${base}-repo`,
      dataVolume: `${base}-data`,
    });
  });

  it.each([
    '',
    'karst-x',
    'karst-ABCDEF12-7-opencode',
    'karst-0123abcd-0-opencode',
    'karst-0123abcd-07-opencode',
    'karst-0123abcd-7-Opencode',
    'karst-0123abcd-7-opencode;rm -rf /',
    '../karst-0123abcd-7-opencode',
  ])('throws on the unsafe name %j', (base) => {
    expect(() => dockerNamesFromContainer(base)).toThrow(/unsafe container name/);
  });
});

describe('SSH_DOCKER_CORES (T1399)', () => {
  it('is the opencode pair the remote image ships, and every entry names one container', () => {
    expect(SSH_DOCKER_CORES).toEqual(['opencode', 'opencode2']);
    for (const core of SSH_DOCKER_CORES) {
      expect(dockerNames({ projectRoot: '/p', ticketId: 7, core, installId: INSTALL_ID }).container).toMatch(
        /^karst-[0-9a-f]{8}-7-opencode2?$/,
      );
    }
  });
});

describe('dockerNames core guard (F6)', () => {
  it.each(['null', 'claude', 'codex'])('rejects the non-docker core %s', (core) => {
    expect(() => dockerNames({ projectRoot: '/p', ticketId: 7, core })).toThrow(/not a docker core/);
  });

  it.each(['opencode', 'opencode2', 'antigravity', 'agy'])('accepts the docker core %s', (core) => {
    expect(() => dockerNames({ projectRoot: '/p', ticketId: 7, core })).not.toThrow();
  });
});
