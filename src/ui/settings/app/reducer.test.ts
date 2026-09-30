/**
 * Reducer behaviour (NDL-126 §3, §8 phase 2).
 *
 * The cases here are the ones the inline script's message handler encoded as
 * side effects on module-level variables. Each one has a documented failure it
 * prevents — the comments below say what breaks if the case is dropped — because
 * a reducer test that only checked "returns a state" would pass against a
 * reducer that quietly lost every one of them.
 *
 * Node environment on purpose: `reducer.ts` imports no React and no `vscode`,
 * and this file asserts that by running in plain node rather than jsdom.
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_SETTINGS_APP_STATE,
  beginSave,
  setDraftManifest,
  settingsAppReducer,
  touchField,
  type SettingsAppState,
} from './reducer.js';
import { sectionForError, shouldShowBanner } from './diagnostics.js';
import {
  EDITED_MANIFEST,
  FIXTURE_MANIFEST,
  FIXTURE_STATE_PUSH,
  HOST_MESSAGE_FIXTURES,
  TICKETING_EDITED_MANIFEST,
} from './testFixtures.js';
import { dirtySectionsOf, overlaySections, sectionsToKeep } from './draft.js';
import type { SettingsState } from '../state.js';
import { SETTINGS_SECTIONS } from '../sections.js';
import { repo as repoDef } from '../../../manifest/fixtures.js';
import type { SettingsHostMessage } from '../messages.js';

const push = (message: SettingsHostMessage, from = INITIAL_SETTINGS_APP_STATE): SettingsAppState =>
  settingsAppReducer(from, message);

/** Start from a hydrated panel: the state every message after the first assumes. */
function hydrated(): SettingsAppState {
  return push({ type: 'state', state: FIXTURE_STATE_PUSH });
}

/**
 * A panel whose user has edited the draft: push the file, then edit. Both halves
 * matter — pushing an edited manifest would only re-baseline it, because a
 * `state` push IS the file.
 */
function withDraftEdit(edited: SettingsState['manifest']): SettingsAppState {
  return setDraftManifest(hydrated(), edited);
}

/** Fold a stream from the initial state. */
function fold(...messages: readonly SettingsHostMessage[]): SettingsAppState {
  return messages.reduce(settingsAppReducer, INITIAL_SETTINGS_APP_STATE);
}

describe('settingsAppReducer — the opening state push', () => {
  it('is not hydrated until a state push lands', () => {
    expect(INITIAL_SETTINGS_APP_STATE.hydrated).toBe(false);
    expect(INITIAL_SETTINGS_APP_STATE.host).toBeNull();
    expect(push({ type: 'saved', section: 'general' }).hydrated).toBe(false);
  });

  it('hydrates, adopts the file as the baseline, and starts clean', () => {
    const s = hydrated();
    expect(s.hydrated).toBe(true);
    expect(s.draft).toEqual(FIXTURE_MANIFEST);
    expect(s.lastSaved).toEqual(FIXTURE_MANIFEST);
    expect(s.dirtySections).toEqual([]);
    expect(s.pendingSaveSection).toBeNull();
  });

  it('keeps the host push verbatim rather than re-deriving its facts (UI-R31)', () => {
    // Row labels, preset groups and inherit previews are HOST-computed; if the
    // reducer recomputed any of them the webview would be deriving host facts.
    expect(hydrated().host).toEqual(FIXTURE_STATE_PUSH);
  });

  it('never aliases the message payload — the draft is a deep copy', () => {
    const s = hydrated();
    (s.draft as unknown as Record<string, unknown>).host = 'mutated';
    expect(s.lastSaved).not.toBe(s.draft);
    expect((FIXTURE_STATE_PUSH.manifest as unknown as Record<string, unknown>).host).not.toBe(
      'mutated',
    );
  });

  it('adopts the validation verdict the push carried', () => {
    const errored = push({
      type: 'state',
      state: {
        ...FIXTURE_STATE_PUSH,
        error: 'Invalid karst.yml: portRange min exceeds max',
      } satisfies SettingsState,
    });
    expect(errored.validation).toEqual({ ok: false, error: 'Invalid karst.yml: portRange min exceeds max' });
  });
});

