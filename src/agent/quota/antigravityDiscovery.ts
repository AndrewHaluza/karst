import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ANTIGRAVITY_NOT_RUNNING_REASON =
  'Antigravity is not running — quota shows once agy is open';
export const ANTIGRAVITY_UNRESPONSIVE_REASON =
  'Antigravity language server found but did not answer';

export type AntigravityDiscoveryResult =
  | { address: string; csrfToken: string; reason?: never }
  | { reason: string; address?: never; csrfToken?: never };

export interface AntigravityProcessInfo {
  pid: number;
  command: string;
}

export type ProcessLister = () => Promise<AntigravityProcessInfo[]> | AntigravityProcessInfo[];
export type PortLister = (pid: number) => Promise<number[]> | number[];
export type FileReader = (path: string) => Promise<string | null> | (string | null);
export type DirLister = (dir: string) => Promise<string[]> | string[];

export interface AntigravityDiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  listProcesses?: ProcessLister;
  listPorts?: PortLister;
  readFile?: FileReader;
  listDir?: DirLister;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  homeDir?: string;
  appDataDir?: string;
}

export interface ParsedLanguageServerCommand {
  csrfToken: string;
  port: number | null;
}

export function parseLanguageServerCommand(command: string): ParsedLanguageServerCommand | null {
  const tokenMatch = /(?:--|-)(?:csrf_token|csrf-token)(?:=|\s+)["']?([^"'\s]+)["']?/.exec(command);
  if (!tokenMatch || !tokenMatch[1]) {
    return null;
  }
  const csrfToken = tokenMatch[1];

  const portMatch = /(?:--|-)(?:http_server_port|http-server-port|port)(?:=|\s+)["']?(\d+)["']?/.exec(command);
  let port: number | null = null;
  if (portMatch && portMatch[1]) {
    const parsed = parseInt(portMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      port = parsed;
    }
  }

  return { csrfToken, port };
}

export async function defaultListProcesses(): Promise<AntigravityProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,args'], {
      timeout: 2000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = stdout.split('\n');
    const procs: AntigravityProcessInfo[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = /^(\d+)\s+(.+)$/.exec(trimmed);
      if (match && match[1] && match[2]) {
        procs.push({
          pid: parseInt(match[1], 10),
          command: match[2],
        });
      }
    }
    return procs;
  } catch {
    return [];
  }
}

export async function defaultListPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-P', '-n'],
      { timeout: 2000, maxBuffer: 1024 * 1024 },
    );
    const ports = new Set<number>();
    const matches = stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g);
    for (const m of matches) {
      const port = parseInt(m[1]!, 10);
      if (Number.isFinite(port) && port > 0) {
        ports.add(port);
      }
    }
    return Array.from(ports);
  } catch {
    return [];
  }
}

/** Parse one discovery payload (`discovery.json` or a `daemon/*.json`) into an address + CSRF token. */
function parseDiscoveryPayload(data: unknown): { address: string; csrfToken: string } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const csrf =
    typeof record.csrf_token === 'string' && record.csrf_token.length > 0
      ? record.csrf_token
      : typeof record.csrfToken === 'string' && record.csrfToken.length > 0
        ? record.csrfToken
        : null;
  if (!csrf) return null;
  const portCandidates = [record.httpPort, record.http_server_port, record.port];
  const port = portCandidates.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  const address =
    typeof record.address === 'string' && record.address.length > 0
      ? record.address
      : port !== undefined
        ? `127.0.0.1:${port}`
        : null;
  if (!address) return null;
  return { address, csrfToken: csrf };
}

async function readDiscoveryFile(
  path: string,
  readFileFn: FileReader,
): Promise<{ address: string; csrfToken: string } | null> {
  try {
    const content = await readFileFn(path);
    if (!content) return null;
    return parseDiscoveryPayload(JSON.parse(content) as unknown);
  } catch {
    return null;
  }
}

