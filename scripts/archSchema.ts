// Generate the live-schema ER in docs/arch/system-map.md.
// CLI: npm run -s docs:schema [-- --check]  (tsx scripts/archSchema.ts)
//
// The schema is not parsed from migration SQL text: migrations.ts is applied to
// an in-memory better-sqlite3 database, then sqlite_master and
// PRAGMA foreign_key_list are read back. tsx supplies the TypeScript loader,
// and the CI step rebuilds the addon for the Node ABI first (@arch:ABI-01).
import { readFileSync, writeFileSync } from 'node:fs';
import { replaceRegion, SYSTEM_MAP } from './archGraph.mjs';

export interface ForeignKey {
  /** The referenced (parent) table. */
  parent: string;
  /** The column on the child table. */
  column: string;
}

export interface TableCatalog {
  name: string;
  foreignKeys: ForeignKey[];
}

interface PreparedStatement {
  all(): unknown[];
}

/** The slice of a better-sqlite3 handle this script needs (easy to fake in tests). */
export interface SchemaReader {
  prepare(sql: string): PreparedStatement;
}

function entity(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function sortCatalog(tables: TableCatalog[]): TableCatalog[] {
  return [...tables]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      foreignKeys: [...t.foreignKeys].sort(
        (a, b) => a.parent.localeCompare(b.parent) || a.column.localeCompare(b.column),
      ),
    }));
}

/**
 * Mermaid erDiagram from a catalog: every table is declared, then one
 * `parent ||--o{ child` edge per declared foreign key. Sorted so the generated
 * region is stable.
 */
export function erFromCatalog(tables: TableCatalog[]): string {
  const sorted = sortCatalog(tables);
  const lines = ['erDiagram'];
  for (const table of sorted) lines.push(`  ${entity(table.name)}`);
  for (const table of sorted) {
    for (const fk of table.foreignKeys) {
      lines.push(`  ${entity(fk.parent)} ||--o{ ${entity(table.name)} : ${entity(fk.column)}`);
    }
  }
  return lines.join('\n');
}

/** Read every user table and its declared foreign keys from a live handle. */
export function catalogFromDb(db: SchemaReader): TableCatalog[] {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
  return names.map((name) => {
    const escaped = name.replace(/'/g, "''");
    const rows = db.prepare(`PRAGMA foreign_key_list('${escaped}')`).all() as Array<{
      table?: string;
      from?: string;
    }>;
    return {
      name,
      foreignKeys: rows
        .filter((row) => row.table && row.from)
        .map((row) => ({ parent: row.table as string, column: row.from as string })),
    };
  });
}

/** Apply the real migrations to :memory: and read the resulting catalog. */
export async function buildCatalog(): Promise<TableCatalog[]> {
  const { default: Database } = await import('better-sqlite3');
  const { migrate } = await import('../src/store/migrations.js');
  const db = new Database(':memory:');
  try {
    migrate(db);
    return catalogFromDb(db);
  } finally {
    db.close();
  }
}

async function main(args: string[]): Promise<void> {
  const body = ['```mermaid', erFromCatalog(await buildCatalog()), '```'].join('\n');
  const current = readFileSync(SYSTEM_MAP, 'utf8');
  const next = replaceRegion(current, 'MAP-04', body);
  if (args.includes('--check')) {
    if (next !== current) {
      console.error('docs/arch/system-map.md is stale: run npm run -s docs:schema');
      process.exitCode = 1;
    }
  } else {
    writeFileSync(SYSTEM_MAP, next);
  }
}

if (process.argv[1]?.endsWith('archSchema.ts')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
