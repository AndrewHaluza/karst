/**
 * The one empty state of the Servers tab (RS-19, was PN-22): a titled, dashed
 * box with a hint that names the next step. It reads the same where the whole
 * tab is empty and where one of its two sections is.
 */
import { EMPTY_SERVERS_HINT, EMPTY_SERVERS_TITLE } from '../../../model/serverStatusText.js';

export function ServersEmpty() {
  return (
    <div className="k-empty">
      <div className="k-empty-title">{EMPTY_SERVERS_TITLE}</div>
      <div className="k-empty-hint">{EMPTY_SERVERS_HINT}</div>
    </div>
  );
}
