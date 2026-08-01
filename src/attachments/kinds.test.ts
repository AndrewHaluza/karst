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

  it('rejects a non-whitelisted extension', () => {
    expect(attachmentKind('notes.pdf')).toBeNull();
    expect(attachmentKind('script.sh')).toBeNull();
  });

  // The double extension is the interesting case: only the LAST segment counts,
  // so a file dressed up as an image is classified by what it actually is.
  it('classifies by the final extension only', () => {
    expect(attachmentKind('payload.png.exe')).toBeNull();
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

  it('returns null for anything not whitelisted', () => {
    expect(attachmentExtension('notes.pdf')).toBeNull();
    expect(attachmentExtension('screenshot')).toBeNull();
  });

  // The stored filename is built from this value, so it must never carry a
  // separator — that is the whole reason the user's name is not used directly.
  it('never returns a value containing a path separator', () => {
    for (const ext of [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]) {
      expect(ext).not.toMatch(/[/\\.]/);
    }
  });
});
