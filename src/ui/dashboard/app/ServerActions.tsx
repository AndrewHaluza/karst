/**
 * The Servers panel's icon actions: one presentational button (`IconAction`) and the three
 * behaviours around it. Same DOM, classes and ARIA as the vanilla `iact` it replaced: the label is
 * the icon, so the word survives as BOTH aria-label and title (UI-R21), and a disabled button keeps
 * its reason as that word.
 */
import { useCallback, useEffect, useState, type MouseEventHandler } from 'react';
import { Icon } from './Icon.js';
import { usePendingAction } from './usePendingAction.js';

/** Each action keeps its own resting hue (docs/ui/ICONS.md §4): keyed by what the action MEANS, not its glyph. */
const TONE: Record<string, string> = {
  'external-link': 'open',
  copy: 'copy',
  refresh: 'restart',
  'player-stop': 'stop',
  'corner-down-right': 'restart',
  'player-play': 'start',
  settings: 'open',
};

/** How long the optimistic copy confirmation holds. */
const COPIED_MS = 1200;

export interface IconActionProps {
  /** Named like the attribute it renders so every action stays a literal `data-act="…"` at its call site (the parity coverage guard reads them). */
  readonly 'data-act': string;
  readonly id?: number | null;
  readonly label: string;
  readonly icon: string;
  readonly disabledWhy?: string | null;
}

interface ShapeProps extends IconActionProps {
  readonly onClick?: MouseEventHandler<HTMLButtonElement>;
  readonly copy?: boolean;
  readonly copied?: boolean;
}

function IconAction({ 'data-act': act, id, label, icon, disabledWhy, onClick, copy, copied }: ShapeProps) {
  const why = disabledWhy || null;
  const word = copied ? 'Copied' : (why ?? label);
  return (
    <button
      type="button"
      // The copy flash is a data attribute, never a className change: React rewriting className would wipe
      // the runtime's `is-pending` class while the request is in flight.
      className={`k-iconbtn ib t-${TONE[icon] ?? 'open'}`}
      data-act={act}
      data-id={id ?? undefined}
      data-copy={copy ? '' : undefined}
      data-copied={copied ? '' : undefined}
      disabled={copied || why !== null}
      aria-label={word}
      title={why ?? label}
      onClick={onClick}
    >
      <Icon name={copied ? 'check' : icon} />
    </button>
  );
}

interface PostProps extends IconActionProps {
  /** Receives the request id to stamp on the outbound message. */
  readonly post: (requestId: string) => void;
}

/** A host-posting action: pending on click via the runtime's primitives, settled by the host's `action-result`. */
export function PostAction({ post, ...shape }: PostProps) {
  const onClick = usePendingAction(post);
  return <IconAction {...shape} onClick={onClick} />;
}

/** Optimistic (UI-R15): the host does the clipboard write and cannot fail in a way the user must act on. */
export function CopyAction({ post, ...shape }: PostProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const onClick = usePendingAction(
    useCallback(
      (requestId: string) => {
        post(requestId);
        setCopied(true);
      },
      [post],
    ),
  );
  return <IconAction {...shape} copy copied={copied} onClick={onClick} />;
}

/** A purely local action (opens a surface that lives in the page script): no request, no pending. */
export function LocalAction({ run, ...shape }: IconActionProps & { readonly run: () => void }) {
  const onClick = useCallback(() => run(), [run]);
  return <IconAction {...shape} onClick={onClick} />;
}
