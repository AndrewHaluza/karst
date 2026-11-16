const vscode = require('vscode');
const { assertKarstActive } = require('./hostChecks.cjs');
const { listenHostChannel } = require('./hostChannel.cjs');

// Serve mode (arch:UATHOST-08): the extension-tests runner never returns, so the host stays up for the supervisor.
exports.run = async function run() {
  await assertKarstActive(vscode);
  const socketPath = process.env.UAT_SERVE_SOCKET;
  if (!socketPath) throw new Error('UAT_SERVE_SOCKET is not set: testRunnerServe.cjs runs only under serveServer.mjs');
  await listenHostChannel(socketPath, {
    runProbe: (args) => vscode.commands.executeCommand('karst.uatProbe.run', args),
  });
  console.log(`uat-serve: host channel listening on ${socketPath}`);
  await new Promise(() => {}); // serve mode: the host stays up until the supervisor kills its process group
};
