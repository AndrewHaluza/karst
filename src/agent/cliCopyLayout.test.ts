import { describe, it, expect } from 'vitest';
import { durableCliEntry } from './cliCopyLayout.js';

describe('durableCliEntry', () => {
  it('maps a versioned copy entry to the launcher beside the copies', () => {
    expect(durableCliEntry('/g/cli/1.0.0-0123456789ab/cli/main.js')).toBe('/g/cli/graph-launcher.mjs');
  });

  it('keeps the install path', () => {
    expect(durableCliEntry('/ext/dist/cli/main.js')).toBe('/ext/dist/cli/main.js');
  });

  it('keeps a path whose hash is not 12 hex characters', () => {
    expect(durableCliEntry('/g/cli/1.0.0-xyz/cli/main.js')).toBe('/g/cli/1.0.0-xyz/cli/main.js');
  });

  it('keeps a path that does not end in cli/main.js', () => {
    expect(durableCliEntry('/g/cli/1.0.0-0123456789ab/cli/other.js')).toBe('/g/cli/1.0.0-0123456789ab/cli/other.js');
  });

  it('keeps a path that has text before the copy root name only when the root is named cli', () => {
    expect(durableCliEntry('/g/bin/1.0.0-0123456789ab/cli/main.js')).toBe('/g/bin/1.0.0-0123456789ab/cli/main.js');
  });
});
