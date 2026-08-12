import { describe, it, expect } from 'vitest';
import {
  attachmentKind,
  attachmentExtension,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './kinds.js';

describe('attachmentKind', () => {
  it('classifies every whitelisted image extension', () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(attachmentKind(`shot.${ext}`), ext).toBe('image');
    }
  });

  it('classifies every whitelisted video extension', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(attachmentKind(`clip.${ext}`), ext).toBe('video');
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(attachmentKind('SHOT.PNG')).toBe('image');
    expect(attachmentKind('Clip.MOV')).toBe('video');
  });

  it('classifies any plain-alphanumeric extension as a file', () => {
    expect(attachmentKind('notes.pdf')).toBe('file');
    expect(attachmentKind('script.sh')).toBe('file');
    expect(attachmentKind('SPEC.md')).toBe('file');
    expect(attachmentKind('archive.zip')).toBe('file');
    expect(attachmentKind('report.docx')).toBe('file');
  });

  it('rejects an extension that is not plain alphanumeric', () => {
    expect(attachmentKind('x.txt!')).toBeNull();
    expect(attachmentKind('x.txt v2')).toBeNull();
    expect(attachmentKind('x.ta\nr')).toBeNull();
  });

  // The double extension is the interesting case: only the LAST segment counts,
  // so a file dressed up as an image is classified by what it actually is.
  it('classifies by the final extension only', () => {
    expect(attachmentKind('payload.png.exe')).toBe('file');
    expect(attachmentKind('archive.tar.png')).toBe('image');
  });

  it('rejects a name with no extension', () => {
    expect(attachmentKind('screenshot')).toBeNull();
    expect(attachmentKind('')).toBeNull();
  });

  // A leading dot is the whole name, not an extension: `.png` is a dotfile.
  it('rejects a dotfile whose name looks like an extension', () => {
    expect(attachmentKind('.png')).toBeNull();
  });
});

describe('attachmentExtension', () => {
  it('returns the normalized lowercase extension for a whitelisted name', () => {
    expect(attachmentExtension('SHOT.PNG')).toBe('png');
    expect(attachmentExtension('clip.Mp4')).toBe('mp4');
  });

  it('returns the normalized lowercase extension for a generic file name', () => {
    expect(attachmentExtension('REPORT.PDF')).toBe('pdf');
    expect(attachmentExtension('script.Sh')).toBe('sh');
  });

  it('returns null for a name with no plain extension', () => {
    expect(attachmentExtension('README')).toBeNull();
    expect(attachmentExtension('x.txt!')).toBeNull();
    expect(attachmentExtension('.pdf')).toBeNull();
  });

  // The stored filename is built from this value, so it must never carry a
  // separator — that is the whole reason the user's name is not used directly.
  it('never returns a value containing a path separator', () => {
    for (const ext of [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]) {
      expect(ext).not.toMatch(/[/\\.]/);
    }
  });
});
