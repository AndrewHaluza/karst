/**
 * Dashboard Sandbox full-width placement strip (variant V1).
 *
 * Sits directly below the stage rail and above the 2x2 grid.
 * Displays backend tag, canonical core identity (UI-R10c), workspace and network facts.
 * Displays labelled action buttons with danger treatment on Remove (UI-R10b).
 */
import { useEffect, useRef } from 'react';
import type { DashboardSandboxView } from '../sandboxView.js';
import type { DashboardSender } from './hostBridge.js';
import { AGENT_PROVIDER_LABELS } from '../../../model/agentProviders.js';
import './SandboxStrip.css';

export interface SandboxStripProps {
  readonly sandbox: DashboardSandboxView | null;
  readonly send?: Partial<DashboardSender> | null;
}

export function SandboxStrip({ sandbox, send }: SandboxStripProps) {
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const core = sandbox?.core;

  useEffect(() => {
    if (!core) return;
    const root = iconRef.current;
    const fill = (globalThis as unknown as { agentIconInto?: (el: HTMLElement, p: string) => void })
      .agentIconInto;
    if (root && fill) {
      fill(root, core);
    }
  }, [core]);

  if (!sandbox) return null;

  const coreLabel =
    (AGENT_PROVIDER_LABELS as Record<string, string>)[sandbox.core] ??
    (sandbox.core ? sandbox.core.charAt(0).toUpperCase() + sandbox.core.slice(1) : '');

  return (
    <div
      className="sandbox-strip"
      data-testid="sandbox-strip"
      data-region="sandbox"
      role="region"
      aria-label="Sandbox"
    >
      <div className="sandbox-strip-main">
        <span className="sandbox-strip-title">
          <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5" />
            <path d="M12 12l8 -4.5" />
            <path d="M12 12l0 9" />
            <path d="M12 12l-8 -4.5" />
          </svg>
          <span>Sandbox</span>
        </span>

        <span className="sandbox-backend-tag" data-testid="sandbox-backend-tag">
          {sandbox.backend}
        </span>

        <span className="sandbox-sep" aria-hidden="true">
          ·
        </span>

        <span
          className="agentbadge"
          data-testid="sandbox-core-identity"
          title={`Agent core: ${coreLabel}`}
        >
          <span ref={iconRef} className="agenticon-island" />
          <span className="agentname">{coreLabel}</span>
        </span>

        <span className="sandbox-sep" aria-hidden="true">
          ·
        </span>

        {sandbox.workspace === 'clone' ? (
          <span
            className="sandbox-badge"
            tabIndex={0}
            role="button"
            aria-haspopup="true"
            aria-label="Filesystem Containment: Isolated Git Clone"
            title="workspace: clone"
            data-testid="sandbox-workspace-badge"
          >
            <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M7 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
              <path d="M7 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
              <path d="M16 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
              <path d="M9 8l0 8" />
              <path d="M9 12l5 0" />
            </svg>
            <span>Isolated Git Clone</span>
            <svg
              className="k-icon k-icon-chevron"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 9l6 6l6 -6" />
            </svg>

            <div className="sandbox-popover" role="tooltip">
              <div className="sandbox-popover-header">
                <svg
                  className="k-icon k-icon-success"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M7 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M7 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M16 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M9 8l0 8" />
                  <path d="M9 12l5 0" />
                </svg>
                <span>Filesystem Containment</span>
              </div>

              <div className="sandbox-popover-title">Isolation Boundary</div>
              <div className="sandbox-popover-body">
                Runs in a private, standalone Git clone inside the container. Never mounts your host worktree or shared <code>.git</code>.
              </div>

              <div className="sandbox-popover-title">Host Synchronization</div>
              <div className="sandbox-popover-body">
                Agent edits and commits remain contained in the container until you click <strong>Sync</strong> or the stage successfully finishes.
              </div>

              <div className="sandbox-popover-footer">
                <svg
                  className="k-icon k-icon-success"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M5 12l5 5l10 -10" />
                </svg>
                <span>Host workspace and git hooks are fully protected.</span>
              </div>
            </div>
          </span>
        ) : (
          <span
            className="sandbox-fact"
            title={`workspace: ${sandbox.workspace}`}
          >
            workspace: {sandbox.workspace}
          </span>
        )}

        <span className="sandbox-sep" aria-hidden="true">
          ·
        </span>

        {sandbox.network.includes('allowlist') ? (
          <span
            className="sandbox-badge"
            tabIndex={0}
            role="button"
            aria-haspopup="true"
            aria-label="Network Allowlist Perimeter: Allowlist Proxy"
            title={`network: ${sandbox.network}`}
            data-testid="sandbox-network-badge"
          >
            <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3" />
              <path d="M9 12l2 2l4 -4" />
            </svg>
            <span>Allowlist Proxy</span>
            <svg
              className="k-icon k-icon-chevron"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 9l6 6l6 -6" />
            </svg>

            <div className="sandbox-popover" role="tooltip">
              <div className="sandbox-popover-header">
                <svg
                  className="k-icon k-icon-success"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3" />
                  <path d="M9 12l2 2l4 -4" />
                </svg>
                <span>Network Allowlist Perimeter</span>
              </div>

              <div className="sandbox-popover-title">AI Model Endpoints</div>
              <ul className="sandbox-popover-domain-list">
                <li className="sandbox-popover-domain-tag">api.anthropic.com</li>
                <li className="sandbox-popover-domain-tag">api.openai.com</li>
                <li className="sandbox-popover-domain-tag">opencode.ai</li>
                <li className="sandbox-popover-domain-tag">openrouter.ai</li>
              </ul>

              <div className="sandbox-popover-title">Package Registries</div>
              <ul className="sandbox-popover-domain-list">
                <li className="sandbox-popover-domain-tag">registry.npmjs.org</li>
                <li className="sandbox-popover-domain-tag">pypi.org</li>
                <li className="sandbox-popover-domain-tag">crates.io</li>
                <li className="sandbox-popover-domain-tag">proxy.golang.org</li>
                <li className="sandbox-popover-domain-tag">rubygems.org</li>
              </ul>

              <div className="sandbox-popover-footer">
                <svg
                  className="k-icon k-icon-warning"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M12 9v2m0 4v.01" />
                  <path d="M5 19h14a2 2 0 0 0 1.84 -2.75l-7.1 -12.25a2 2 0 0 0 -3.5 0l-7.1 12.25a2 2 0 0 0 1.75 2.75" />
                </svg>
                <span>All other outbound and LAN traffic is blocked.</span>
              </div>
            </div>
          </span>
        ) : (
          <span
            className="sandbox-fact"
            title={`network: ${sandbox.network}`}
          >
            network: {sandbox.network}
          </span>
        )}

        {sandbox.note && (
          <>
            <span className="sandbox-sep" aria-hidden="true">
              ·
            </span>
            <span className="sandbox-fallback-note">
              {sandbox.note} — runs prompted on the host.
            </span>
          </>
        )}
      </div>

      {sandbox.actions && (
        <div className="sandbox-strip-actions">
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            data-act="sandbox-sync"
            aria-label="Sync sandbox commits into the worktree"
            title="Sync sandbox commits into the worktree"
            onClick={() => send?.sandboxSync?.()}
          >
            <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
              <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
            </svg>
            <span>Sync</span>
          </button>

          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            data-act="sandbox-diff"
            aria-label="Show what a sync would bring in"
            title="Show what a sync would bring in"
            onClick={() => send?.sandboxDiff?.()}
          >
            <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
              <path d="M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
              <path d="M11 6h5a2 2 0 0 1 2 2v8" />
              <path d="M14 9l-3 -3l3 -3" />
              <path d="M13 18h-5a2 2 0 0 1 -2 -2v-8" />
              <path d="M10 15l3 3l-3 3" />
            </svg>
            <span>Diff</span>
          </button>

          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            data-act="sandbox-stop"
            aria-label="Stop the sandbox (kept for the next open)"
            title="Stop the sandbox (kept for the next open)"
            onClick={() => send?.sandboxStop?.()}
          >
            <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10" />
            </svg>
            <span>Stop</span>
          </button>

          {sandbox.carry && (
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              data-act="sandbox-carry"
              aria-label="Carry sandbox commits onto host branch"
              title="Carry sandbox commits onto host branch"
              onClick={() => send?.sandboxCarry?.()}
            >
              <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M6 6v6a3 3 0 0 0 3 3h10l-4 -4m0 8l4 -4" />
              </svg>
              <span>Carry to host</span>
            </button>
          )}

          <button
            type="button"
            className="k-btn k-btn--danger k-btn--sm"
            data-act="sandbox-remove"
            aria-label="Remove the sandbox"
            title="Remove the sandbox"
            onClick={() => send?.sandboxRemove?.()}
          >
            <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 7l16 0" />
              <path d="M10 11l0 6" />
              <path d="M14 11l0 6" />
              <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" />
              <path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" />
            </svg>
            <span>Remove…</span>
          </button>
        </div>
      )}
    </div>
  );
}
