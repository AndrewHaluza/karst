import { describe, it, expect } from 'vitest';
import { serverLogDir, serverLogPath } from './serverLog.js';

describe('serverLogPath', () => {
  // The bug this exists for: `<cwd>/<name>.log` put a supervised process's
  // stdout at the top of the working tree, where `git status` shows it as an
  // untracked change and someone commits it. It happened — `Karst-extention.log`
  // reached main carrying one line of a service's output.
  it('never puts a log at the root of the working tree', () => {
    const path = serverLogPath('/wt/api', 'api');

    expect(path).not.toBe('/wt/api/api.log');
    expect(path.startsWith('/wt/api/')).toBe(true);
  });

  // `.karst/` is already excluded in every repo karst creates a worktree in
  // (`ensureKarstExcluded` writes `/.karst/` to .git/info/exclude), so putting
  // the log there makes it unstageable rather than relying on anyone noticing.
  it('writes under the .karst directory git is already told to ignore', () => {
    expect(serverLogDir('/wt/api')).toBe('/wt/api/.karst/logs');
    expect(serverLogPath('/wt/api', 'api')).toBe('/wt/api/.karst/logs/api.log');
  });

  it('keeps one file per service name', () => {
    expect(serverLogPath('/wt/api', 'web')).not.toBe(serverLogPath('/wt/api', 'api'));
    expect(serverLogPath('/wt/api', 'api.baseline')).toBe('/wt/api/.karst/logs/api.baseline.log');
  });
});
