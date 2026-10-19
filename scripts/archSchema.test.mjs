import { describe, expect, it } from 'vitest';
import { catalogFromDb, erFromCatalog } from './archSchema.ts';

// A tiny fixture "migration list": the tables and foreign keys a schema would
// leave behind, without needing the native addon in this unit test.
const FIXTURE_MIGRATIONS = {
  tickets: [],
  stage_runs: [{ table: 'tickets', from: 'ticket_id' }],
  review_findings: [
    { table: 'stage_runs', from: 'stage_run_id' },
    { table: 'tickets', from: 'ticket_id' },
  ],
};

function fixtureDb() {
  return {
    prepare(sql) {
      if (sql.includes('sqlite_master')) {
        return { all: () => Object.keys(FIXTURE_MIGRATIONS).sort().map((name) => ({ name })) };
      }
      const table = /PRAGMA foreign_key_list\('(.+)'\)/.exec(sql)[1];
      return { all: () => FIXTURE_MIGRATIONS[table] };
    },
  };
}

describe('catalogFromDb', () => {
  it('reads tables and foreign keys from the fixture migration list', () => {
    expect(catalogFromDb(fixtureDb())).toEqual([
      { name: 'review_findings', foreignKeys: [{ parent: 'stage_runs', column: 'stage_run_id' }, { parent: 'tickets', column: 'ticket_id' }] },
      { name: 'stage_runs', foreignKeys: [{ parent: 'tickets', column: 'ticket_id' }] },
      { name: 'tickets', foreignKeys: [] },
    ]);
  });
});

describe('erFromCatalog', () => {
  it('declares every table and emits sorted FK edges only', () => {
    expect(erFromCatalog(catalogFromDb(fixtureDb()))).toBe(
      [
        'erDiagram',
        '  review_findings',
        '  stage_runs',
        '  tickets',
        '  stage_runs ||--o{ review_findings : stage_run_id',
        '  tickets ||--o{ review_findings : ticket_id',
        '  tickets ||--o{ stage_runs : ticket_id',
      ].join('\n'),
    );
  });

  it('is stable when the catalog arrives in another order', () => {
    const a = erFromCatalog([{ name: 'b', foreignKeys: [] }, { name: 'a', foreignKeys: [] }]);
    const b = erFromCatalog([{ name: 'a', foreignKeys: [] }, { name: 'b', foreignKeys: [] }]);
    expect(a).toBe(b);
  });
});
