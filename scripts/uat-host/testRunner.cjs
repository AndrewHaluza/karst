const assert = require('node:assert');
const { existsSync } = require('node:fs');
const vscode = require('vscode');

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('karst.karst');
  assert.ok(ext, 'karst.karst extension not found');
  await ext.activate();
  assert.strictEqual(ext.isActive, true, 'extension did not activate');

  // activate() returns normally even when the store open fails (it shows an
  // error modal and returns), so also require a registered karst command.
  const cmds = await vscode.commands.getCommands(true);
  assert.ok(cmds.some((c) => c.startsWith('karst.')), 'no karst.* command registered: activation aborted');

  const dbPath = process.env.UAT_DB_PATH;
  assert.ok(dbPath && existsSync(dbPath), `karst.db missing at ${dbPath}`);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM tickets').get();
    assert.strictEqual(n, Number(process.env.UAT_EXPECT_TICKETS), 'seeded ticket count mismatch');
  } finally {
    db.close();
  }
  console.log('uat-host: extension active, db opened, fixture visible');

  const script = process.env.UAT_PROBE_SCRIPT;
  if (!script) return;
  const out = process.env.UAT_PROBE_OUT;
  const results = await vscode.commands.executeCommand('karst.uatProbe.run', { scriptPath: script, outDir: out });
  for (const r of results) {
    console.log(`uat-probe: step ${r.index} (${r.type}) ${r.status.toUpperCase()}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`uat-probe: evidence ${out}`);
  const bad = results.find((r) => r.status !== 'pass');
  assert.ok(!bad, `probe step ${bad && bad.index} ${bad && bad.status}`);
};
