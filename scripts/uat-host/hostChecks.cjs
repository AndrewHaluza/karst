const assert = require('node:assert');
const { existsSync } = require('node:fs');

/** Activation, command registration and the seeded ticket count. Shared by testRunner.cjs and testRunnerServe.cjs. */
exports.assertKarstActive = async function assertKarstActive(vscode) {
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
};
