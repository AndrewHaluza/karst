// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SandboxStrip } from './SandboxStrip.js';
import type { DashboardSandboxView } from '../sandboxView.js';

afterEach(() => {
  cleanup();
});

const SBX_VIEW: DashboardSandboxView = {
  backend: 'sbx',
  core: 'claude',
  workspace: 'clone',
  network: 'sbx network policy (allowlist)',
  actions: true,
  carry: false,
};

describe('SandboxStrip', () => {
  it('renders nothing when sandbox view is null', () => {
    const { container } = render(<SandboxStrip sandbox={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders cube mark, Sandbox label, backend tag, canonical core name, and facts', () => {
    render(<SandboxStrip sandbox={SBX_VIEW} />);

    // Cube mark and Sandbox title
    const strip = screen.getByTestId('sandbox-strip');
    expect(strip).toBeTruthy();
    expect(strip.getAttribute('data-region')).toBe('sandbox');
    expect(strip.textContent).toContain('Sandbox');

    // Backend tag
    expect(screen.getByTestId('sandbox-backend-tag').textContent).toBe('sbx');

    // Canonical core name (UI-R10c: never bare 'claude', must be canonical 'Claude Code')
    expect(screen.getByTestId('sandbox-core-identity').textContent).toContain('Claude Code');

    // Semantic badges (Variant 2)
    const wsBadge = screen.getByTestId('sandbox-workspace-badge');
    expect(wsBadge.textContent).toContain('Isolated Git Clone');
    expect(wsBadge.textContent).toContain('Filesystem Containment');
    expect(wsBadge.textContent).toContain('Isolation Boundary');
    expect(wsBadge.textContent).toContain('Host Synchronization');

    const netBadge = screen.getByTestId('sandbox-network-badge');
    expect(netBadge.textContent).toContain('Allowlist Proxy');
    expect(netBadge.textContent).toContain('Network Allowlist Perimeter');
    expect(netBadge.textContent).toContain('api.anthropic.com');
    expect(netBadge.textContent).toContain('registry.npmjs.org');
  });

  it('renders labelled action buttons when actions are enabled', () => {
    const send = {
      sandboxSync: vi.fn(),
      sandboxDiff: vi.fn(),
      sandboxStop: vi.fn(),
      sandboxRemove: vi.fn(),
      sandboxCarry: vi.fn(),
      sandboxStashUpdate: vi.fn(),
    };

    render(<SandboxStrip sandbox={SBX_VIEW} send={send} />);

    const syncBtn = screen.getByRole('button', { name: 'Sync sandbox commits into the worktree' });
    expect(syncBtn.textContent).toContain('Sync');
    fireEvent.click(syncBtn);
    expect(send.sandboxSync).toHaveBeenCalledTimes(1);

    const diffBtn = screen.getByRole('button', { name: 'Show what a sync would bring in' });
    expect(diffBtn.textContent).toContain('Diff');
    fireEvent.click(diffBtn);
    expect(send.sandboxDiff).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Stash uncommitted sandbox changes and update from the host' }));
    expect(send.sandboxStashUpdate).toHaveBeenCalledTimes(1);

    const stopBtn = screen.getByRole('button', { name: 'Stop the sandbox (kept for the next open)' });
    expect(stopBtn.textContent).toContain('Stop');
    fireEvent.click(stopBtn);
    expect(send.sandboxStop).toHaveBeenCalledTimes(1);

    const removeBtn = screen.getByRole('button', { name: 'Remove the sandbox' });
    expect(removeBtn.textContent).toMatch(/Remove/);
    expect(removeBtn.classList.contains('k-btn--danger')).toBe(true);
    fireEvent.click(removeBtn);
    expect(send.sandboxRemove).toHaveBeenCalledTimes(1);

    // Carry button should NOT be present when carry is false
    expect(screen.queryByRole('button', { name: 'Carry sandbox commits onto host branch' })).toBeNull();
  });

  it('offers "Carry to host" only when carry is true', () => {
    const send = { sandboxCarry: vi.fn() };
    render(<SandboxStrip sandbox={{ ...SBX_VIEW, carry: true }} send={send} />);

    const carryBtn = screen.getByRole('button', { name: 'Carry sandbox commits onto host branch' });
    expect(carryBtn.textContent).toContain('Carry to host');
    fireEvent.click(carryBtn);
    expect(send.sandboxCarry).toHaveBeenCalledTimes(1);
  });

  it('shows fallback note verbatim and no actions when actions are off', () => {
    const hostFallback: DashboardSandboxView = {
      backend: 'host',
      core: 'antigravity',
      workspace: 'worktree',
      network: 'none (host)',
      actions: false,
      carry: false,
      note: 'antigravity: sbx backend unsupported',
    };

    render(<SandboxStrip sandbox={hostFallback} />);

    const strip = screen.getByTestId('sandbox-strip');
    expect(strip.textContent).toContain('antigravity: sbx backend unsupported — runs prompted on the host.');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps actions while displaying the note for an opted-out ticket', () => {
    const optOutView: DashboardSandboxView = {
      backend: 'host',
      core: 'claude',
      workspace: 'worktree',
      network: 'none (host)',
      actions: true,
      carry: false,
      note: 'ticket opted out of the sandbox backend',
    };

    render(<SandboxStrip sandbox={optOutView} />);

    const strip = screen.getByTestId('sandbox-strip');
    expect(strip.textContent).toContain('ticket opted out of the sandbox backend — runs prompted on the host.');
    // Actions are still rendered
    expect(screen.getByRole('button', { name: 'Sync sandbox commits into the worktree' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove the sandbox' })).toBeTruthy();
  });
});