describe('settingsAppReducer — a later state push does not eat unsaved edits', () => {
  // The push that motivated this whole design: a state push arrives after every
  // out-of-band write (agent toggle, approach install), and replacing the draft
  // with the file silently threw away edits parked on another tab.
  it('keeps a dirty tab that an out-of-band write did not touch', () => {
    const edited = withDraftEdit(EDITED_MANIFEST);
    expect(edited.dirtySections).toEqual(['general']);

    // A push carrying the ORIGINAL file back (the file did not change — the edit
    // is only in the draft) must not wipe the edit.
    const afterOutOfBandWrite = push(
      { type: 'state', state: { ...FIXTURE_STATE_PUSH, tokenConfigured: false } },
      edited,
    );
    expect(afterOutOfBandWrite.draft.host).toBe('0.0.0.0');
    expect(afterOutOfBandWrite.dirtySections).toEqual(['general']);
  });

  it('adopts the file when the push actually carries the committed edit', () => {
    // The host saved the edit, so the push's manifest already has it and the
    // draft must follow — otherwise the tab stays dirty over saved content.
    const edited = withDraftEdit(EDITED_MANIFEST);
    const afterSave = push(
      { type: 'state', state: { ...FIXTURE_STATE_PUSH, manifest: EDITED_MANIFEST } },
      edited,
    );
    expect(afterSave.dirtySections).toEqual([]);
  });

  it('drops the section a Save is writing, because the file is authoritative for it', () => {
    // A raw draft never equals the validator's re-emitted block (its own key
    // order, defaults filled in). Keeping the saved section was what left a saved
    // tab showing unsaved changes forever.
    const edited = withDraftEdit(EDITED_MANIFEST);
    const saving = beginSave(edited, 'general');
    expect(saving.pendingSaveSection).toBe('general');

    const afterSave = push({ type: 'state', state: FIXTURE_STATE_PUSH }, saving);
    expect(afterSave.draft.host).toBe(FIXTURE_MANIFEST.host);
    expect(afterSave.dirtySections).toEqual([]);
    expect(afterSave.pendingSaveSection).toBeNull();
  });

  it('keeps OTHER dirty tabs even while one section is being saved', () => {
    const edited = withDraftEdit({
      ...TICKETING_EDITED_MANIFEST,
      host: EDITED_MANIFEST.host,
    });
    expect(edited.dirtySections).toEqual(['general', 'ticketing']);

    const saving = beginSave(edited, 'general');
    const afterSave = push({ type: 'state', state: FIXTURE_STATE_PUSH }, saving);
    // `general` was just committed, so the file wins there and the tab is clean;
    // `ticketing` was never saved, so the user's edit has to survive the push.
    expect(afterSave.draft.host).toBe(FIXTURE_MANIFEST.host);
    expect(afterSave.draft.ticketing).toEqual(TICKETING_EDITED_MANIFEST.ticketing);
    expect(afterSave.dirtySections).toEqual(['ticketing']);
  });

  it('recomputes dirty tabs from the new baseline on every push', () => {
    const edited = withDraftEdit(EDITED_MANIFEST);
    expect(edited.dirtySections).toEqual(['general']);
    // A push whose file no longer matches the draft either way still re-derives.
    const stillDirty = push({ type: 'state', state: FIXTURE_STATE_PUSH }, edited);
    expect(stillDirty.draft.host).toBe(EDITED_MANIFEST.host);
    expect(stillDirty.dirtySections).toEqual(['general']);
  });
});

