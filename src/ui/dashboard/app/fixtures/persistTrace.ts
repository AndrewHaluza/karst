/**
 * A `setState` double that reads the persisted envelope back as the announcements it carries: the stage selection and
 * the artifact view, each listed once per CHANGE from what was restored (a write that repeats the previous value adds
 * nothing, so the writes a snapshot push makes beside the view state do not show up as announcements).
 */
import { vi, type Mock } from 'vitest';
import type { PersistArt } from '../overlayStack.js';
import type { PersistSel } from '../stageSelection.js';
import { readPersisted } from '../viewPersistence.js';

export interface PersistTrace {
  readonly setState: Mock<(state: unknown) => void>;
  /** The selection written, per change. */
  readonly sel: PersistSel[];
  /** The artifact view and scroll memory written, per change. */
  readonly art: PersistArt[];
}

type Envelope = { sel: string | null; shipWait: string | null; artView: PersistArt['artView']; artScrolls: PersistArt['artScrolls'] };

/** `persisted` is the view state the harness's `getState()` hands back beside the snapshot. */
export function tracePersist(persisted: Record<string, unknown> = {}): PersistTrace {
  const sel: PersistSel[] = [];
  const art: PersistArt[] = [];
  const restored = readPersisted({ state: {}, ...persisted });
  let lastSel = JSON.stringify({ sel: restored.sel, shipWait: restored.shipWait });
  let lastArt = JSON.stringify({ artView: restored.art, artScrolls: restored.scrolls });
  const setState = vi.fn((state: unknown) => {
    const envelope = state as Envelope;
    const nextSel = JSON.stringify({ sel: envelope.sel, shipWait: envelope.shipWait });
    if (nextSel !== lastSel) {
      lastSel = nextSel;
      sel.push({ sel: envelope.sel, shipWait: envelope.shipWait });
    }
    const nextArt = JSON.stringify({ artView: envelope.artView, artScrolls: envelope.artScrolls });
    if (nextArt !== lastArt) {
      lastArt = nextArt;
      art.push({ artView: envelope.artView, artScrolls: envelope.artScrolls });
    }
  });
  return { setState, sel, art };
}
