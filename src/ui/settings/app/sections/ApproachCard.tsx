/**
 * One roster card (spec Edits 3 to 5): one header line, a short description,
 * and for a graph approach one summary line.
 *
 * The header line holds the label, the source chip (`npm <pkg>` or
 * `repo@ref`) or the Built-in tag, and the actions at the right. The rules the
 * card carries:
 *
 * - the card reads `approach.source` FIRST: a sourceless approach is Built-in
 *   and never shows Install or Uninstall, even when its id is in
 *   `installedIds`;
 * - an available (sourced, not installed) card shows no switch, because there
 *   is nothing to enable until it is installed; its actions are Edit and a
 *   primary Install;
 * - the switch keeps its `aria-label` and has no visible text;
 * - the graph agents, limits and planner prompt live in the Edit drawer, so
 *   the card writes nothing but the enable toggle.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { ApproachDef } from '../../../../manifest/types.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Switch } from '../primitives/Switch.js';
import { ApproachInstallActions } from './ApproachInstallActions.js';
import { PendingOutputs } from './PendingOutputs.js';
import { changedLimitCount } from './graphDrawerDraft.js';
import { modelLabel } from './presetDraft.js';

function sourceText(source: NonNullable<ApproachDef['source']>): string {
  if (source.type === 'npm') return `npm ${source.package}`;
  return `${source.repo}${source.ref ? `@${source.ref}` : ''}`;
}

export function ApproachCard({
  approach,
  installed,
  toggle,
  onToggle,
  onEdit,
}: {
  readonly approach: ApproachDef;
  readonly installed: boolean;
  readonly toggle: { readonly usable: boolean; readonly label: string };
  readonly onToggle: (next: boolean) => void;
  readonly onEdit: () => void;
}) {
  const { state } = useSettingsApp();
  const source = approach.source;
  const isInstalled = source !== undefined && installed;
  const stateClass = source === undefined ? 'builtin' : isInstalled ? 'installed' : 'available';
  const pendingView = state.host?.pendingOutputs?.[approach.id];
  const text = source === undefined ? null : sourceText(source);

  return (
    <div className={`roster-card ${stateClass}`} data-approach={approach.id}>
      <div className="approach-rail" />
      <div className="approach-body">
        <div className="approach-head" title={approach.id}>
          <span className="approach-label">{approach.label}</span>
          {text === null ? (
            <span className="approach-install builtin-tag">Built-in</span>
          ) : (
            <span className="approach-source" title={text}>
              <Chip name="approach-source">{text}</Chip>
            </span>
          )}
          <span className="approach-actions">
            {stateClass === 'available' ? null : (
              <Switch
                name={`approach-enabled-${approach.id}`}
                checked={approach.enabled !== false}
                label={toggle.label}
                disabled={!toggle.usable}
                onChange={onToggle}
              />
            )}
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
            {source === undefined ? null : <ApproachInstallActions id={approach.id} installed={isInstalled} />}
          </span>
        </div>
        {approach.description ? <ApproachDescription text={approach.description} /> : null}
        {approach.graph ? <GraphSummary approach={approach} /> : null}
        {pendingView !== undefined ? (
          <PendingOutputs approachId={approach.id} view={pendingView} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The description, clamped to 2 lines. A `More` / `Less` text button shows
 * only when the clamped text overflows.
 */
function ApproachDescription({ text }: { readonly text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return;
    setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [text, expanded]);
  return (
    <>
      <div ref={ref} className={expanded ? 'approach-desc' : 'approach-desc is-clamped'}>
        {text}
      </div>
      {overflows ? (
        <Button
          variant="text"
          size="sm"
          className="approach-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Less' : 'More'}
        </Button>
      ) : null}
    </>
  );
}

/** `expert <model> · worker <model> · …`, then `· N limit(s) changed`. */
function GraphSummary({ approach }: { readonly approach: ApproachDef }) {
  const profiles = approach.graph?.profiles ?? {};
  const changed = changedLimitCount(approach);
  const names = Object.keys(profiles);
  return (
    <div className="graph-summary">
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 ? ' · ' : null}
          <span className="graph-summary-profile">{name}</span>{' '}
          {modelLabel((profiles[name]?.provider as string) || '', profiles[name]?.model)}
        </span>
      ))}
      {changed > 0 ? (
        <span className="graph-summary-changed">
          {names.length > 0 ? ' · ' : null}
          {changed} {changed === 1 ? 'limit' : 'limits'} changed
        </span>
      ) : null}
    </div>
  );
}
