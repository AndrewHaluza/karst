import { describe, it, expect } from 'vitest';
import {
  scanPorcelainForDenied,
  describeDenyHits,
  SHIP_DENY_HIT_LIMIT,
  type DenyHit,
} from './shipDenyScan.js';

describe('scanPorcelainForDenied', () => {
  it('detects .env', () => {
    const hits = scanPorcelainForDenied('?? .env\n');
    expect(hits).toEqual([{ path: '.env', rule: 'dotenv' }]);
  });

  it('exempts .env.example / .env.sample / .env.template / .env.dist', () => {
    const hits = scanPorcelainForDenied(
      '?? .env.example\n?? .env.sample\n?? .env.template\n?? .env.dist\n',
    );
    expect(hits).toEqual([]);
  });

  it('detects .env.local in a subdirectory', () => {
    const hits = scanPorcelainForDenied('?? config/.env.local\n');
    expect(hits).toEqual([{ path: 'config/.env.local', rule: 'dotenv' }]);
  });

  it('detects .pem files', () => {
    const hits = scanPorcelainForDenied('?? certs/server.pem\n');
    expect(hits).toEqual([{ path: 'certs/server.pem', rule: 'private-key' }]);
  });

  it('detects id_rsa', () => {
    const hits = scanPorcelainForDenied('?? id_rsa\n');
    expect(hits).toEqual([{ path: 'id_rsa', rule: 'private-key' }]);
  });

  it('detects credentials.json', () => {
    const hits = scanPorcelainForDenied('?? credentials.json\n');
    expect(hits).toEqual([{ path: 'credentials.json', rule: 'credentials-file' }]);
  });

  it('detects .ssh/known_hosts via the directory segment', () => {
    const hits = scanPorcelainForDenied('?? .ssh/known_hosts\n');
    expect(hits).toEqual([{ path: '.ssh/known_hosts', rule: 'sensitive-dir' }]);
  });

  it('ignores tracked modifications ( M)', () => {
    // A tracked file is already published and is deliberately never scanned.
    const hits = scanPorcelainForDenied(' M .env\n');
    expect(hits).toEqual([]);
  });

  it('detects staged-but-uncommitted files (A  )', () => {
    // A file staged via `git add` but not yet committed will be committed by
    // `prepareCommitInQuarantine` — it must be scanned.
    const hits = scanPorcelainForDenied('A  .env\n');
    expect(hits).toEqual([{ path: '.env', rule: 'dotenv' }]);
  });

  it('detects staged-and-modified files (AM)', () => {
    const hits = scanPorcelainForDenied('AM .env\n');
    expect(hits).toEqual([{ path: '.env', rule: 'dotenv' }]);
  });

  it('strips git quotes from paths', () => {
    const hits = scanPorcelainForDenied('?? ".env.dev"\n');
    expect(hits).toEqual([{ path: '.env.dev', rule: 'dotenv' }]);
  });

  it('returns [] for empty input', () => {
    expect(scanPorcelainForDenied('')).toEqual([]);
    expect(scanPorcelainForDenied('\n')).toEqual([]);
  });

  it('returns [] for ordinary source files', () => {
    const hits = scanPorcelainForDenied('?? src/index.ts\n?? README.md\n');
    expect(hits).toEqual([]);
  });

  it('returns hits in input order for mixed input', () => {
    const hits = scanPorcelainForDenied(
      '?? src/a.ts\n M src/b.ts\n?? .env\n?? certs/k.key\n',
    );
    expect(hits).toEqual([
      { path: '.env', rule: 'dotenv' },
      { path: 'certs/k.key', rule: 'private-key' },
    ]);
  });

  it('matches case-insensitively on basename (.ENV)', () => {
    const hits = scanPorcelainForDenied('?? .ENV\n');
    expect(hits).toEqual([{ path: '.ENV', rule: 'dotenv' }]);
  });

  it('detects a mix of untracked and staged denied files', () => {
    const hits = scanPorcelainForDenied(
      'A  .env\n M src/a.ts\n?? .ssh/id_rsa\nAM secrets.pem\n',
    );
    expect(hits).toEqual([
      { path: '.env', rule: 'dotenv' },
      { path: '.ssh/id_rsa', rule: 'private-key' },
      { path: 'secrets.pem', rule: 'private-key' },
    ]);
  });
});

describe('describeDenyHits', () => {
  it('lists all paths and rules for a small hit set', () => {
    const hits: DenyHit[] = [
      { path: '.env', rule: 'dotenv' },
      { path: 'certs/key.pem', rule: 'private-key' },
    ];
    const msg = describeDenyHits(hits, '/repo/frontend');
    expect(msg).toContain('2 untracked or staged file(s)');
    expect(msg).toContain('.env (dotenv)');
    expect(msg).toContain('certs/key.pem (private-key)');
    expect(msg).toContain('/repo/frontend');
    expect(msg).not.toContain('more');
  });

  it('truncates at the limit and appends "+N more"', () => {
    const hits: DenyHit[] = Array.from({ length: 12 }, (_, i) => ({
      path: `dir${i}/.env`,
      rule: 'dotenv' as const,
    }));
    const msg = describeDenyHits(hits, '/repo');
    expect(msg).toContain('12 untracked or staged file(s)');
    expect(msg).toContain('+2 more');
    // The 11th hit (index 10) should be absent from the listed paths.
    expect(msg).not.toContain('dir10/.env');
    // The 10th hit (index 9) should be present.
    expect(msg).toContain('dir9/.env');
  });

  it('returns empty string for empty hits array', () => {
    expect(describeDenyHits([], '/repo')).toBe('');
  });
});
