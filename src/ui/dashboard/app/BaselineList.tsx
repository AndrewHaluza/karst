/**
 * The review overlay's entry list (@arch:BASELINE-REVIEW): the chips, then the entries grouped by screenshot name with
 * one sub-row per theme. Wide, the list is a column with its own scroll; at the mid width the same groups are a native
 * select above the viewer (`.blpicker`, the shared select primitive, UI-R07). A native option cannot draw a glyph, so
 * the picker spells each decision as a word and shows the selected entry's glyph beside the select. CSS shows one of
 * the two per width tier (`BaselineOverlay.css`).
 */
import type { BaselineDrafts } from './baselineDrafts.js';
import { DECISION_GLYPH, DECISION_WORD, STATUS_WORD, themeOf, type Filter, type Group, type Row } from './baselineGroups.js';
import type { BaselineModel } from './useBaselineModel.js';

const CHIPS: readonly (readonly [Filter, string])[] = [
  ['pending', 'Needs review'],
  ['rejected', 'Rejected'],
  ['approved', 'Approved'],
  ['all', 'All'],
];

const Glyph = ({ decision }: { readonly decision: string }) => <span className={`glyph ${DECISION_GLYPH[decision]}`} role="img" aria-label={DECISION_WORD[decision]} />;

export function BaselineChips({ model, drafts }: { readonly model: BaselineModel; readonly drafts: BaselineDrafts }) {
  return (
    <div className="blchips" role="group" aria-label="Filter screenshots">
      {CHIPS.map(([f, label]) => (
        <button key={f} type="button" className="blchip" data-act="baseline-filter" data-filter={f} aria-pressed={model.filter === f} onClick={() => drafts.setFilter(f)}>
          {`${label} `}
          <span className="blcount">{model.counts[f]}</span>
        </button>
      ))}
    </div>
  );
}

/** The sub-row label: the theme folder, or the whole label for an entry that sits in none. */
const subLabel = (r: Row): string => themeOf(r.label) || r.label;

function EntryButton({ r, label, selected, onSelect }: { readonly r: Row; readonly label: string; readonly selected: boolean; readonly onSelect: (i: number) => void }) {
  return (
    <button type="button" className="blentry" data-act="baseline-select" data-index={r.index} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(r.index)}>
      <Glyph decision={r.decision} />
      <span className="blentry-label">{label}</span>
      <span className="bl-status">{STATUS_WORD[r.status]}</span>
    </button>
  );
}

function GroupBlock({ g, selected, onSelect }: { readonly g: Group; readonly selected: number | undefined; readonly onSelect: (i: number) => void }) {
  const only = g.rows[0];
  // A screenshot with one entry and no theme folder is one row, not a header with a single child.
  if (g.rows.length === 1 && only && !themeOf(only.label)) {
    return (
      <div className="blgroup">
        <EntryButton r={only} label={g.name} selected={only.index === selected} onSelect={onSelect} />
      </div>
    );
  }
  return (
    <div className="blgroup" role="group" aria-label={g.name}>
      <div className="blgroup-head">
        <Glyph decision={g.decision} />
        <span className="blgroup-name" title={g.name}>
          {g.name}
        </span>
        <span className="blcount">{g.rows.length}</span>
      </div>
      {g.rows.map((r) => (
        <EntryButton key={r.index} r={r} label={subLabel(r)} selected={r.index === selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function BaselineList({ model, drafts }: { readonly model: BaselineModel; readonly drafts: BaselineDrafts }) {
  const selected = model.selected?.index;
  return (
    <>
      <div className="bllist" data-region="baseline-list">
        {model.groups.length === 0 ? <div className="blnote">Nothing here.</div> : null}
        {model.groups.map((g) => (
          <GroupBlock key={g.name} g={g} selected={selected} onSelect={drafts.select} />
        ))}
      </div>
      <div className="blpicker">
        {model.selected ? <Glyph decision={model.selected.decision} /> : null}
        <select className="k-input" aria-label="Screenshot" data-act="baseline-select" value={selected ?? ''} onChange={(e) => drafts.select(Number(e.currentTarget.value))}>
          {model.groups.map((g) => (
            <optgroup key={g.name} label={g.name}>
              {g.rows.map((r) => (
                <option key={r.index} value={r.index}>
                  {`${subLabel(r)} — ${STATUS_WORD[r.status]} — ${DECISION_WORD[r.decision]}`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </>
  );
}
