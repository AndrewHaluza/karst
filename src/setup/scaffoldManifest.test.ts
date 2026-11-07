import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFirstSetup, readScaffoldManifest } from './scaffoldManifest.js';

describe('scaffoldManifest', () => {
  it('loads the bundled template with the scaffold id', () => {
    expect(readScaffoldManifest()?.id).toBe('scaffold');
  });

  it('returns undefined when the template is unreadable or invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-scaffold-'));
    try {
      expect(readScaffoldManifest(join(dir, 'missing.yml'))).toBeUndefined();
      writeFileSync(join(dir, 'bad.yml'), 'repositories: {}\n');
      expect(readScaffoldManifest(join(dir, 'bad.yml'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an absent manifest and the unedited scaffold as first setup, an edited one as not', () => {
    const template = readScaffoldManifest()!;
    expect(isFirstSetup(undefined, template)).toBe(true);
    expect(isFirstSetup({ ...template, id: 'proj' }, template)).toBe(true);
    expect(isFirstSetup({ ...template, archiveDoneAfterDays: 99 }, template)).toBe(false);
    expect(isFirstSetup(template, undefined)).toBe(false);
  });
});
