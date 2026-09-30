"use strict";
(() => {
  // src/ui/dashboard/webview-messages.ts
  var vscode = acquireVsCodeApi();
  function postMessage(msg) {
    vscode.postMessage(msg);
  }
  function onMessage(handler) {
    window.addEventListener("message", (e) => {
      handler(e.data);
    });
  }
})();
