/**
 * The ⓘ details toggle of a pull request line and its popover (a local toggle: nothing is posted). The
 * popover states only what the host already sent: branches, the full stamps, the checks title and the
 * merge-block reason; its footer reuses the `open-pr` and `copy-pr-url` acts. Esc or a click outside closes
 * it and returns focus to the toggle.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { PrPanelRow } from '../../../model/prPanelView.js';
import { CopyUrl, OpenLink } from './PrActionButtons.js';
import { Icon } from './Icon.js';
import { placeBelow } from './placeBelow.js';

const POPOVER_WIDTH = 300;

/** One labelled fact; a missing fact renders nothing. */
function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  if (!value) return null;
  return (
    <div className="pinfo-fact">
      <span className="pinfo-k">{label}</span>
      <span className="pinfo-v">{value}</span>
    </div>
  );
}

/** The stamps the popover lists in full: the tooltip text when the host sent one, else the short stamp. */
function stampFacts(p: PrPanelRow): ReadonlyArray<readonly [string, string]> {
  return [
    ['Opened', p.openedTitle || p.opened],
    ['Merged', p.mergedTitle || p.merged],
    ['Dismissed', p.dismissedLabel],
  ];
}

interface PrInfoProps {
  readonly p: PrPanelRow;
  readonly open: boolean;
  readonly onToggle: (repo: string, open: boolean) => void;
}

export function PrInfo({ p, open, onToggle }: PrInfoProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const repo = p.repo;
  useLayoutEffect(() => {
    if (open && popRef.current && buttonRef.current) placeBelow(popRef.current, buttonRef.current, POPOVER_WIDTH);
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (): void => {
      onToggle(repo, false);
      buttonRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent): void => {
      // The overlay stack claims Escape (preventDefault) when it closes an overlay: that press is spent.
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    };
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && (popRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      onToggle(repo, false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open, onToggle, repo]);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="k-iconbtn ib pinfo-btn"
        data-act="toggle-pr-info"
        data-repo={repo}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Pull request details"
        title="Pull request details"
        onClick={() => onToggle(repo, !open)}
      >
        <Icon name="info-circle" size={13} />
      </button>
      {open ? (
        <div ref={popRef} className="pinfo-pop" role="dialog" aria-label="Pull request details">
          <Fact label="Branches" value={p.branches} />
          {stampFacts(p).map(([label, value]) => (
            <Fact key={label} label={label} value={value} />
          ))}
          <Fact label="Checks" value={p.checks.title} />
          <Fact label="Merge" value={p.mergeBlockedReason} />
          {p.url ? (
            <div className="pinfo-foot">
              <OpenLink url={p.url} title="Open this pull request on GitHub">
                Open on GitHub
              </OpenLink>
              <CopyUrl url={p.url} label="Copy URL" />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
