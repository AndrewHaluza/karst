/**
 * The chip primitive (UI-R08: controls and their visual vocabulary have one
 * owner).
 *
 * Chips appear on the Services tab as the runtime badge ("docker" / "service" /
 * "worktree only"), the Draft marker, and each classifier signal word — and the
 * signal chip also hosts a destructive control. Two reasons this is a primitive
 * rather than markup in the section:
 *
 * - `.k-chip` is a shared DS class, and `architecture.test.ts` fails any section
 *   that emits one directly. The class and its modifier belong to one file.
 * - The signal chip's Remove control is a `DestructiveButton`, so the chip has to
 *   be able to host a taxonomy-typed action without the section reaching past the
 *   primitives for the danger treatment.
 */
import type { ReactNode } from 'react';

export type ChipTone = 'neutral' | 'success';

export interface ChipProps {
  readonly tone?: ChipTone;
  /** Rendered after the label — the signal chip's Remove lives here. */
  readonly children: ReactNode;
  /** Emitted verbatim so phase 4's parity sweep can diff the chip. */
  readonly name?: string;
}

export function Chip({ tone = 'neutral', children, name }: ChipProps) {
  const className = tone === 'success' ? 'k-chip is-success' : 'k-chip';
  return (
    <span className={className} data-chip={name}>
      {children}
    </span>
  );
}