/**
 * An icon-only posting control. The accessible name is a REQUIRED prop and is
 * used verbatim as both `aria-label` and `title`, so the two cannot disagree
 * (UI-R21, UI-R24).
 */
import type { ReactNode } from 'react';
import { ActButton, type ActionSpec, type ActButtonProps } from './action.js';

export interface IconActProps extends Omit<ActButtonProps, 'spec' | 'className' | 'aria-label' | 'title' | 'children'> {
  readonly spec: ActionSpec;
  readonly label: string;
  readonly danger?: boolean;
  readonly children: ReactNode;
}

export function IconAct({ spec, label, danger = false, children, ...rest }: IconActProps) {
  return (
    <ActButton spec={spec} className={danger ? 'k-iconbtn k-iconbtn--danger' : 'k-iconbtn'} aria-label={label} title={label} {...rest}>
      {children}
    </ActButton>
  );
}
