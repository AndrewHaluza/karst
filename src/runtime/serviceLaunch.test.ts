import { describe, it, expect } from 'vitest';
import type { ServiceDef } from '../manifest/types.js';
import { serviceLaunch, expandEnvTokens } from './serviceLaunch.js';

const PORTS = [{ name: 'http', env: 'PORT', default: 3000 }];

const command: ServiceDef = { start: 'npm run dev', ports: PORTS, dependsOn: [] };
const container: ServiceDef = {
  start: '',
  docker: { image: 'postgres:16', containerPort: 5432, env: {}, volumes: [], args: [] },
  ports: PORTS,
  dependsOn: [],
};

const base = {
  name: 'db',
  ticketId: 7,
  env: { PORT: '4100' },
  host: '127.0.0.1',
  port: 4100,
  cwd: '/wt',
};

describe('serviceLaunch', () => {
  it('splits a start command and expands its port tokens', () => {
    const launch = serviceLaunch({
      ...base,
      service: { ...command, start: 'npm run dev -- --port ${PORT}' },
    });
    expect(launch.command).toBe('npm');
    expect(launch.args).toEqual(['run', 'dev', '--', '--port', '4100']);
    expect(launch.container).toBeUndefined();
  });

  it('renders a container service as docker argv with a recorded name', () => {
    const launch = serviceLaunch({ ...base, service: container });
    expect(launch.command).toBe('docker');
    expect(launch.container).toBe('karst-t7-db');
    expect(launch.args).toContain('karst-t7-db');
  });

  it('gates a container start on the PORT, not on an HTTP path it cannot serve', () => {
    // A database answers nothing `fetch` can read: an HTTP default would time
    // out and kill a container that came up perfectly.
    expect(serviceLaunch({ ...base, service: container }).healthUrl).toBe('tcp://127.0.0.1:4100');
  });

  it('keeps the HTTP default for a command service', () => {
    expect(serviceLaunch({ ...base, service: command }).healthUrl).toBe(
      'http://127.0.0.1:4100/health',
    );
  });

  it('honours a declared health template for either kind', () => {
    for (const service of [command, container]) {
      const launch = serviceLaunch({
        ...base,
        service: { ...service, health: 'http://{host}:{port}/ready' },
      });
      expect(launch.healthUrl).toBe('http://127.0.0.1:4100/ready');
    }
  });

  it('names a baseline container without a ticket scope', () => {
    expect(serviceLaunch({ ...base, ticketId: null, service: container }).container).toBe(
      'karst-baseline-db',
    );
  });
});

describe('expandEnvTokens', () => {
  it('expands both `${VAR}` and `$VAR`, and empties an unknown one', () => {
    expect(expandEnvTokens('run --port ${PORT} --dbg $DBG --x $NOPE', { PORT: '1', DBG: '2' })).toBe(
      'run --port 1 --dbg 2 --x ',
    );
  });
});
