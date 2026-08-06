/**
 * Agent-core brand identity — single source of truth for how an `AgentProvider`
 * renders across webviews: an inline icon mark plus a title-cased label.
 *
 * Mirrors [[providerIdentity]] (which handles ticketing providers like ClickUp)
 * but for the coding-agent cores (Claude, Codex, Antigravity, OpenCode).
 *
 * Injected as text into each self-contained `webview.html` at load (CSP forbids
 * a shared script/stylesheet) rather than imported at webview runtime.
 */

import type { AgentProvider } from '../manifest/types.js';

/** Agent provider id → display label. */
export const AGENT_PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
};

/**
 * Inline SVG icons for each agent core, rendered at 14×14 to match
 * `.provicon` sizing. All use `fill="white"` for visibility on the
 * extension's dark UI backgrounds.
 *
 * Claude: the star/sparkle mark (vector path, scales cleanly).
 * Codex: the geometric circle-and-nodes mark (vector paths + clip).
 * Antigravity: raster mark embedded as PNG data URI.
 * OpenCode: raster mark embedded as PNG data URI.
 */

const CLAUDE_SVG =
  '<svg viewBox="0 0 248 248" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237' +
  ' 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094' +
  ' 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728' +
  ' 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995' +
  ' 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113' +
  ' 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374' +
  ' 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978' +
  ' 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193' +
  ' 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873' +
  ' 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915' +
  ' 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998' +
  ' 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698' +
  ' L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972' +
  ' 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755' +
  ' 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495' +
  ' 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855' +
  ' 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737' +
  ' L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089' +
  ' L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069' +
  ' L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832' +
  ' L181.308 223.959L174.813 222.305L153.071 203.692L144.548 196.367L134.602 212.083L136.131 221.654' +
  ' L138.02 223.721L147.591 224.55L153.577 224.167L198.525 224.699L223.665 226.077L236.589 230.153' +
  ' L241.036 235.824L239.147 242.086L232.172 241.597L225.677 239.352L170.738 237.816L131.157 237.162' +
  ' L110.236 237.162L80.5328 237.816L31.1286 239.352L24.6336 241.597L17.6586 242.086L15.7699 235.824' +
  ' L20.2167 230.153L33.1407 226.077L58.2805 224.699L103.229 224.167L109.215 224.55L118.786 223.721' +
  ' L120.675 221.654L122.204 212.083L112.258 196.367L103.735 203.692L81.9929 222.305L75.4982 223.959' +
  ' L69.512 221.832L67.8564 218.405L69.0026 207.771L92.0538 173.152L96.5839 166.772V165.118H95.3094' +
  ' L76.4617 181.069L68.0567 188.394L46.4069 204.699L43.0956 205.172L39.9118 200.682L41.1859 195.011' +
  ' L65.7642 172.089L85.504 154.366L96.201 143.85V142.787H94.4191L81.5656 145.977L43.9999 154.956' +
  ' L27.9542 158.737L15.9542 152.711L15.19 147.867L19.7764 141.605L27.544 136.524H57.4716L73.3911' +
  ' 134.279H79.8862L95.1089 132.547L95.5496 131.893L95.176 131.592L61.4203 123.645L38.7512 119.037' +
  ' L19.3945 114.311L16.2107 106.395L17.1021 102.496L25.2521 98.7149L43.3361 101.787L58.4913 104.504' +
  ' L86.5086 110.53L88.3643 110.689L89.0553 109.585L81.3503 96.2095L68.9343 79.5739L60.4943 68.3492' +
  ' L50.0513 55.1159L46.74 43.6549L54.126 32.5484H64.274L69.623 36.802L78.028 45.6635L85.16 53.698' +
  ' L101.333 74.0206L110.937 86.7813L113.432 89.2625H115.469L111.904 70.1215L106.428 41.6463L103.626' +
  ' 23.4505L102.989 19.0788L107.701 12.344L113.432 9.62643L120.818 14.4708L124.511 23.4505L125.276' +
  ' 30.8942L127.568 57.3608L129.86 77.9197L131.134 94.6976V96.1155H132.662L133.553 93.6343L135.973' +
  ' 85.4816L140.43 76.62L155.712 46.8451L165.518 24.9865L171.631 11.0443L175.706 7.49965L185.512' +
  ' 6.19995L189.587 7.49965L196.846 17.4246C196.846 20.0111 196.469 22.1032 195.827 24.632L194.172' +
  ' 30.6579L187.804 40.8192L173.668 65.2772L160.424 89.2625L158.768 91.9801L158.988 92.6652L160.424' +
  ' 93.6343L163.99 90.6804L188.441 72.7209L207.162 58.1879L215.949 51.4531L218.114 50.8623L226.774' +
  ' 50.2716L233.141 57.3608L231.613 67.2858L228.047 71.7757L221.043 76.62L207.926 86.1905L182.837' +
  ' 102.732L159.66 118.447L158.641 119.392L157.367 120.337L157.876 121.873H161.697L185.766 121.873' +
  ' L201.94 119.392L224.354 118.447L239.254 116.911L245.24 115.847L246.768 115.257L247.278 118.447' +
  ' L241.784 121.873H241.275L241.784 128.844L236.181 130.026L213.897 131.207L190.974 132.153L164.485' +
  ' 132.862L156.718 133.334H155.699L154.935 134.602L155.699 136.879L202.055 162.873L208.041 166.299' +
  ' L207.277 168.366L201.045 167.537L194.55 163.925L153.333 140.886L152.059 139.941L150.785 140.886' +
  ' L109.568 163.925L103.073 167.537L96.8411 168.366L96.0769 166.299Z" fill="white"/></svg>';

