const assert = require('node:assert');
const vscode = require('vscode');
const { assertKarstActive } = require('./hostChecks.cjs');

exports.run = async function run() {
  await assertKarstActive(vscode);

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
