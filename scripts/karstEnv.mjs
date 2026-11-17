// Pure env helpers shared by the vitest setup file. Dependency-free and
// side-effect-free, so a test can import the reducer without touching the real
// process.env.

/** Every key karst exports into a launched terminal's env. */
const KARST_ENV_KEY = /^KARST_/;

/** Opt-in inputs a person or a UAT harness sets on purpose; a karst terminal never exports them. */
const KEPT_KEYS = new Set(['KARST_SBX_SCRATCH']);

/**
 * Return a copy of `env` with every `KARST_*` key removed except the opt-in `KEPT_KEYS`. Never mutates the
 * input — handing it `process.env` cannot change the real env.
 */
export function scrubKarstEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => KEPT_KEYS.has(key) || !KARST_ENV_KEY.test(key)));
}
