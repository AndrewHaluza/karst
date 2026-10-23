import type { AgentAdapter, InteractiveCommandOpts } from './adapter.js';
import { FakeAdapter } from './fakeCore.js';

/** Where the stub appends `launches.ndjson`; also read back by the UAT probe. */
export const LAUNCH_DIR_ENV = 'KARST_UAT_LAUNCH_DIR';
/** Path of the built stub script (`dist/uat-host/stubAgent.js`), set by the harness. */
export const STUB_AGENT_ENV = 'KARST_UAT_STUB_AGENT';

/**
 * `KARST_FAKE_CORE=launch`: the real adapter builds its command unchanged, then
 * only the executable is swapped for the karst stub, which records what the real
 * CLI would have been given. `runHeadless` stays fake. Other members delegate.
 */
export function wrapLaunchStub(provider: string, real: AgentAdapter, stubPath: string, fake = new FakeAdapter()): AgentAdapter {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'runHeadless') return fake.runHeadless.bind(fake);
      if (prop === 'buildInteractiveCommand') {
        return (opts: InteractiveCommandOpts) => {
          const cmd = target.buildInteractiveCommand(opts);
          const keys = Object.keys(cmd.env).join(',');
          const launchDir = process.env[LAUNCH_DIR_ENV];
          return {
            ...cmd,
            command: 'node',
            args: [stubPath, provider, keys, '--', ...cmd.args],
            env: launchDir ? { ...cmd.env, [LAUNCH_DIR_ENV]: launchDir } : cmd.env,
          };
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
