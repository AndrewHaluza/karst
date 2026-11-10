/**
 * The empty state of the Section pattern: icon, a heading that ends with a period, one sub-line. It
 * has no buttons: a header action already does what a button here would do.
 */
import { Icon } from './Icon.js';

export function EmptyState({ icon, heading, sub, tone }: { readonly icon: string; readonly heading: string; readonly sub?: string; readonly tone?: 'dead' }) {
  // The period is part of the contract: a heading without one is a label, not a sentence.
  const text = heading.endsWith('.') ? heading : `${heading}.`;
  return (
    <div className={tone === 'dead' ? 'estate dead' : 'estate'}>
      <span className="emark">
        <Icon name={icon} />
      </span>
      <div>
        <div className="ehead">{text}</div>
        {sub ? <div className="esub">{sub}</div> : null}
      </div>
    </div>
  );
}
