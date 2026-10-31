import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isKnownProvider } from '../agent/provider.js';
import { openStore } from '../store/db.js';
import { parseFixtureFile } from './fixtureFile.js';
import { fixtureSpec, isFixtureName, type FixtureSpec } from './fixtures.js';
import { seedStore } from './seed.js';
import { buildWorkspace } from './workspace.js';

function flag(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) { console.error(`uat-host prepare: missing --${name}`); process.exit(2); }
  return v;
}

function optionalFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadSpec(): FixtureSpec {
  const file = optionalFlag('fixture-file');
  if (file) {
    try {
      return parseFixtureFile(JSON.parse(readFileSync(file, 'utf8')) as unknown, file);
    } catch (err) {
      console.error(`uat-host prepare: bad fixture file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  const fixture = flag('fixture');
  if (!isFixtureName(fixture)) {
    console.error(`uat-host prepare: unknown fixture "${fixture}"`);
    process.exit(2);
  }
  return fixtureSpec(fixture);
}

const spec = loadSpec();
// An explicit --provider overrides the fixture file's own provider.
const provider = optionalFlag('provider') ?? spec.provider ?? 'claude';
if (!isKnownProvider(provider)) {
  console.error(`uat-host prepare: unknown provider "${provider}"`);
  process.exit(2);
}
const dbPath = flag('db');
const ws = buildWorkspace(flag('root'), provider, spec.taskRepo);
mkdirSync(dirname(dbPath), { recursive: true });
const store = openStore(dbPath);
const ids = seedStore(store, spec);
store.db.close();
console.log(JSON.stringify({ workspaceDir: ws.workspaceDir, tickets: ids.length }));
