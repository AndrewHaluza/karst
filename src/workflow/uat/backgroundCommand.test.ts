import { describe, expect, it } from 'vitest';
import { endedOnBackgroundCommand } from './backgroundCommand.js';

describe('endedOnBackgroundCommand', () => {
  it('T722 tail: backgrounded run, then [] → true', () => {
    const t =
      '$ npm run uat:host:docker -- --fixture empty\nCommand moved to the background (shell ID: sh_7f3a)\n' +
      'Run A is booting in Docker (background). Waiting for it to finish before inspecting evidence.\n[]';
    expect(endedOnBackgroundCommand(t)).toBe(true);
  });

  it('T690 tail: blocked-fixture run booting → true', () => {
    const t =
      'Command moved to the background (shell ID: sh_91bc)\n' +
      'The blocked-fixture run is booting … I\'ll wait for it before the empty-fixture run\n[]';
    expect(endedOnBackgroundCommand(t)).toBe(true);
  });

  it('T720 tail: output of the shell is read later → false', () => {
    const t =
      'Command moved to the background (shell ID: sh_aa11)\nbash_output sh_aa11\nstep-003 pass\n' +
      '[{"severity":"info","title":"x"}]';
    expect(endedOnBackgroundCommand(t)).toBe(false);
  });

  it('only the last background shell counts', () => {
    const t =
      'Command moved to the background (shell ID: sh_1)\nread sh_1 done\n' +
      'Command moved to the background (shell ID: sh_2)\n[]';
    expect(endedOnBackgroundCommand(t)).toBe(true);
  });

  it('no marker → false', () => {
    expect(endedOnBackgroundCommand('[]')).toBe(false);
  });
});
