import { describe, it, expect } from 'vitest';
import { sandboxCwdFor } from './sandboxTranscriptCwd.js';

const p = (backend: 'host' | 'sbx' | 'docker' | 'ssh', sandboxName: string | null) => ({ backend, core: 'claude', sandboxName, reason: null });
const remotes = { devbox: { host: 'vm', user: 'karst', mode: 'direct' as const, remoteDir: '/srv/karst/' } };

describe('sandboxCwdFor', () => {
  it('uses the sbx clone dir under the project root', () => {
    expect(sandboxCwdFor(p('sbx', 'n1'), '/p/.karst/karst.yml')).toEqual({ sandboxCwd: '/p/.karst/sbx-clones/n1' });
  });
  it('uses the docker repo mount', () => {
    expect(sandboxCwdFor(p('docker', 'n1'), '/p')).toEqual({ sandboxCwd: '/work/repo' });
  });
  it('is empty for an unnamed sbx sandbox', () => {
    expect(sandboxCwdFor(p('sbx', null), '/p')).toEqual({});
  });
  it('uses the remote repo dir for an ssh placement', () => {
    expect(sandboxCwdFor(p('ssh', 'devbox/karst-abcd1234-7-claude'), '/p', remotes)).toEqual({
      sandboxCwd: '/srv/karst/karst-abcd1234-7-claude/repo',
    });
  });
  it('is empty for an ssh placement whose remote is not in the manifest', () => {
    expect(sandboxCwdFor(p('ssh', 'devbox/karst-abcd1234-7-claude'), '/p')).toEqual({});
    expect(sandboxCwdFor(p('ssh', 'devbox/karst-abcd1234-7-claude'), '/p', {})).toEqual({});
  });
  it('uses the container repo for a docker-mode ssh placement', () => {
    const dockerRemotes = { devbox: { host: 'vm', user: 'karst', mode: 'docker' as const, remoteDir: '/srv/karst' } };
    expect(sandboxCwdFor(p('ssh', 'devbox/karst-abcd1234-7-opencode'), '/p', dockerRemotes)).toEqual({ sandboxCwd: '/work/repo' });
  });
});
