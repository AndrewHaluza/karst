import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { PipeEnd, PipeResult } from '../docker/dockerProcess.js';
import type { ProcessRunOptions } from '../sbx/sbxProcess.js';
import type { SshProcess, SshResult, SshSpawnOptions } from './sshProcess.js';

/**
 * Test double for the SSH seam, like `docker/fakeDockerProcess.ts`: it records
 * every call (argv and opts), every clone stdin (as bytes, so a bundle can be
 * asserted), every pipe and every stream, and answers by key.
 *
 * A key matches when the joined argv starts with it, or when the remote
 * command (the last argv element, `sh -c '<script>'`) contains it. The longest
 * matching key wins, so a test can answer one step of a multi-step script.
 */
export interface FakeSshCall {
  readonly args: readonly string[];
  readonly opts?: ProcessRunOptions;
}

export interface FakeSshStdinCall extends FakeSshCall {
  readonly stdin: Buffer;
  readonly stdinKind: 'buffer' | 'readable';
}

export interface FakeSshPipeCall {
  readonly from: PipeEnd;
  readonly to: PipeEnd;
}

export interface FakeSshStreamCall {
  readonly args: readonly string[];
  readonly opts?: SshSpawnOptions;
}

export type FakeSshAnswer = Partial<Pick<SshResult, 'code' | 'stdout' | 'stderr' | 'stdoutBuffer' | 'transport'>>;

export interface FakeSshProcess extends SshProcess {
  readonly calls: FakeSshCall[];
  readonly stdinCalls: FakeSshStdinCall[];
  readonly pipes: FakeSshPipeCall[];
  readonly streams: FakeSshStreamCall[];
}

function answerFor(answers: Record<string, FakeSshAnswer>, args: readonly string[]): FakeSshAnswer {
  const line = args.join(' ');
  const remoteCommand = args.at(-1) ?? '';
  const key = Object.keys(answers)
    .filter((k) => line.startsWith(k) || remoteCommand.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return key === undefined ? {} : answers[key]!;
}

function toResult(answer: FakeSshAnswer): SshResult {
  const stdoutBuffer = answer.stdoutBuffer ?? Buffer.from(answer.stdout ?? '');
  return {
    code: answer.code ?? 0,
    stdout: answer.stdout ?? stdoutBuffer.toString('utf8'),
    stdoutBuffer,
    stderr: answer.stderr ?? '',
    ...(answer.transport === true ? { transport: true as const } : {}),
  };
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

/** A `ChildProcess` shape for `spawnStream`; the fake never spawns, so it is an inert emitter. */
function inertChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { kill: () => boolean; stdin: null; stdout: null; stderr: null };
  child.kill = () => true;
  child.stdin = null;
  child.stdout = null;
  child.stderr = null;
  return child as unknown as ChildProcess;
}

export function fakeSshProcess(
  answers: Record<string, FakeSshAnswer> = {},
  pipeResult: PipeResult = { fromCode: 0, toCode: 0 },
): FakeSshProcess {
  const calls: FakeSshCall[] = [];
  const stdinCalls: FakeSshStdinCall[] = [];
  const pipes: FakeSshPipeCall[] = [];
  const streams: FakeSshStreamCall[] = [];
  return {
    calls,
    stdinCalls,
    pipes,
    streams,
    run: (args, opts) => {
      calls.push({ args: [...args], ...(opts ? { opts } : {}) });
      return Promise.resolve(toResult(answerFor(answers, args)));
    },
    runWithStdin: async (args, stdin, opts) => {
      const isBuffer = Buffer.isBuffer(stdin);
      const stdinBytes = isBuffer ? stdin : await drain(stdin);
      const call: FakeSshStdinCall = {
        args: [...args],
        ...(opts ? { opts } : {}),
        stdin: stdinBytes,
        stdinKind: isBuffer ? 'buffer' : 'readable',
      };
      stdinCalls.push(call);
      return toResult(answerFor(answers, args));
    },
    pipe: (from, to) => {
      pipes.push({ from, to });
      return Promise.resolve(pipeResult);
    },
    spawnStream: (args, opts) => {
      streams.push({ args: [...args], ...(opts ? { opts } : {}) });
      return inertChild();
    },
  };
}
