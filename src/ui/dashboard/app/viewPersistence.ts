/**
 * The dashboard's persisted view state: the one place that writes `vscode.setState` and the one that reads it back.
 *
 * The envelope is `{ state, sel, shipWait, srvFilter, artView, artScrolls }`: the last snapshot the host pushed, saved
 * beside the view state so a reload shows the dashboard before the host re-pushes. The view state stays beside the host
 * state, never inside it: the next push is built from the DB and would silently drop it. The envelope shape is the
 * upgrade contract with every panel that was open under an older build, so it does not change.
 *
 * Writes happen on exactly the triggers the retired page script used: a non-live `state` push; a selection change once a
 * snapshot is held; a servers-filter change; an artifact-view change. A live repaint (same snapshot, fresh clocks) is
 * held, not written. Restore tolerates the pre-envelope shape (a bare snapshot) and a failing or foreign `getState()`.
 */
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import { restoreArt, type ArtScrolls, type ArtView, type PersistArt } from './overlayStack.js';
import type { PersistSel } from './stageSelection.js';

/** What `readPersisted` hands the app to start from. */
export interface PersistedView {
  readonly state: DashboardState | null;
  readonly sel: string | null;
  readonly shipWait: string | null;
  readonly srvFilter: string;
  readonly art: ArtView | null;
  readonly scrolls: ArtScrolls;
}

/** The value `vscode.setState` receives. */
export interface PersistedEnvelope {
  readonly state: DashboardState | null;
  readonly sel: string | null;
  readonly shipWait: string | null;
  readonly srvFilter: string;
  readonly artView: ArtView | null;
  readonly artScrolls: ArtScrolls;
}

const VIEW_KEYS = ['state', 'sel', 'shipWait', 'srvFilter', 'artView', 'artScrolls'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The persisted state, from whatever `getState()` returned. An object with none of the envelope's keys is a bare snapshot. */
export function readPersisted(raw: unknown): PersistedView {
  const none: PersistedView = { state: null, sel: null, shipWait: null, srvFilter: '', art: null, scrolls: restoreArt(null).scrolls };
  if (!isRecord(raw)) return none;
  if (!VIEW_KEYS.some((key) => key in raw)) return { ...none, state: raw as unknown as DashboardState };
  const state = isRecord(raw.state) ? (raw.state as unknown as DashboardState) : null;
  // Only an envelope that holds a snapshot restores an artifact view: there is nothing to show it over otherwise.
  const { art, scrolls } = restoreArt(state ? raw : null);
  return { state, sel: text(raw.sel), shipWait: text(raw.shipWait), srvFilter: typeof raw.srvFilter === 'string' ? raw.srvFilter : '', art, scrolls };
}

export class ViewPersistence {
  private lastState: DashboardState | null;
  private sel: string | null;
  private shipWait: string | null;
  private filterText: string;
  private artView: ArtView | null;
  private artScrolls: ArtScrolls;

  constructor(
    private readonly write: (envelope: PersistedEnvelope) => void,
    restored: PersistedView,
  ) {
    this.lastState = restored.state;
    this.sel = restored.sel;
    this.shipWait = restored.shipWait;
    this.filterText = restored.srvFilter;
    this.artView = restored.art;
    this.artScrolls = restored.scrolls;
  }

  /** The servers filter the panel starts from (restored, then the latest typed). */
  get srvFilter(): string {
    return this.filterText;
  }

  /** Every host message: a snapshot is held, and a real push (not a live repaint) is written. */
  receive(message: HostMessage): void {
    if (message.type !== 'state') return;
    this.lastState = message.state;
    if (message.live !== true) this.persist();
  }

  /** The stage selection changed; with no snapshot yet it waits for the first write. */
  readonly selection = (detail: PersistSel): void => {
    this.sel = detail.sel;
    this.shipWait = detail.shipWait;
    if (this.lastState) this.persist();
  };

  readonly filter = (value: string): void => {
    this.filterText = value;
    this.persist();
  };

  readonly art = (detail: PersistArt): void => {
    this.artView = detail.artView;
    this.artScrolls = detail.artScrolls;
    this.persist();
  };

  private persist(): void {
    this.write({
      state: this.lastState,
      sel: this.sel,
      shipWait: this.shipWait,
      srvFilter: this.filterText,
      artView: this.artView,
      artScrolls: this.artScrolls,
    });
  }
}
