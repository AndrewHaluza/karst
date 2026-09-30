/**
 * Visible help text (UI-R19).
 *
 * Required guidance is never carried by a `title` alone; it goes through this
 * visible element. `Field` wires its `id` into the control's
 * `aria-describedby`, but `Help` is also usable standalone where a field
 * already owns the association.
 */
import type { ReactNode } from 'react';

export interface HelpProps {
  children: ReactNode;
  id?: string;
}

export function Help({ children, id }: HelpProps) {
  return (
    <span className="k-field-help" id={id}>
      {children}
    </span>
  );
}