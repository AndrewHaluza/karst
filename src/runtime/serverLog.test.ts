import { describe, it, expect } from 'vitest';
import {
  serverLogDir,
  serverLogPath,
  RUN_MARKER_PREFIX,
  runMarkerLine,
  isRunMarker,
} from './serverLog.js';

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

describe('run markers', () => {
  it('renders a line starting with the marker prefix', () => {
    const line = runMarkerLine('web', '2026-01-01T00:00:00.000Z');

    expect(line.startsWith(RUN_MARKER_PREFIX)).toBe(true);
    expect(line).toBe('=== karst run service=web started=2026-01-01T00:00:00.000Z ===');
  });

  it('recognizes a marker it rendered', () => {
    expect(isRunMarker(runMarkerLine('web', '2026-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('does not mistake server output for a marker', () => {
    expect(isRunMarker('starting server')).toBe(false);
    expect(isRunMarker(`${RUN_MARKER_PREFIX}but never closed`)).toBe(false);
  });

  it('treats a marker with trailing whitespace or newline as a marker', () => {
    expect(isRunMarker(`${runMarkerLine('web', '2026-01-01T00:00:00.000Z')}\n`)).toBe(true);
  });
});
