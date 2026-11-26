/**
 * The wiring contract (T1365): the `populated` showcase variants render the
 * generated DB corpus, byte-for-byte what the exporter wrote, and the checked-in
 * files carry no private data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHOWCASE_DIR, showcaseCorpus, type ShowcaseView } from './showcase.js';
import { assertNoLeaks } from './sanitize.js';
import { VARIANTS } from '../variants.js';

const VIEWS: readonly ShowcaseView[] = ['dashboard', 'sidebar', 'usage'];

function generated(view: ShowcaseView): unknown {
  return JSON.parse(readFileSync(join(SHOWCASE_DIR, `${view}.json`), 'utf8'));
}

describe('showcaseCorpus', () => {
  it('sends exactly the generated state as one `state` message', () => {
    for (const view of VIEWS) {
      const corpus = showcaseCorpus(view);
      const stateMessages = corpus.messages.filter((m) => (m as { type?: string }).type === 'state');
      expect(stateMessages, `${view}: one state message`).toHaveLength(1);
      expect(stateMessages[0], view).toEqual({ type: 'state', state: generated(view) });
    }
  });

  it('keeps the sidebar edge side channel, so the thin resize line still renders', () => {
    expect(showcaseCorpus('sidebar').messages).toContainEqual({ type: 'edge', side: 'right' });
    expect(showcaseCorpus('dashboard').messages).toHaveLength(1);
  });

  it('carries no path, email, URL or token: the generated files are already sanitized', () => {
    for (const view of VIEWS) assertNoLeaks(generated(view), `generated/${view}.json`);
  });

  it('is the corpus of the populated variants and no other variant of those views', () => {
    for (const view of VIEWS) {
      const populated = VARIANTS[view].filter((v) => v.id === 'populated');
      expect(populated, `${view}/populated`).toHaveLength(1);
      expect(populated[0]!.corpus().messages).toEqual(showcaseCorpus(view).messages);
    }
    // The usage width tiers share the populated corpus (a width is not a second page).
    for (const id of ['populated-narrow', 'populated-tight']) {
      const tier = VARIANTS.usage.find((v) => v.id === id)!;
      expect(tier.corpus().messages, `usage/${id}`).toEqual(showcaseCorpus('usage').messages);
    }
  });
});
