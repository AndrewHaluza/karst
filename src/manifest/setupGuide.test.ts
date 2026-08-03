import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETUP_GUIDE_FILENAME, setupGuidePathFor, writeSetupGuide } from './setupGuide.js';

/**
 * The setup runbook is a SHIPPED ASSET, not a doc in this repository's own
 * tree: it is written into the target project beside its scaffolded
 * `karst.yml`, where the agent configuring THAT project reads it. These tests
 * pin the three things that make that true — the asset exists, the build
 * copies it, and scaffolding lands it next to the manifest.
 */
describe('karst.uat-review-setup.md (bundled asset)', () => {
  const rootPath = join(process.cwd(), SETUP_GUIDE_FILENAME);

  it('exists at the repo root and documents both blocks', () => {
    const body = readFileSync(rootPath, 'utf8');
    expect(body.startsWith('# ')).toBe(true);
    expect(body).toContain('uat:');
    expect(body).toContain('review:');
  });

  // Without this the asset is missing from dist/ and every scaffold throws.
  it('is copied into dist/ by the build', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/copy-assets.mjs'), 'utf8');
    expect(script).toContain(SETUP_GUIDE_FILENAME);
  });

  it('is pointed at from the manifest template, where the reader already is', () => {
    expect(readFileSync(join(process.cwd(), 'karst.example.yml'), 'utf8')).toContain(
      SETUP_GUIDE_FILENAME,
    );
  });
});

describe('writeSetupGuide', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'karst-setup-guide-'));

  it('writes the guide beside the manifest', () => {
    const dir = tmp();
    const manifestPath = join(dir, '.karst', 'karst.yml');
    mkdirSync(join(dir, '.karst'));

    const written = writeSetupGuide(manifestPath, '# guide\n');

    expect(written).toBe(setupGuidePathFor(manifestPath));
    expect(written).toBe(join(dir, '.karst', SETUP_GUIDE_FILENAME));
    expect(readFileSync(written, 'utf8')).toBe('# guide\n');
  });

  // Scaffold runs before anything exists — the manifest's own parent is created
  // by the same flow, and the guide must not depend on the order of the two.
  it('creates the parent directory when it does not exist', () => {
    const dir = tmp();
    const manifestPath = join(dir, 'nested', '.karst', 'karst.yml');

    const written = writeSetupGuide(manifestPath, '# guide\n');

    expect(readFileSync(written, 'utf8')).toBe('# guide\n');
  });

  // It is karst-generated reference, never user config: a stale copy from an
  // older install would describe behavior that has since changed.
  it('overwrites an existing copy', () => {
    const dir = tmp();
    const manifestPath = join(dir, 'karst.yml');
    writeFileSync(setupGuidePathFor(manifestPath), '# old\n');

    writeSetupGuide(manifestPath, '# new\n');

    expect(readFileSync(setupGuidePathFor(manifestPath), 'utf8')).toBe('# new\n');
  });
});
