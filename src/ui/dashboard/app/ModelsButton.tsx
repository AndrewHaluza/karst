/**
 * The header's Models button (T1413): one icon button in `.headerActions` for every agent-role identity that differs
 * from the implementation model (plus a graph ticket's Expert / Worker / Fast), replacing the row-2 chips that used to
 * ellipsise their labels. Hovering (300 ms) or focusing it reveals a card with the full `core · model` labels
 * (`@ui:UI-R22`, `@ui:UI-R44`); clicking toggles it, Escape closes it, and only one header surface is open at a time.
 *
 * The button has no `data-tip` and no `title`: the card is the tooltip, so two surfaces never show at once.
 */
import { useRef } from 'react';
import { agentName, RuntimeIcon } from './AgentIcon.js';
import { capabilityGroups, modelLabel } from './capabilityGroups.js';
import { selectMeta } from './headerSlices.js';
import { useHoverCard } from './useHoverCard.js';
import { useSlice } from './useSlice.js';

/** The card's preferred width: 12 large control heights, the same width `.hoverCard` composes. */
const CARD_WIDTH = 360;
const CARD_ID = 'modelsCard';
const TITLE_ID = 'modelsCardTitle';
/** At most this many core marks on the button; a longer list keeps two and a `+N`. */
const MAX_ICONS = 3;

export function ModelsButton() {
  const meta = useSlice(selectMeta);
  const groups = meta ? capabilityGroups(meta) : [];
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const { open, show, close, triggerProps, cardProps } = useHoverCard({
    id: 'models-card',
    triggerRef,
    cardRef,
    width: CARD_WIDTH,
    enabled: groups.length > 0,
  });
  if (!meta || groups.length === 0) return null;

  const iconCount = groups.length > MAX_ICONS ? 2 : groups.length;
  const extra = groups.length - iconCount;
  const implementation = meta.capabilities.implementation;
  const name = `Models: ${groups
    .map((g) => `${g.roles.join(' · ')} ${agentName(g.provider)} ${modelLabel(meta, g.provider, g.model)}`)
    .join('; ')}`;
  return (
    <>
      <button
        id="modelsBtn"
        ref={triggerRef}
        type="button"
        className="k-iconbtn modelsBtn"
        aria-label={name}
        aria-expanded={open ? 'true' : 'false'}
        aria-describedby={open ? CARD_ID : undefined}
        onClick={() => (open ? close() : show())}
        {...triggerProps}
      >
        {groups.slice(0, iconCount).map((g) => (
          <span key={g.full} className="modelsIcon">
            <RuntimeIcon kind="agent" provider={g.provider} />
          </span>
        ))}
        {extra > 0 ? <span className="modelsMore">{`+${extra}`}</span> : null}
      </button>
      {open ? (
        <div id={CARD_ID} ref={cardRef} className="popover hoverCard modelsCard open" role="tooltip" {...cardProps}>
          <div id={TITLE_ID} className="modelsCardTitle">
            Models
          </div>
          {groups.map((g) => (
            <div key={g.full} className="modelsCardRow">
              <span className="modelsCardRoles">{g.roles.join(' · ')}</span>
              <RuntimeIcon kind="agent" provider={g.provider} />
              <span className="modelsCardModel">{`${agentName(g.provider)} · ${modelLabel(meta, g.provider, g.model)}`}</span>
            </div>
          ))}
          {implementation?.provider && implementation.model ? (
            <div className="modelsCardOther">
              {`Other roles use the implementation model: ${agentName(implementation.provider)} · ${modelLabel(meta, implementation.provider, implementation.model)}`}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
