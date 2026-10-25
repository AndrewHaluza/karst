/**
 * Ship's evidence: the commit blocks (one per repository, with its provenance pill and the commits that pill speaks
 * for) and the pull-request branches (the PR object karst recorded, the recorded step path and the host's own sentence
 * saying why the row reads as it does). A snapshot without `repos` / `branches` (an older host) still renders through
 * the generic row path, so adding the bodies can never blank an existing surface.
 */
import { Fragment } from 'react';
import type { ProcessEvidenceView } from '../../../model/inside/types.js';
import { Overflow, PrState } from './EvidenceParts.js';
import { EvidenceRows } from './EvidenceRows.js';
import { ObjLink } from './InsideParts.js';
import { withKeys } from './insideText.js';

type Of<K extends ProcessEvidenceView['kind']> = Extract<ProcessEvidenceView, { kind: K }>;

export function EvidenceCommits({ ev }: { readonly ev: Of<'commits'> }) {
  if (!ev.repos || !ev.repos.length) return <EvidenceRows ev={ev} />;
  return (
    <>
      <div className="commit-grid">
        {withKeys(ev.repos, (r) => r.repo).map(([key, r]) => (
          <div className="commit-repo" key={key}>
            <div className="commit-repo-head">
              <span className="commit-repo-name">{r.repo}</span>
              <span className="commit-repo-summary">{r.summary}</span>
              {r.time ? (
                <span className="commit-time" title={`commit step started ${r.time}`}>
                  {r.time}
                </span>
              ) : null}
              <span className={`commit-origin ${r.originKind}`}>{r.origin}</span>
            </div>
            {r.commits && r.commits.length ? (
              <div className="commit-list">
                {withKeys(r.commits, (c) => c.sha).map(([ckey, c]) => (
                  <div className="commit-item" key={ckey}>
                    {c.action ? (
                      // The commit SHA IS the open control: a link, never a button (the design's "click the hash").
                      <ObjLink text={c.sha} action={c.action} cls="commit-link" title="Open this commit on the host" />
                    ) : (
                      <span className="commit-sha">{c.sha}</span>
                    )}
                    <span className="commit-message">{c.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <Overflow o={ev.overflow} />
    </>
  );
}

const Arrow = () => (
  <span className="pr-arrow" aria-hidden="true">
    →
  </span>
);

export function EvidencePrs({ ev }: { readonly ev: Of<'prs'> }) {
  if (!ev.branches || !ev.branches.length) return <EvidenceRows ev={ev} />;
  return (
    <>
      <div className="pr-branches">
        {withKeys(ev.branches, (b) => `${b.repo}/${b.number}`).map(([key, b]) => {
          const steps = b.steps || [];
          return (
            <div key={key}>
              <div className={`pr-branch${b.current ? ' current' : ''}`}>
                <span className="pr-repo">{b.repo}</span>
                <div className="pr-path">
                  {b.number ? (
                    <span className="pr-object">
                      {b.action ? <ObjLink text={b.number} action={b.action} cls="pr-link" title="Open this pull request on the host" /> : <span className="pr-link">{b.number}</span>}
                      <PrState state={b.prState} />
                    </span>
                  ) : (
                    <span className="pr-empty">{b.emptyLabel || ''}</span>
                  )}
                  {steps.length ? <Arrow /> : null}
                  {withKeys(steps, (s) => s.label).map(([skey, s], i) => (
                    <Fragment key={skey}>
                      {i > 0 ? <Arrow /> : null}
                      <span className={`pr-step ${s.state}`}>{s.label}</span>
                    </Fragment>
                  ))}
                </div>
                {/* Every expanded row dates itself, like the commit blocks beside it. */}
                {b.time ? (
                  <span className="pr-time" title={`pull-request step started ${b.time}`}>
                    {b.time}
                  </span>
                ) : null}
              </div>
              <div className="pr-branch-note">{b.note || ''}</div>
            </div>
          );
        })}
      </div>
      <Overflow o={ev.overflow} />
    </>
  );
}