const CODEX_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="14" height="14" fill="none">' +
  '<defs>' +
  '<clipPath id="acA"><path d="M0 0h180v180H0z"/></clipPath>' +
  '<clipPath id="acB"><path d="M29.487 29.964h121.035v119.954H29.487z"/></clipPath>' +
  '</defs>' +
  '<g clip-path="url(#acA)">' +
  '<rect width="180" height="180" rx="90"/>' +
  '<g clip-path="url(#acB)">' +
  '<path fill="currentColor" d="M75.91 73.628V62.232c0-.96.36-1.68 1.199-2.16l22.912-13.194c3.119-1.8 6.838-2.639' +
  ' 10.676-2.639 14.394 0 23.511 11.157 23.511 23.032 0 .839 0 1.799-.12 2.758l-23.752-13.914c-1.439-.84' +
  ' -2.879-.84-4.318 0L75.91 73.627Zm53.499 44.383v-27.23c0-1.68-.72-2.88-2.159-3.719L97.142 69.55l9.836' +
  ' -5.638c.839-.48 1.559-.48 2.399 0l22.912 13.195c6.598 3.839 11.035 11.995 11.035 19.912 0 9.116-5.397' +
  ' 17.513-13.915 20.992v.001Zm-60.577-23.99-9.836-5.758c-.84-.48-1.2-1.2-1.2-2.16v-26.39c0-12.834 9.837' +
  ' -22.55 23.152-22.55 5.039 0 9.716 1.679 13.676 4.678L70.993 55.516c-1.44.84-2.16 2.039-2.16 3.719v34.787' +
  ' -.002Zm21.173 12.234L75.91 98.339V81.546l14.095-7.917 14.094 7.917v16.793l-14.094 7.916Zm9.056 36.467' +
  ' c-5.038 0-9.716-1.68-13.675-4.678l23.631-13.676c1.439-.839 2.159-2.038 2.159-3.718V85.863l9.956 5.757' +
  ' c.84.48 1.2 1.2 1.2 2.16v26.389c0 12.835-9.957 22.552-23.27 22.552v.001Zm-28.43-26.75L47.72 102.778' +
  ' c-6.599-3.84-11.036-11.996-11.036-19.913 0-9.236 5.518-17.513 14.034-20.992v27.35c0 1.68.72 2.879 2.16' +
  ' 3.718l29.989 17.393-9.837 5.638c-.84.48-1.56.48-2.399 0Zm-1.318 19.673c-13.555 0-23.512-10.196-23.512' +
  ' -22.792 0-.959.12-1.919.24-2.879l23.63 13.675c1.44.84 2.88.84 4.32 0l30.108-17.392v11.395c0 .96-.361' +
  ' 1.68-1.2 2.16l-22.912 13.194c-3.119 1.8-6.837 2.639-10.675 2.639Zm29.748 14.274c14.515 0 26.63-10.316' +
  ' 29.39-23.991 13.434-3.479 22.071-16.074 22.071-28.91 0-8.396-3.598-16.553-10.076-22.43.6-2.52.96-5.039' +
  ' .96-7.557 0-17.153-13.915-29.99-29.989-29.99-3.239 0-6.358.48-9.477 1.56-5.398-5.278-12.835-8.637-20.992' +
  ' -8.637-14.515 0-26.63 10.316-29.39 23.991-13.434 3.48-22.07 16.074-22.07 28.91 0 8.396 3.598 16.553 10.075' +
  ' 22.431-.6 2.519-.96 5.038-.96 7.556 0 17.154 13.915 29.989 29.99 29.989 3.238 0 6.357-.479 9.476-1.559' +
  ' 5.397 5.278 12.835 8.637 20.992 8.637Z"/>' +
  '</g></g></svg>';

