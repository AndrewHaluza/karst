import { EventEmitter } from 'node:events';
import { createTunnelRegistry, type TunnelChild, type TunnelDeps, type TunnelRegistry } from './sshTunnels.js';

/** A tunnel child for tests: `kill` counts and emits `exit`. */
export class FakeTunnelChild extends EventEmitter {
  kills = 0;
  readonly stderr = new EventEmitter();
  constructor(readonly argv: readonly string[]) {
    super();
  }
  kill(): boolean {
    this.kills += 1;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

export interface FakeTunnels {
  readonly registry: TunnelRegistry;
  readonly spawned: FakeTunnelChild[];
}

export interface FakeTunnelsOptions {
  readonly onSpawn?: (child: FakeTunnelChild) => void;
  /** The `-L` readiness answer; default true (ready at once). */
  readonly connect?: boolean;
  /** The pre-spawn host port check; default false (the port is free). */
  readonly portInUse?: boolean;
}

/** A fresh registry (never the window singleton) over a fake spawn; timers fire at once. */
export function fakeTunnels(over: FakeTunnelsOptions = {}): FakeTunnels {
  const spawned: FakeTunnelChild[] = [];
  const deps: TunnelDeps = {
    spawn: (argv): TunnelChild => {
      const child = new FakeTunnelChild(argv);
      spawned.push(child);
      over.onSpawn?.(child);
      return child as unknown as TunnelChild;
    },
    connect: () => Promise.resolve(over.connect ?? true),
    portInUse: () => Promise.resolve(over.portInUse ?? false),
    setTimeout: (cb) => setTimeout(cb, 0),
    clearTimeout: (h) => clearTimeout(h),
  };
  return { registry: createTunnelRegistry(deps), spawned };
}