describe('settingsAppReducer — independent refresh messages', () => {
  it('a models refresh does not disturb the draft or the dirty tabs', () => {
    const edited = withDraftEdit(EDITED_MANIFEST);
    const refreshed = push(
      {
        type: 'models',
        models: { claude: [], codex: [], antigravity: [], opencode: [] },
        modelCompatibility: { claude: [], codex: [], antigravity: [], opencode: [] },
        recentModels: { claude: ['claude-opus'] },
      },
      edited,
    );
    expect(refreshed.draft).toEqual(edited.draft);
    expect(refreshed.dirtySections).toEqual(['general']);
    expect(refreshed.models?.recentModels).toEqual({ claude: ['claude-opus'] });
  });

  it('a process-assignment refresh replaces the rows and nothing else', () => {
    const base = hydrated();
    const refreshed = push({ type: 'process-assignment-views', rows: [] }, base);
    expect(refreshed.processAssignments).toEqual([]);
    expect(refreshed.draft).toEqual(base.draft);
  });

  it('a validation message carries the verdict and clears the error when ok', () => {
    const failed = push(
      { type: 'validation', ok: false, error: 'Invalid karst.yml: host is required' },
      hydrated(),
    );
    expect(failed.validation).toEqual({ ok: false, error: 'Invalid karst.yml: host is required' });

    const ok = push({ type: 'validation', ok: true, error: 'ignored' }, failed);
    expect(ok.validation).toEqual({ ok: true, error: null });
  });

  it('a host error is its own banner, separate from a validation fault', () => {
    const s = push({ type: 'error', message: 'Could not read karst.yml' }, hydrated());
    expect(s.hostError).toBe('Could not read karst.yml');
    // It must NOT be promoted into the validation verdict — the manifest may be
    // perfectly valid and only the read failed.
    expect(s.validation.ok).toBe(true);
  });

  it('token-state reports the secret status without carrying the secret', () => {
    // Deliberately NOT a `state` push: state carries the manifest and replaces the
    // draft, so reporting the token that way discarded whatever the user had
    // entered but not yet saved.
    const edited = withDraftEdit(EDITED_MANIFEST);
    const cleared = push({ type: 'token-state', configured: false }, edited);
    expect(cleared.tokenConfigured).toBe(false);
    expect(cleared.draft.host).toBe('0.0.0.0');
    expect(cleared.dirtySections).toEqual(['general']);
  });

  it('the token flag can only ever be set, not cleared, by a state push', () => {
    // A push reporting the FILE cannot claim the token is gone; only
    // `token-state` is allowed to say that. Getting this backwards would make a
    // transient push resurrect a cleared-token banner.
    const cleared = push({ type: 'token-state', configured: false }, hydrated());
    const afterPush = push({ type: 'state', state: FIXTURE_STATE_PUSH }, cleared);
    expect(afterPush.tokenConfigured).toBe(true);
  });

  it('an approach command body opens the drawer with exactly what arrived', () => {
    const s = push(
      { type: 'approach-command-body', approachId: 'tdd', command: 'start', body: '# start' },
      hydrated(),
    );
    expect(s.approachCommandBody).toEqual({ approachId: 'tdd', command: 'start', body: '# start' });
  });

  it('a new push closes the drawer it was holding open', () => {
    // The drawer offers a destructive Delete for the approach it is editing; a
    // push can mean that approach was just uninstalled out of band.
    const open = push(
      { type: 'approach-command-body', approachId: 'tdd', command: 'start', body: '# start' },
      hydrated(),
    );
    expect(open.approachCommandBody).not.toBeNull();
    expect(push({ type: 'state', state: FIXTURE_STATE_PUSH }, open).approachCommandBody).toBeNull();
  });
});

describe('settingsAppReducer — the saved ack', () => {
  it('reports which tab was committed and recomputes the dirty set', () => {
    const edited = withDraftEdit(EDITED_MANIFEST);
    const s = push({ type: 'saved', section: 'general' }, edited);
    expect(s.saved).toEqual({ section: 'general' });
    expect(s.dirtySections).toEqual(['general']); // unchanged: the file has not been pushed back yet
  });

  it('a whole-draft ack is representable without inventing a section', () => {
    const s = push({ type: 'saved' }, hydrated());
    expect(s.saved).toEqual({ section: null });
  });
});

describe('settingsAppReducer — the folder picker', () => {
  it('applies the picked path as if typed, and marks the field touched', () => {
    const s = push({ type: 'repo-path-picked', name: 'backend', path: '/abs/backend' }, hydrated());
    expect(s.draft.repositories?.backend?.repoPath).toBe('/abs/backend');
    expect(s.dirtySections).toContain('services');
    expect(s.touched).toContain('backend.repoPath');
  });

  it('ignores a path for a repository the draft no longer has', () => {
    const base = hydrated();
    const s = push({ type: 'repo-path-picked', name: 'gone', path: '/abs/gone' }, base);
    expect(s.draft).toEqual(base.draft);
    expect(s.touched).toEqual([]);
  });

  it('does not record the same field twice', () => {
    let s = hydrated();
    s = push({ type: 'repo-path-picked', name: 'backend', path: '/one' }, s);
    s = push({ type: 'repo-path-picked', name: 'backend', path: '/two' }, s);
    expect(s.draft.repositories?.backend?.repoPath).toBe('/two');
    expect(s.touched).toEqual(['backend.repoPath']);
  });
});