const ANTIGRAVITY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="14" height="14">' +
  '<path d="M21,6h6v1h-6z M20,7h8v1h-8z M19,8h10v1h-10z M18,9h12v1h-12z M17,10h14v1h-14z' +
  ' M17,11h14v1h-14z M16,12h16v1h-16z M16,13h16v1h-16z M15,14h18v1h-18z M15,15h18v1h-18z' +
  ' M15,16h18v1h-18z M15,17h18v1h-18z M14,18h20v1h-20z M14,19h20v1h-20z M14,20h20v1h-20z' +
  ' M13,21h22v1h-22z M13,22h22v1h-22z M13,23h22v1h-22z M12,24h24v1h-24z M12,25h11v1h-11z' +
  ' M25,25h11v1h-11z M12,26h8v1h-8z M28,26h8v1h-8z M12,27h7v1h-7z M29,27h7v1h-7z' +
  ' M11,28h7v1h-7z M30,28h7v1h-7z M11,29h6v1h-6z M31,29h6v1h-6z M10,30h7v1h-7z' +
  ' M31,30h6v1h-6z M10,31h6v1h-6z M32,31h6v1h-6z M10,32h5v1h-5z M32,32h6v1h-6z' +
  ' M9,33h6v1h-6z M33,33h6v1h-6z M9,34h5v1h-5z M34,34h5v1h-5z M8,35h6v1h-6z' +
  ' M34,35h6v1h-6z M8,36h5v1h-5z M35,36h5v1h-5z M7,37h5v1h-5z M36,37h5v1h-5z' +
  ' M6,38h5v1h-5z M37,38h5v1h-5z M5,39h5v1h-5z M38,39h5v1h-5z M5,40h4v1h-4z' +
  ' M39,40h4v1h-4z M5,41h3v1h-3z M40,41h3v1h-3z" fill="currentColor"/></svg>';