async function probeCandidate(
  address: string,
  csrfToken: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const url = `http://${address}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrfToken,
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function discoverAntigravityServer(
  deps: AntigravityDiscoveryDeps = {},
): Promise<AntigravityDiscoveryResult> {
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 2000;
  const fetchFn = deps.fetchImpl ?? fetch;

  // 1. Env vars (they take priority)
  const envAddress = env.ANTIGRAVITY_LS_ADDRESS?.trim();
  const envCsrf = env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (envAddress && envCsrf) {
    return { address: envAddress, csrfToken: envCsrf };
  }

  // 2. Discovered running server
  const candidates: Array<{ address: string; csrfToken: string }> = [];
  const seen = new Set<string>();

  const addCandidate = (address: string, csrfToken: string) => {
    const key = `${address}:::${csrfToken}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ address, csrfToken });
    }
  };

  // 2a. File-based discovery
  const home = deps.homeDir ?? homedir();
  const candidateDirs: string[] = [];
  if (deps.appDataDir) {
    candidateDirs.push(deps.appDataDir);
  }
  candidateDirs.push(
    join(home, '.gemini', 'antigravity'),
    join(home, '.gemini', 'antigravity-ide'),
    join(home, '.gemini', 'antigravity-cli'),
  );

  const readFileFn =
    deps.readFile ??
    (async (p: string) => {
      try {
        return await readFile(p, 'utf8');
      } catch {
        return null;
      }
    });
  const listDirFn: DirLister =
    deps.listDir ??
    (async (dir: string) => {
      try {
        return await readdir(dir);
      } catch {
        return [];
      }
    });

  for (const dir of candidateDirs) {
    const fromDiscoveryFile = await readDiscoveryFile(join(dir, 'discovery.json'), readFileFn);
    if (fromDiscoveryFile) {
      addCandidate(fromDiscoveryFile.address, fromDiscoveryFile.csrfToken);
    }

    // Daemon sockets (`ls_*.json` / `hub_*.json`) carry httpPort + csrfToken.
    const daemonDir = join(dir, 'daemon');
    let entries: string[] = [];
    try {
      entries = await listDirFn(daemonDir);
    } catch {
      entries = [];
    }
    const daemonFiles = entries
      .filter((name) => /^(?:ls|hub)_.*\.json$/.test(name))
      .sort();
    for (const name of daemonFiles) {
      const parsed = await readDiscoveryFile(join(daemonDir, name), readFileFn);
      if (parsed) {
        addCandidate(parsed.address, parsed.csrfToken);
      }
    }
  }

  // 2b. Process-based discovery
  const listProcessesFn = deps.listProcesses ?? defaultListProcesses;
  let processes: AntigravityProcessInfo[] = [];
  try {
    processes = await listProcessesFn();
  } catch {
    processes = [];
  }

  for (const proc of processes) {
    const cmd = proc.command;
    if (!/language_server|agy\b/.test(cmd) || /grep\b/.test(cmd)) {
      continue;
    }

    const parsed = parseLanguageServerCommand(cmd);
    if (!parsed || !parsed.csrfToken) {
      continue;
    }

    if (parsed.port) {
      addCandidate(`127.0.0.1:${parsed.port}`, parsed.csrfToken);
    } else {
      const listPortsFn = deps.listPorts ?? defaultListPorts;
      try {
        const ports = await listPortsFn(proc.pid);
        for (const port of ports) {
          addCandidate(`127.0.0.1:${port}`, parsed.csrfToken);
        }
      } catch {
        // Ignore port listing failure
      }
    }
  }

  if (candidates.length === 0) {
    return { reason: ANTIGRAVITY_NOT_RUNNING_REASON };
  }

  // Probe candidates with GetUserStatus; pick first one that answers
  for (const candidate of candidates) {
    const answers = await probeCandidate(
      candidate.address,
      candidate.csrfToken,
      fetchFn,
      timeoutMs,
    );
    if (answers) {
      return { address: candidate.address, csrfToken: candidate.csrfToken };
    }
  }

  return { reason: ANTIGRAVITY_UNRESPONSIVE_REASON };
}
