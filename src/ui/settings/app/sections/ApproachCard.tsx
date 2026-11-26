/**
 * One roster card: status rail, id + label, the action cluster, and — until a
 * later change moves it into the Edit drawer — the graph configuration groups.
 *
 * Moved out of `ApproachesSection.tsx` with no behavior change. The rules the
 * card carries:
 *
 * - the enable toggle is DEAD for a sourced-but-not-installed approach, because
 *   there is nothing to enable until it is installed;
 * - the card shows `ApproachInstallActions` for an installed or sourced
 *   approach, and the Built-in tag only for a sourceless one;
 * - the graph groups are a pure child: the card forwards the section's write
 *   callbacks and the injected picker identity (catalog, recents, cores,
 *   routes), so the draft stays the single source of truth.
 */
import type { ApproachDef } from '../../../../manifest/types.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import type { AgentPickerIdentity, AgentPickerRoutes } from '../hostBridge.js';
import { Button } from '../primitives/Button.js';
import { Switch } from '../primitives/Switch.js';
import { ApproachInstallActions } from './ApproachInstallActions.js';
import { GraphDrawerSections } from './GraphDrawerSections.js';
import { PendingOutputs } from './PendingOutputs.js';
import type { GraphLimitField } from './approachDraft.js';
import { pickerCores } from './presetDraft.js';

export function ApproachCard({
  approach,
  installed,
  toggle,
  catalog,
  recent,
  cores,
  routes,
  onToggle,
  onEdit,
  onWriteProfile,
  onWriteLimit,
}: {
  readonly approach: ApproachDef;
  readonly installed: boolean;
  readonly toggle: { readonly usable: boolean; readonly label: string };
  readonly catalog: unknown;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly cores: ReturnType<typeof pickerCores>;
  readonly routes: AgentPickerRoutes;
  readonly onToggle: (next: boolean) => void;
  readonly onEdit: () => void;
  /** Write one profile's identity into the draft entry (spread, not rebuild). */
  readonly onWriteProfile: (profile: string, identity: AgentPickerIdentity) => void;
  /** Write one limit field into the draft entry; `undefined` deletes the key. */
  readonly onWriteLimit: (field: GraphLimitField, value: number | undefined) => void;
}) {
  const { state } = useSettingsApp();
  const stateClass = installed ? 'installed' : (approach.source ? 'available' : 'builtin');
  const pendingView = state.host?.pendingOutputs?.[approach.id];

  return (
    <div className={`roster-card ${stateClass}`} data-approach={approach.id}>
      <div className="approach-rail" />
      <div className="approach-body">
        <div className="approach-head" title={approach.id}>
          <span className="approach-label">{approach.label}</span>
          <span className="approach-actions">
            <Switch
              name={`approach-enabled-${approach.id}`}
              checked={approach.enabled !== false}
              label={toggle.label}
              disabled={!toggle.usable}
              onChange={onToggle}
            >
              <span>Enabled</span>
            </Switch>
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
            {installed || approach.source ? (
              <ApproachInstallActions id={approach.id} installed={installed} />
            ) : (
              <span className="approach-install builtin-tag">Built-in</span>
            )}
          </span>
        </div>
        {approach.description ? <div className="approach-desc">{approach.description}</div> : null}
        {approach.source ? (
          <div className="approach-foot">
            {approach.source.type === 'npm'
              ? `npm ${approach.source.package}`
              : `${approach.source.repo}${approach.source.ref ? `@${approach.source.ref}` : ''}`}
          </div>
        ) : null}
        {pendingView !== undefined ? (
          <PendingOutputs approachId={approach.id} view={pendingView} />
        ) : null}
        {approach.graph ? (
          <GraphDrawerSections
            approach={approach}
            catalog={catalog}
            recent={recent}
            cores={cores}
            routes={routes}
            onWriteProfile={onWriteProfile}
            onWriteLimit={onWriteLimit}
          />
        ) : null}
      </div>
    </div>
  );
}
