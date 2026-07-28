import { describe, it, expect, vi } from 'vitest';
import { routeAction, parseWebviewMessage, type DashboardActions } from './messages.js';

function actions(): DashboardActions {
  return {
    stopServer: vi.fn(),
    restartServer: vi.fn(),
    openServer: vi.fn(),
    copyServerUrl: vi.fn(),
    spinServers: vi.fn(),
    restartServers: vi.fn(),
    stopServers: vi.fn(),
    diffWorktree: vi.fn(),
    openWorktreeFolder: vi.fn(),
    openPr: vi.fn(),
    openTicketLink: vi.fn(),
    editTicket: vi.fn(),
    stopDriver: vi.fn(),
    shipTicket: vi.fn(),
    resumeTicket: vi.fn(),
    createFollowUpTicket: vi.fn(),
    openStageLog: vi.fn(),
  };
}

describe('routeAction', () => {
  it('dispatches stop-server to the supervisor action with the server id', () => {
    const a = actions();
    routeAction({ type: 'stop-server', serverId: 7 }, a);
    expect(a.stopServer).toHaveBeenCalledWith(7);
  });

  it('dispatches restart-server / open-server', () => {
    const a = actions();
    routeAction({ type: 'restart-server', serverId: 3 }, a);
    routeAction({ type: 'open-server', serverId: 3 }, a);
    expect(a.restartServer).toHaveBeenCalledWith(3);
    expect(a.openServer).toHaveBeenCalledWith(3);
  });

  it('dispatches worktree diff / open-folder by path', () => {
    const a = actions();
    routeAction({ type: 'diff-worktree', path: '/wt/a' }, a);
    routeAction({ type: 'open-worktree-folder', path: '/wt/a' }, a);
    expect(a.diffWorktree).toHaveBeenCalledWith('/wt/a');
    expect(a.openWorktreeFolder).toHaveBeenCalledWith('/wt/a');
  });

  it('dispatches open-pr by url', () => {
    const a = actions();
    routeAction({ type: 'open-pr', url: 'http://pr/1' }, a);
    expect(a.openPr).toHaveBeenCalledWith('http://pr/1');
  });

  it('dispatches copy-server-url by server id', () => {
    const a = actions();
    routeAction({ type: 'copy-server-url', serverId: 9 }, a);
    expect(a.copyServerUrl).toHaveBeenCalledWith(9);
  });

  it('dispatches spin-servers (no payload)', () => {
    const a = actions();
    routeAction({ type: 'spin-servers' }, a);
    expect(a.spinServers).toHaveBeenCalledTimes(1);
  });

  it('parses the panel-level server actions (no payload)', () => {
    expect(parseWebviewMessage({ type: 'restart-servers' })).toEqual({ type: 'restart-servers' });
    expect(parseWebviewMessage({ type: 'stop-servers' })).toEqual({ type: 'stop-servers' });
  });

  it('dispatches restart-servers / stop-servers, which act on the whole ticket', () => {
    const a = actions();
    routeAction({ type: 'restart-servers' }, a);
    routeAction({ type: 'stop-servers' }, a);
    expect(a.restartServers).toHaveBeenCalledTimes(1);
    expect(a.stopServers).toHaveBeenCalledTimes(1);
    // They are NOT the per-row actions — a panel control that silently fell
    // through to the single-server handler would stop one server and look like
    // it had stopped them all.
    expect(a.stopServer).not.toHaveBeenCalled();
    expect(a.restartServer).not.toHaveBeenCalled();
  });

  it('ignores a stray serverId on a panel-level server action', () => {
    // The webview never sends one (the header buttons carry no data-id), so a
    // message that does is malformed — it must not be reshaped into a per-row
    // action by the parser.
    expect(parseWebviewMessage({ type: 'stop-servers', serverId: 4 })).toEqual({
      type: 'stop-servers',
    });
  });

  it('dispatches open-ticket-link only for http(s) urls', () => {
    const a = actions();
    routeAction({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/x' }, a);
    routeAction({ type: 'open-ticket-link', url: 'file:///etc/passwd' }, a);
    expect(a.openTicketLink).toHaveBeenCalledTimes(1);
    expect(a.openTicketLink).toHaveBeenCalledWith('https://app.clickup.com/t/x');
  });

  it('rejects copy-server-url whose serverId is not a number', () => {
    const a = actions();
    routeAction({ type: 'copy-server-url', serverId: '9' }, a);
    expect(a.copyServerUrl).not.toHaveBeenCalled();
  });

  it('ignores an unknown message shape without throwing', () => {
    const a = actions();
    expect(() => routeAction({ type: 'nonsense' } as never, a)).not.toThrow();
  });

  it('rejects a server action whose serverId is not a number', () => {
    const a = actions();
    routeAction({ type: 'stop-server', serverId: '7' }, a);
    routeAction({ type: 'stop-server' }, a);
    expect(a.stopServer).not.toHaveBeenCalled();
  });

  it('rejects a worktree action whose path is missing or non-string', () => {
    const a = actions();
    routeAction({ type: 'diff-worktree', path: 123 }, a);
    routeAction({ type: 'diff-worktree' }, a);
    routeAction({ type: 'diff-worktree', path: '' }, a);
    expect(a.diffWorktree).not.toHaveBeenCalled();
  });

  it('rejects an open-pr url that is not http(s) — no file:// or other scheme', () => {
    const a = actions();
    routeAction({ type: 'open-pr', url: 'file:///etc/passwd' }, a);
    routeAction({ type: 'open-pr', url: 'javascript:alert(1)' }, a);
    routeAction({ type: 'open-pr', url: 42 }, a);
    expect(a.openPr).not.toHaveBeenCalled();
    routeAction({ type: 'open-pr', url: 'https://github.com/o/r/pull/1' }, a);
    expect(a.openPr).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
  });

  it('ignores a non-object message (null / string / array)', () => {
    const a = actions();
    expect(() => routeAction(null, a)).not.toThrow();
    expect(() => routeAction('stop-server', a)).not.toThrow();
    expect(() => routeAction([], a)).not.toThrow();
    expect(a.stopServer).not.toHaveBeenCalled();
  });

  it('dispatches edit-ticket to the editTicket action', () => {
    const a = actions();
    routeAction({ type: 'edit-ticket' }, a);
    expect(a.editTicket).toHaveBeenCalled();
  });

  it('parses the driver/ship/resume actions', () => {
    expect(parseWebviewMessage({ type: 'stop-driver' })).toEqual({ type: 'stop-driver' });
    expect(parseWebviewMessage({ type: 'ship-ticket' })).toEqual({ type: 'ship-ticket' });
    expect(parseWebviewMessage({ type: 'resume-ticket' })).toEqual({ type: 'resume-ticket' });
  });

  it('dispatches stop-driver/ship-ticket/resume-ticket (no payload)', () => {
    const a = actions();
    routeAction({ type: 'stop-driver' }, a);
    routeAction({ type: 'ship-ticket' }, a);
    routeAction({ type: 'resume-ticket' }, a);
    expect(a.stopDriver).toHaveBeenCalledTimes(1);
    expect(a.shipTicket).toHaveBeenCalledTimes(1);
    expect(a.resumeTicket).toHaveBeenCalledTimes(1);
  });

  it('parses and dispatches create-follow-up-ticket', () => {
    expect(parseWebviewMessage({ type: 'create-follow-up-ticket' })).toEqual({
      type: 'create-follow-up-ticket',
    });
    const a = actions();
    routeAction({ type: 'create-follow-up-ticket' }, a);
    expect(a.createFollowUpTicket).toHaveBeenCalledTimes(1);
  });

  it('dispatches open-stage-log with the log path', () => {
    const a = actions();
    routeAction({ type: 'open-stage-log', path: '/logs/review-ticket-1.log' }, a);
    expect(a.openStageLog).toHaveBeenCalledWith('/logs/review-ticket-1.log');
  });

  it('ignores an open-stage-log with a missing or non-string path', () => {
    const a = actions();
    routeAction({ type: 'open-stage-log' }, a);
    routeAction({ type: 'open-stage-log', path: 42 }, a);
    routeAction({ type: 'open-stage-log', path: '' }, a);
    expect(a.openStageLog).not.toHaveBeenCalled();
  });
});
