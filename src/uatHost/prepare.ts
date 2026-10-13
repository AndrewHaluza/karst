import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openStore } from '../store/db.js';
import { fixtureSpec, isFixtureName } from './fixtures.js';
import { seedStore } from './seed.js';
import { buildWorkspace } from './workspace.js';

function flag(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) { console.error(`uat-host prepare: missing --${name}`); process.exit(2); }
  return v;
}

const fixture = flag('fixture');
if (!isFixtureName(fixture)) {
  console.error(`uat-host prepare: unknown fixture "${fixture}"`);
  process.exit(2);
}
const dbPath = flag('db');
const ws = buildWorkspace(flag('root'));
mkdirSync(dirname(dbPath), { recursive: true });
const store = openStore(dbPath);
const ids = seedStore(store, fixtureSpec(fixture));
store.db.close();
console.log(JSON.stringify({ workspaceDir: ws.workspaceDir, tickets: ids.length }));
