/** The done-marker text that ends every send-back brief and every typed hand-off. */
export const SEND_BACK_DONE_MARKER =
  'Fix the failure in the worktree, then call the karst MCP tool `stage` with { stage: "impl" } to mark the work done. ' +
  'After the marker, karst runs UAT and Review again and then pushes to the open pull request. Do not push.';
