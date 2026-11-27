import { fakeSbxProcess, type FakeCall } from '../sbx/fakeSbxProcess.js';
import type { ProcessResult } from '../sbx/sbxProcess.js';
import type { DockerProcess, PipeEnd, PipeOptions, PipeResult } from './dockerProcess.js';

export interface FakePipeCall {
  readonly from: PipeEnd;
  readonly to: PipeEnd;
  /** The caller's bound/abort, when it named one (a remote image build). */
  readonly opts?: PipeOptions;
}

/**
 * Test double: `run` as `fakeSbxProcess`; every `pipe` answers `pipeResult`.
 *
 * A `transport: true` on an answer is overlaid on the result (the shared sbx
 * double predates the transport flag and drops it): a remote-daemon test marks
 * the exact call that never reached the tool.
 */
export function fakeDockerProcess(
  answers: Record<string, Partial<ProcessResult>> = {},
  pipeResult: PipeResult = { fromCode: 0, toCode: 0 },
): DockerProcess & { readonly calls: FakeCall[]; readonly pipes: FakePipeCall[] } {
  const inner = fakeSbxProcess(answers);
  const pipes: FakePipeCall[] = [];
  const transportKeys = Object.entries(answers)
    .filter(([, answer]) => answer.transport === true)
    .map(([prefix]) => prefix);
  return {
    calls: inner.calls,
    pipes,
    run: async (command, args, opts) => {
      const out = await inner.run(command, args, opts);
      const line = [command, ...args].join(' ');
      return transportKeys.some((key) => line.startsWith(key)) ? { ...out, transport: true } : out;
    },
    pipe: (from, to, opts) => {
      pipes.push({ from, to, ...(opts ? { opts } : {}) });
      return Promise.resolve(pipeResult);
    },
  };
}
