/**
 * "All presets": a read-only grid of every role's EFFECTIVE value in every
 * preset. Cells that differ from the active preset are tinted; clicking a cell
 * sets Compare to that preset.
 */
import type { Manifest } from '../../../../manifest/types.js';
import { effectiveRole } from './rolesModel.js';
import { roleText } from './RoleRows.js';

export interface PresetMatrixProps {
  readonly draft: Manifest;
  readonly names: readonly string[];
  readonly activeName: string;
  readonly roles: ReadonlyArray<{ readonly capability: string; readonly label: string }>;
  readonly onCompare: (preset: string) => void;
}

export function PresetMatrix({ draft, names, activeName, roles, onCompare }: PresetMatrixProps) {
  return (
    <div className="agents-matrix" role="table" aria-label="All presets">
      <div className="agents-matrix-head" role="row">
        <div role="columnheader">Role</div>
        {names.map((n) => (
          <div key={n} role="columnheader">
            {n}
            {n === activeName ? ' (active)' : ''}
          </div>
        ))}
      </div>
      {roles.map((role) => {
        const base = effectiveRole(draft, activeName || null, role.capability);
        return (
          <div className="agents-matrix-row" role="row" key={role.capability}>
            <div role="rowheader">{role.label}</div>
            {names.map((n) => {
              const value = effectiveRole(draft, n, role.capability);
              const differs = value.core !== base.core || value.model !== base.model || value.effort !== base.effort;
              return (
                <button
                  key={n}
                  type="button"
                  role="cell"
                  className={`agents-matrix-cell${differs ? ' differs' : ''}`}
                  onClick={() => onCompare(n)}
                  title={`Compare with ${n}`}
                >
                  {roleText(value)}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
