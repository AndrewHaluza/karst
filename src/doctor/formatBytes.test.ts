import { describe, expect, it } from 'vitest';
import { formatDoctorBytes } from './formatBytes.js';

describe('formatDoctorBytes', () => {
  it('prints whole bytes below 1 KB', () => {
    expect(formatDoctorBytes(0)).toBe('0 B');
    expect(formatDoctorBytes(100)).toBe('100 B');
    expect(formatDoctorBytes(1023)).toBe('1023 B');
  });

  it('prints one decimal of KB from 1024 B', () => {
    expect(formatDoctorBytes(1024)).toBe('1.0 KB');
    expect(formatDoctorBytes(1536)).toBe('1.5 KB');
    expect(formatDoctorBytes(1024 ** 2 - 1)).toBe('1024.0 KB');
  });

  it('prints one decimal of MB from 1 MiB', () => {
    expect(formatDoctorBytes(1024 ** 2)).toBe('1.0 MB');
    expect(formatDoctorBytes(64 * 1024 * 1024)).toBe('64.0 MB');
    expect(formatDoctorBytes(1024 ** 3 - 1)).toBe('1024.0 MB');
  });

  it('prints one decimal of GB from 1 GiB', () => {
    expect(formatDoctorBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatDoctorBytes(8 * 2 ** 30)).toBe('8.0 GB');
    expect(formatDoctorBytes(10 * 1024 ** 3)).toBe('10.0 GB');
  });
});