const OPENCODE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="14" height="14">' +
  '<path d="M12,9h24v1h-24z M12,10h24v1h-24z M12,11h24v1h-24z M12,12h24v1h-24z' +
  ' M12,13h24v1h-24z M12,14h24v1h-24z M12,15h6v1h-6z M30,15h6v1h-6z' +
  ' M12,16h6v1h-6z M30,16h6v1h-6z M12,17h6v1h-6z M30,17h6v1h-6z' +
  ' M12,18h6v1h-6z M30,18h6v1h-6z M12,19h6v1h-6z M30,19h6v1h-6z' +
  ' M12,20h6v1h-6z M30,20h6v1h-6z M12,21h24v1h-24z M12,22h24v1h-24z' +
  ' M12,23h24v1h-24z M12,24h24v1h-24z M12,25h24v1h-24z M12,26h24v1h-24z' +
  ' M12,27h24v1h-24z M12,28h24v1h-24z M12,29h24v1h-24z M12,30h24v1h-24z' +
  ' M12,31h24v1h-24z M12,32h24v1h-24z M12,33h24v1h-24z M12,34h24v1h-24z' +
  ' M12,35h24v1h-24z M12,36h24v1h-24z M12,37h24v1h-24z M12,38h24v1h-24z" fill="currentColor"/></svg>';

/** Agent provider id → inline SVG icon string. */
const AGENT_ICONS: Record<AgentProvider, string> = {
  claude: CLAUDE_SVG,
  codex: CODEX_SVG,
  antigravity: ANTIGRAVITY_SVG,
  opencode: OPENCODE_SVG,
};

/** Placeholder swapped for the agent badge CSS; sits inside each webview's `<style>`. */
export const AGENT_CSS_MARKER = '/*KARST_AGENT_CSS*/';

/** Placeholder swapped for the agent badge JS; sits as the first statement in each webview's `<script>`. */
export const AGENT_JS_MARKER = '/*KARST_AGENT_JS*/';

/** The `.agentbadge`/`.agenticon`/`.agentname` rules shared by every agent badge. */
export function agentIdentityCss(): string {
  return (
    '.agentbadge{display:inline-flex;align-items:center;gap:5px}' +
    '.agenticon{flex:none;width:14px;height:14px;display:inline-flex}' +
    '.agentbadge .agentname{font-weight:600}'
  );
}

/**
 * The JS blob defining `AGENT_PROVIDER_LABELS`, the agent SVG constants,
 * `agentBadgeHtml`, and `agentIconHtml` in the webview's global script scope.
 * Emitted as plain statements (no wrapping `<script>` tag) so it can be
 * injected as the first lines of an existing block.
 */
export function agentIdentityJs(): string {
  return (
    `const AGENT_PROVIDER_LABELS = ${JSON.stringify(AGENT_PROVIDER_LABELS)};\n` +
    `const AGENT_ICONS = ${JSON.stringify(AGENT_ICONS)};\n` +
    // Falls back to the raw id (title-cased) for a provider with no known icon/label,
    // so a future provider degrades gracefully instead of rendering blank.
    'function agentBadgeHtml(provider) {\n' +
    '  const p = provider || "";\n' +
    '  const label = Object.prototype.hasOwnProperty.call(AGENT_PROVIDER_LABELS, p)' +
    ' ? AGENT_PROVIDER_LABELS[p] : (p.charAt(0).toUpperCase() + p.slice(1));\n' +
    '  const icon = AGENT_ICONS[p] || "";\n' +
    '  const iconHtml = icon ? \'<span class="agenticon" aria-hidden="true">\' + icon + \'</span>\' : "";\n' +
    '  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;" }[c]));\n' +
    '  return \'<span class="agentbadge">\' + iconHtml + \'<span class="agentname">\' + esc(label) + \'</span></span>\';\n' +
    '}\n' +
    // The mark alone, for a context that already names the provider in its own text.
    'function agentIconHtml(provider) {\n' +
    '  const icon = AGENT_ICONS[provider] || "";\n' +
    '  return icon ? \'<span class="agenticon" aria-hidden="true">\' + icon + \'</span>\' : "";\n' +
    '}'
  );
}

/** Replace the agent CSS/JS markers with the emitted blocks; no-op per marker if absent. */
export function injectAgentIdentity(html: string): string {
  return html
    .replace(AGENT_CSS_MARKER, agentIdentityCss())
    .replace(AGENT_JS_MARKER, agentIdentityJs());
}
