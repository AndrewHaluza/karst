/** What karst does after the impl marker. The push comes later, at the ship step, so the agent never pushes. */
export const SEND_BACK_AFTER_MARKER =
  'After the marker, karst runs UAT and Review again. Karst pushes later, at the ship step, to the pull request if one is open. Do not push.';

/** The done-marker text that ends every send-back brief and every typed hand-off. */
export const SEND_BACK_DONE_MARKER =
  `Fix the failure in the worktree, then call the karst MCP tool \`stage\` with { stage: "impl" } to mark the work done. ${SEND_BACK_AFTER_MARKER}`;
