/** Lines of a failed setup's output kept in `logs/setup.log` (arch:AC-40): enough for the native-build stderr above npm's trailer. */
export const SETUP_FAILED_LOG_LINES = 120;
/** Hosts named in one reason. */
const MAX_BLOCKED_HOSTS = 5;

const lineList = (body: string): string[] => body.split('\n').filter((l) => l.trim() !== '');
const isWarn = (l: string): boolean => /\bwarn(ing)?\b/i.test(l.slice(0, 30));

/** npm's own closing boilerplate (`code 1`, `code E404`, `path`, …): it never says what went wrong. */
const BOILERPLATE = /^(?:npm\s+(?:error|ERR!)\s+)?(?:A complete log of this run can be found in|code \S+|path |command failed|command sh -c|signal\b)/;
const isBoilerplate = (l: string): boolean => BOILERPLATE.test(l.trim());
const isNpmError = (l: string): boolean => /^\s*npm (?:error|ERR!)\b/.test(l);

/**
 * The line worth quoting for a failed setup. npm always ends with trailer lines (`A complete log …`,
 * `code`, `path`, `command failed`), so those never win. Then: a `stack Error:` / `Error: <message>` /
 * `gyp ERR! … error` line, else the first other `npm error` line, else the last non-warning line.
 * Warn-only output is not quoted.
 */
export function quoteLine(body: string): string {
  const lines = lineList(body).filter((l) => !isBoilerplate(l));
  const first = (re: RegExp): string | undefined => lines.find((l) => re.test(l));
  return (
    first(/ERR! stack Error:\s*\S/) ??
    first(/\bError:\s*\S/) ??
    first(/gyp ERR! .*error/i) ??
    lines.find(isNpmError) ??
    [...lines].reverse().find((l) => !isWarn(l)) ??
    ''
  );
}

const HOST = '[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}';
const DNS_FAILURE = new RegExp(`(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo \\w+)\\s+(${HOST})`, 'i');
/** A refusal that does not name the host: the allowlist proxy's 403 (CONNECT), undici's cancel. */
const REFUSED = /statusCode=40[37]|CONNECT tunnel failed, response 40[37]|\b40[37] (?:Forbidden|Proxy Authentication Required)|tunneling socket|Request was cancelled|UND_ERR_\w+/i;
const URL_HOST = new RegExp(`https?://(${HOST})`, 'i');
/** A successful fetch line names a host that is NOT the blocked one. */
const FETCH_OK = /http fetch \w+ [23]\d\d\b/i;

/** The distinct hosts a failed setup's output blames on the network (DNS/refused, or a proxy refusal near a URL), at most five. */
export function blockedHostsFromOutput(body: string): string[] {
  const lines = body.split('\n');
  const hosts: string[] = [];
  const add = (h: string | undefined): void => {
    const host = h?.toLowerCase();
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  lines.forEach((line, i) => {
    const dns = DNS_FAILURE.exec(line)?.[1];
    if (dns) return add(dns);
    if (!REFUSED.test(line)) return;
    for (let j = i; j >= 0; j--) {
      const l = lines[j]!;
      if (j !== i && FETCH_OK.test(l)) continue;
      const url = URL_HOST.exec(l)?.[1];
      if (url) return add(url);
    }
  });
  return hosts.slice(0, MAX_BLOCKED_HOSTS);
}

/** `*.suffix` covers the suffix itself and its subdomains. */
const isOpen = (host: string, open: readonly string[]): boolean =>
  open.some((o) => (o.startsWith('*.') ? host === o.slice(2) || host.endsWith(o.slice(1)) : host === o));

/**
 * `, blocked host(s) <h1>, <h2> (add to sandbox.setupHosts)`, or ''. `denied` = the docker proxy's DENY log
 * (reliable), `fromOutput` = parsed; hosts already in the open `setupHosts` are not blocked ones.
 */
export function blockedSuffix(denied: readonly string[], fromOutput: readonly string[], open: readonly string[]): string {
  const hosts = [...new Set([...denied, ...fromOutput].map((h) => h.toLowerCase()))].filter((h) => !isOpen(h, open)).slice(0, MAX_BLOCKED_HOSTS);
  return hosts.length > 0 ? `, blocked host(s) ${hosts.join(', ')} (add to sandbox.setupHosts)` : '';
}

/** The sandbox-side npm debug log a failed `npm` names (`…/.npm/_logs/<file>.log`), if any. */
export function npmDebugLogPath(output: string): string | undefined {
  return /(\/[^\s'"`]*\/\.npm\/_logs\/[^\s'"`/]+?\.log)/.exec(output)?.[1];
}

/** The kept tail of a failed setup: blank lines and `silly` / `http fetch` noise dropped. */
export function failedTail(output: string): string {
  return lineList(output)
    .filter((l) => !/^\s*(?:npm\s+)?sill(?:y)?\b|\bhttp fetch\b/i.test(l))
    .slice(-SETUP_FAILED_LOG_LINES)
    .join('\n');
}