describe('settingsAppReducer — the ticketing status fetch', () => {
  const base = () => withDraftEdit(TICKETING_EDITED_MANIFEST);

  it('fills both statuses so a toggled-on ticketing config is never invalid', () => {
    // Statuses arriving with nothing chosen on either side would leave an
    // invalid draft — shipping with an empty shipStatus.
    const s = push({ type: 'ticket-statuses', statuses: ['open', 'in progress'] }, base());
    expect(s.draft.ticketing?.shipStatus).toBe('open');
    expect(s.draft.ticketing?.startStatus).toBe('in progress');
    expect(s.statuses).toEqual({ kind: 'ready', statuses: ['open', 'in progress'] });
  });

  it('leaves an explicitly chosen status alone', () => {
    const chosen = withDraftEdit({
      ...TICKETING_EDITED_MANIFEST,
      ticketing: {
        provider: 'clickup',
        listId: 'L1',
        teamId: 'T1',
        shipStatus: 'done',
      },
    });
    const s = push({ type: 'ticket-statuses', statuses: ['open', 'in progress'] }, chosen);
    expect(s.draft.ticketing?.shipStatus).toBe('done');
  });

  it('falls back to the first status when the provider has no "in progress"', () => {
    const s = push({ type: 'ticket-statuses', statuses: ['todo', 'doing'] }, base());
    expect(s.draft.ticketing?.startStatus).toBe('todo');
  });

  it('records the statuses even when the draft has no ticketing block', () => {
    const s = push({ type: 'ticket-statuses', statuses: ['open'] }, hydrated());
    expect(s.statuses).toEqual({ kind: 'ready', statuses: ['open'] });
    expect(s.draft.ticketing).toBeUndefined();
  });

  it('a status fetch failure keeps the draft untouched and reports the error', () => {
    const b = base();
    const s = push({ type: 'ticket-statuses-error', message: 'No token configured' }, b);
    expect(s.statuses).toEqual({ kind: 'failed', error: 'No token configured' });
    expect(s.draft).toEqual(b.draft);
  });

  it('a list fetch is tracked separately from the status fetch', () => {
    let s = base();
    s = push({ type: 'ticket-lists', lists: [] }, s);
    s = push({ type: 'ticket-lists-error', message: 'Workspace unreadable' }, s);
    expect(s.lists).toEqual({ kind: 'failed', error: 'Workspace unreadable' });
    expect(s.statuses.kind).not.toBe('failed');
  });
});

describe('settingsAppReducer — action receipts (UI-R13)', () => {
  it('keeps one receipt per correlation id', () => {
    let s = hydrated();
    s = push({ type: 'action-result', requestId: 'm1', ok: true }, s);
    s = push({ type: 'action-result', requestId: 'm2', ok: false, message: 'nope' }, s);
    expect(s.receipts.m1).toEqual({ ok: true, message: null });
    expect(s.receipts.m2).toEqual({ ok: false, message: 'nope' });
  });

  it('a later receipt for the same id replaces the earlier one', () => {
    let s = push({ type: 'action-result', requestId: 'm1', ok: false, message: 'first' }, hydrated());
    s = push({ type: 'action-result', requestId: 'm1', ok: true }, s);
    expect(s.receipts.m1).toEqual({ ok: true, message: null });
  });
});

describe('settingsAppReducer — purity and totality', () => {
  it('never mutates the state it was given', () => {
    const before = hydrated();
    const snapshot = JSON.parse(JSON.stringify(before));
    for (const { message } of HOST_MESSAGE_FIXTURES) {
      settingsAppReducer(before, message);
    }
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
  });

  it('returns the identical state object when nothing changed', () => {
    // Reference equality, not just deep equality: a new object per message means
    // every connected component re-renders on every host push, which on this
    // view (hundreds of controls over one manifest) is the difference between a
    // responsive tab and a visible stall.
    const base = hydrated();
    const touched = touchField(base, 'a.b');
    expect(touchField(touched, 'a.b')).toBe(touched);
    // A draft write is never a no-op (it deep-copies on purpose), so it asserts
    // value equality instead — the shape must not drift when nothing moved.
    expect(setDraftManifest(base, base.draft)).toEqual(base);
  });

  it('is associative over a message prefix — order is the only thing that matters', () => {
    const stream: SettingsHostMessage[] = [
      { type: 'state', state: FIXTURE_STATE_PUSH },
      { type: 'repo-path-picked', name: 'backend', path: '/abs/backend' },
      { type: 'ticket-statuses', statuses: ['open', 'in progress'] },
      { type: 'action-result', requestId: 'm1', ok: true },
    ];
    const once = fold(...stream);
    const twice = fold(...stream, ...stream);
    // Replaying a settled stream must be idempotent, not double-apply.
    expect(twice.draft.repositories?.backend?.repoPath).toBe(once.draft.repositories?.backend?.repoPath);
    expect(twice.dirtySections).toEqual(once.dirtySections);
    expect(twice.receipts).toEqual(once.receipts);
  });
});

