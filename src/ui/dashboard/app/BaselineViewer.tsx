/**
 * The review overlay's viewer (@arch:BASELINE-REVIEW): the selected entry's path, the Old / New / Difference /
 * Side by side switch, the Zoom control and ONE image stage that fits the viewer (object-fit contain), so a tall
 * screenshot never grows the overlay. Zoom 1:1 shows the natural size and scrolls inside the stage.
 */
import type { BaselineDrafts } from './baselineDrafts.js';
import { STATUS_WORD, type Row, type View } from './baselineGroups.js';
import { Icon } from './Icon.js';

const VIEW_WORD: Readonly<Record<View, string>> = { old: 'Old', new: 'New', diff: 'Difference', sbs: 'Side by side' };
const VIEWS: readonly View[] = ['old', 'new', 'diff', 'sbs'];
export const NO_PREVIEW = 'No preview for this file type — open it from Source Control.';

/** One side of an entry: an image, or the sentence that says why there is none. */
const Side = ({ src, alt, missing }: { readonly src: string; readonly alt: string; readonly missing: string }) =>
  src ? <img src={src} alt={alt} /> : <div className="blnote">{missing}</div>;

function Stage({ r, view }: { readonly r: Row; readonly view: View }) {
  if (view === 'old') return <Side src={r.oldSrc} alt={`Old ${r.label}`} missing="New file — there is no old image." />;
  if (view === 'new') return <Side src={r.newSrc} alt={`New ${r.label}`} missing="Deleted — there is no new image." />;
  if (!r.oldSrc || !r.newSrc) return <div className="blnote">{`${r.oldSrc ? 'Deleted' : 'New file'} — nothing to compare.`}</div>;
  if (view === 'sbs') {
    return (
      <div className="blsbs">
        <figure>
          <figcaption>Old</figcaption>
          <img src={r.oldSrc} alt={`Old ${r.label}`} />
        </figure>
        <figure>
          <figcaption>New</figcaption>
          <img src={r.newSrc} alt={`New ${r.label}`} />
        </figure>
      </div>
    );
  }
  // Difference: the two images stacked, `mix-blend-mode: difference` on the top one, so an unchanged pixel renders black.
  return (
    <div className="bldiff" data-note="Unchanged pixels are black.">
      <img src={r.oldSrc} alt={`Old ${r.label}`} />
      <img src={r.newSrc} alt={`Difference for ${r.label}`} />
    </div>
  );
}

export function BaselineViewer({ row, view, drafts }: { readonly row: Row; readonly view: View; readonly drafts: BaselineDrafts }) {
  const hasImage = !!(row.oldSrc || row.newSrc);
  return (
    <section className="blviewer" aria-label={`Baseline ${row.label}`}>
      <div className="blpath">
        <span className="blpath-text" title={row.path}>
          {row.path}
        </span>
        <span className="bl-status">{STATUS_WORD[row.status]}</span>
      </div>
      {row.decision === 'rejected' && row.reason ? <div className="blnote">{`Rejected: ${row.reason}`}</div> : null}
      {hasImage ? (
        <>
          <div className="bltools">
            <div className="blseg" role="group" aria-label={`Compare ${row.label}`}>
              {VIEWS.map((v) => (
                <button key={v} type="button" data-act="baseline-view" data-index={row.index} data-view={v} aria-pressed={view === v} onClick={() => drafts.setView(row.index, v)}>
                  {VIEW_WORD[v]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="k-btn k-btn--ghost k-btn--sm blzoom"
              data-act="baseline-zoom"
              aria-pressed={drafts.zoom}
              aria-label={drafts.zoom ? 'Zoom: actual size. Select to fit the window' : 'Zoom: fit to window. Select for actual size'}
              onClick={drafts.toggleZoom}
            >
              <Icon name="search" size={14} /> {drafts.zoom ? 'Zoom 1:1' : 'Zoom Fit'}
            </button>
          </div>
          <div className={drafts.zoom ? 'blstage zoom' : 'blstage'} data-view={view}>
            <Stage r={row} view={view} />
          </div>
          {view === 'diff' && row.oldSrc && row.newSrc ? <div className="blnote">Unchanged pixels are black.</div> : null}
        </>
      ) : (
        <div className="blnote">{NO_PREVIEW}</div>
      )}
    </section>
  );
}
