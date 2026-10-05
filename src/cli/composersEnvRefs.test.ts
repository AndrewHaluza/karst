import { describe, it, expect } from 'vitest';
import { karstCliRefs } from '../agent/cliEnv.js';
import { composeContextCommand } from './context.js';
import { composeStageCommand } from './stage.js';
import { composePhaseCommand } from './phaseCommand.js';
import { composeGuideCommand } from './guide.js';
import { composeServersPrefix } from './serversCommand.js';
import { composeTestCommand } from './test/main.js';
import { composeFixBriefCommand } from './fixBriefCommand.js';
import { composeConflictBriefCommand } from './conflictBriefCommand.js';

const r = karstCliRefs();

describe('composers with env-ref tokens (quoted exactly once)', () => {
  it('context', () => {
    expect(composeContextCommand(r.cli, r.db, r.manifest)).toBe(
      'node "$KARST_CLI" context --db "$KARST_DB" --manifest "$KARST_MANIFEST"',
    );
  });
  it('stage', () => {
    expect(composeStageCommand(r.cli, r.db, 'impl', r.manifest)).toBe(
      'node "$KARST_CLI" stage impl pass --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket',
    );
  });
  it('phase', () => {
    expect(composePhaseCommand(r.cli, r.db, 'plan', r.manifest)).toBe(
      'node "$KARST_CLI" phase plan --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket',
    );
  });
  it('guide', () => {
    expect(composeGuideCommand(r.cli)).toBe('node "$KARST_CLI" guide');
  });
  it('servers prefix', () => {
    expect(composeServersPrefix(r.cli, r.db, r.manifest, r.ticket)).toBe(
      'node "$KARST_CLI" --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket "$KARST_TICKET"',
    );
  });
  it('test', () => {
    expect(composeTestCommand(r.cli, r.db, r.manifest)).toBe(
      'node "$KARST_CLI" test --db "$KARST_DB" --manifest "$KARST_MANIFEST"',
    );
  });
  it('fix-brief', () => {
    expect(composeFixBriefCommand(r.cli, r.db, r.manifest)).toBe(
      'node "$KARST_CLI" fix-brief --db "$KARST_DB" --manifest "$KARST_MANIFEST"',
    );
  });
  it('conflict-brief', () => {
    expect(composeConflictBriefCommand(r.cli, r.db, r.manifest)).toBe(
      'node "$KARST_CLI" conflict-brief --db "$KARST_DB" --manifest "$KARST_MANIFEST"',
    );
  });
});

describe('composers with literal paths still quote', () => {
  it('servers prefix', () => {
    expect(composeServersPrefix('/a b/cli.js', '/d.db', '/m.yml', 'K-1')).toBe(
      'node "/a b/cli.js" --db "/d.db" --manifest "/m.yml" --ticket "K-1"',
    );
  });
  it('fix-brief and conflict-brief', () => {
    expect(composeFixBriefCommand('/c.js', '/d.db')).toBe('node "/c.js" fix-brief --db "/d.db"');
    expect(composeConflictBriefCommand('/c.js', '/d.db', '/m.yml')).toBe(
      'node "/c.js" conflict-brief --db "/d.db" --manifest "/m.yml"',
    );
  });
});
