import { describe, expect, it, vi } from 'vitest';

vi.mock('../manifest/load.js', () => ({ loadManifestWithDiagnostics: () => ({ manifest: { id: 'm' } }) }));
vi.mock('./writableStore.js', () => ({ openWritableStore: () => ({ close: () => undefined }), openGraphWritableStore: () => ({ close: () => undefined }) }));
vi.mock('./resolveTicket.js', () => ({ resolveTicketByKey: () => ({ id: 1 }) }));
vi.mock('../workflow/emptyWorkGuard.js', () => ({ assertTicketHasChanges: async () => undefined }));
vi.mock('../workflow/fixNoChange.js', () => ({
  applyNoChangeMarker: async () => ({ kind: 'rerun-requested', message: 'no-change verdict recorded. Stop now.' }),
}));

import { runCliAsync } from './main.js';

describe('runCliAsync, stage fix pass --no-change on the host', () => {
  it('refuses like every other marker refusal, so the marker does not transition', async () => {
    await expect(
      runCliAsync(['stage', 'fix', 'pass', '--no-change', 'r', '--db', 'x.db', '--manifest', 'k.yml', '--ticket', 'K-1'], {}),
    ).rejects.toThrow('cannot mark this stage done: no-change verdict recorded');
  });
});
