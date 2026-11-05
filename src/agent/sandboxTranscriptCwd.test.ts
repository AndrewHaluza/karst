import { describe, it, expect } from 'vitest';
import { sandboxCwdFor } from './sandboxTranscriptCwd.js';

const p = (backend: 'host' | 'sbx' | 'docker', sandboxName: string | null) => ({ backend, core: 'claude', sandboxName, reason: null });

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
});
