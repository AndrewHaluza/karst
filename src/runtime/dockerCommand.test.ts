import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import type { DockerDef } from '../manifest/types.js';
import { containerName, renderDockerRun } from './dockerCommand.js';

const IMAGE: DockerDef = {
  image: 'postgres:16',
  containerPort: 5432,
  env: { POSTGRES_PASSWORD: 'dev' },
  volumes: ['./data:/var/lib/postgresql/data'],
  args: [],
};

describe('containerName', () => {
  it('is deterministic per (ticket, service)', () => {
    expect(containerName('db', 12)).toBe('karst-t12-db');
    expect(containerName('db', 12)).toBe(containerName('db', 12));
  });

  it('names a baseline (ticketless) container distinctly', () => {
    expect(containerName('db', null)).toBe('karst-baseline-db');
  });

  it('never collides across tickets sharing a service name', () => {
    expect(containerName('db', 1)).not.toBe(containerName('db', 2));
  });

  it('sanitizes characters docker will not accept in a name', () => {
    expect(containerName('web/api service', 3)).toBe('karst-t3-web-api-service');
  });
});

describe('renderDockerRun', () => {
  const base = {
    docker: IMAGE,
    container: 'karst-t1-db',
    hostPort: 4100,
    host: '127.0.0.1',
    env: { PORT: '4100' },
    cwd: '/wt/ticket',
  };

  it('publishes the allocated host port onto the container port', () => {
    const { command, args } = renderDockerRun(base);
    expect(command).toBe('docker');
    expect(args.join(' ')).toContain('-p 127.0.0.1:4100:5432');
  });

  it('runs attached with --rm and the deterministic name', () => {
    const { args } = renderDockerRun(base);
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--name', 'karst-t1-db']);
    // Attached: the client is the pid karst records, and its stdout is the
    // container's log. `-d` would leave karst holding a pid that exits at once.
    expect(args).not.toContain('-d');
  });

  it('forwards the resolved service env and the block env, block winning', () => {
    const { args } = renderDockerRun({
      ...base,
      env: { PORT: '4100', POSTGRES_PASSWORD: 'from-resolver' },
    });
    expect(args).toContain('PORT=4100');
    expect(args).toContain('POSTGRES_PASSWORD=dev');
    expect(args).not.toContain('POSTGRES_PASSWORD=from-resolver');
  });

  it('resolves a relative volume source against the worktree', () => {
    const { args } = renderDockerRun(base);
    expect(args).toContain('/wt/ticket/data:/var/lib/postgresql/data');
  });

  it('leaves an absolute volume source alone', () => {
    const { args } = renderDockerRun({
      ...base,
      docker: { ...IMAGE, volumes: ['/srv/data:/data:ro'] },
    });
    expect(args).toContain('/srv/data:/data:ro');
  });

  it('expands a `~` volume source to the home directory', () => {
    const { args } = renderDockerRun({
      ...base,
      docker: { ...IMAGE, volumes: ['~/data:/data'] },
    });
    expect(args).toContain(`${homedir()}/data:/data`);
    expect(args.some((a) => a.includes('/wt/ticket/~'))).toBe(false);
  });

  it('puts the image last when there is no command override', () => {
    const { args } = renderDockerRun(base);
    expect(args[args.length - 1]).toBe('postgres:16');
  });

  it('puts the command override after the image', () => {
    const { args } = renderDockerRun({
      ...base,
      docker: { ...IMAGE, args: ['postgres', '-c', 'log_statement=all'] },
    });
    expect(args.slice(-4)).toEqual(['postgres:16', 'postgres', '-c', 'log_statement=all']);
  });

  it('passes every argument as its own argv entry — never a shell string', () => {
    const { args } = renderDockerRun({
      ...base,
      docker: { ...IMAGE, env: { GREETING: 'hello world; rm -rf /' }, volumes: [] },
    });
    // One argv entry, quoting-free: `spawn` without a shell never re-parses it,
    // so a value containing spaces or `;` reaches the container verbatim.
    expect(args).toContain('GREETING=hello world; rm -rf /');
  });
});