describe('draft arithmetic', () => {
  it('reports dirty tabs in nav order, not map order', () => {
    // Deliberately set `ticketing` first and `general` second: the answer must
    // follow the tab bar's order, or the nav markers and the leave-confirmation
    // list appear in an order that never matches what the user sees.
    const edited: SettingsState['manifest'] = {
      ...FIXTURE_MANIFEST,
      ticketing: { provider: 'clickup', listId: 'L1', teamId: 'T1' },
      host: '0.0.0.0',
    };
    expect(dirtySectionsOf(edited, FIXTURE_MANIFEST)).toEqual(['general', 'ticketing']);
    expect(SETTINGS_SECTIONS.indexOf('general')).toBeLessThan(
      SETTINGS_SECTIONS.indexOf('ticketing'),
    );
  });

  it('a field absent from the source is REMOVED, which is how a template is cleared', () => {
    const withTemplate = { ...FIXTURE_MANIFEST, ticketLabelTemplate: 'x' } as SettingsState['manifest'];
    const cleared = overlaySections(FIXTURE_MANIFEST, { ...FIXTURE_MANIFEST }, ['general']);
    expect(cleared.ticketLabelTemplate).toBeUndefined();
    expect('ticketLabelTemplate' in withTemplate).toBe(true);
  });

  it('keeps every dirty tab except the one being saved', () => {
    const edited: SettingsState['manifest'] = {
      ...TICKETING_EDITED_MANIFEST,
      host: EDITED_MANIFEST.host,
    };
    expect(sectionsToKeep(edited, FIXTURE_MANIFEST, 'general')).toEqual(['ticketing']);
    expect(sectionsToKeep(edited, FIXTURE_MANIFEST, null)).toEqual(['general', 'ticketing']);
  });

  it('compares values, not key order — a re-emitted block is not a dirty tab', () => {
    // The bug the order-insensitive comparison exists for: the validator re-emits
    // every nested block in its own canonical key order, while a tab editor
    // appends a newly-set key at the end of the block it spread. A JSON.stringify
    // comparison kept such a tab dirty forever after Save.
    const entry = (path: string) => repoDef({ repoPath: path, baselineBranch: 'main' });
    const a: SettingsState['manifest'] = {
      ...FIXTURE_MANIFEST,
      repositories: { a: entry('/a'), b: entry('/b') },
    };
    const b: SettingsState['manifest'] = {
      ...FIXTURE_MANIFEST,
      repositories: { b: entry('/b'), a: entry('/a') },
    };
    // Re-keyed AND re-spread: `b` is now serialized before `a`, so a
    // JSON.stringify comparison would call this tab dirty forever.
    expect(dirtySectionsOf(a, b)).toEqual([]);
  });
});

describe('error attribution (the reducer-adjacent display selectors)', () => {
  it('points a fault at the tab that owns it', () => {
    expect(sectionForError('Invalid karst.yml: repository "api" service.docker.image is required')).toBe('services');
    expect(sectionForError('Invalid karst.yml: conventions.x is not a valid form')).toBe('git');
    expect(sectionForError('Invalid karst.yml: activeAgentPreset names no preset')).toBe('presets');
    expect(sectionForError('Invalid karst.yml: processes.p1 is missing a role')).toBe('agents');
    expect(sectionForError('Invalid karst.yml: review must name a core')).toBe('quality');
    expect(sectionForError('Invalid karst.yml: portRange min exceeds max')).toBe('general');
    expect(sectionForError(null)).toBeNull();
    expect(sectionForError('Invalid karst.yml: something brand new')).toBeNull();
  });

  it('keeps a field-mapped fault silent until the user touches that field', () => {
    // Otherwise a freshly added repository shows an error before anyone typed.
    const err = 'Invalid karst.yml: repository "backend".repoPath is required';
    expect(shouldShowBanner(err, [])).toBe(false);
    expect(shouldShowBanner(err, ['backend.repoPath'])).toBe(true);
    expect(shouldShowBanner(err, ['backend.baselineBranch'])).toBe(false);
  });

  it('always shows an unmapped fault, and never shows a null one', () => {
    expect(shouldShowBanner('portRange min exceeds max', [])).toBe(true);
    expect(shouldShowBanner(null, ['anything'])).toBe(false);
    expect(shouldShowBanner('', [])).toBe(false);
  });

  it('and the selectors agree with the reducer state they read', () => {
    const err = 'Invalid karst.yml: repository "backend".repoPath is required';
    const failed = push({ type: 'validation', ok: false, error: err }, hydrated());
    const untouched = failed;
    const touched = touchField(failed, 'backend.repoPath');
    expect(shouldShowBanner(untouched.validation.error, untouched.touched)).toBe(false);
    expect(shouldShowBanner(touched.validation.error, touched.touched)).toBe(true);
    expect(sectionForError(touched.validation.error)).toBe('services');
  });
});