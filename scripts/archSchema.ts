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

/** The handle this script needs: prepare/all plus close. */
export interface SchemaHandle extends SchemaReader {
  close(): void;
}

/**
 * Is this the "the native addon is not built for this Node" failure?
 *
 * better-sqlite3 loads its addon on require, so an ABI that does not exist
 * (or a platform with no published prebuild and no toolchain to build one)
 * fails right there, before any query. That is a missing capability, not a
 * broken schema.
 */
export function isMissingAddon(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /bindings|Could not locate|NODE_MODULE_VERSION/i.test(message);
}

/**
 * The live schema, in memory.
 *
 * better-sqlite3 — the store's own driver — is the primary path: the real
 * migrations run against it. When its addon is not built for this Node (no
 * published prebuild for the platform, no C++ toolchain to build one), the
 * schema is applied through node:sqlite instead, the way the CLI's
 * `karst test reset` applies it: exec the same schema.sql and stamp the
 * version. A fresh schema.sql IS the complete current schema — every later
 * version's columns and tables are mirrored into it, and `migrate()` reads
 * that very file for a fresh DB (src/store/migrations.ts) — so the catalog
 * read back is the same one either way.
 */
export async function openSchemaDb(): Promise<SchemaHandle> {
  const { readSchema, SCHEMA_VERSION } = await import('../src/store/migrations.js');
  try {
    const { default: Database } = await import('better-sqlite3');
    const { migrate } = await import('../src/store/migrations.js');
    const db = new Database(':memory:');
    try {
      migrate(db);
      return db as unknown as SchemaHandle;
    } catch (err) {
      db.close();
      throw err;
    }
  } catch (err) {
    if (!isMissingAddon(err)) throw err;
    // The one `node:sqlite` ExperimentalWarning is dropped the way the CLI
    // drops it (src/cli/suppressWarning.ts) — narrow: every other warning
    // still reaches stderr.
    const { installSqliteWarningFilter } = await import('../src/cli/suppressWarning.js');
    installSqliteWarningFilter();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(readSchema());
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return db as unknown as SchemaHandle;
  }
}

/** Apply the real migrations to :memory: and read the resulting catalog. */
export async function buildCatalog(): Promise<TableCatalog[]> {
  const db = await openSchemaDb();
  try {
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
