import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  ATTACHMENTS_ROOT,
  attachmentsRoot,
  attachmentDir,
  attachmentPath,
} from './paths.js';

const STORAGE = '/tmp/globalStorage';

describe('attachment paths', () => {
  it('roots every attachment under one directory in global storage', () => {
    expect(attachmentsRoot(STORAGE)).toBe(join(STORAGE, ATTACHMENTS_ROOT));
  });

  it('gives each ticket its own directory, named by id', () => {
    expect(attachmentDir(STORAGE, 12)).toBe(join(STORAGE, ATTACHMENTS_ROOT, '12'));
  });

  it('places a stored file inside its ticket directory', () => {
    expect(attachmentPath(STORAGE, 12, 'a3f9e1.png')).toBe(
      join(STORAGE, ATTACHMENTS_ROOT, '12', 'a3f9e1.png'),
    );
  });

  // The webview's localResourceRoots is granted on attachmentsRoot(), so every
  // per-ticket directory must actually fall inside it. If these two ever
  // disagreed, images would silently fail to load with no error anywhere.
  it('keeps every ticket directory inside the granted root', () => {
    for (const id of [1, 42, 999999]) {
      expect(attachmentDir(STORAGE, id).startsWith(attachmentsRoot(STORAGE))).toBe(true);
    }
  });
});
