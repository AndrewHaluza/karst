import { fakeSbxProcess } from '../sbx/fakeSbxProcess.js';
import type { ProcessResult } from '../sbx/sbxProcess.js';
import type { DockerProcess, PipeEnd, PipeResult } from './dockerProcess.js';

export interface FakePipeCall {
  readonly from: PipeEnd;
  readonly to: PipeEnd;
}

/** Test double: `run` as `fakeSbxProcess`; every `pipe` answers `pipeResult`. */
export function fakeDockerProcess(
  answers: Record<string, Partial<ProcessResult>> = {},
  pipeResult: PipeResult = { fromCode: 0, toCode: 0 },
): DockerProcess & { readonly calls: ReturnType<typeof fakeSbxProcess>['calls']; readonly pipes: FakePipeCall[] } {
  const inner = fakeSbxProcess(answers);
  const pipes: FakePipeCall[] = [];
  return {
    calls: inner.calls,
    pipes,
    run: inner.run,
    pipe: (from, to) => {
      pipes.push({ from, to });
      return Promise.resolve(pipeResult);
    },
  };
}
