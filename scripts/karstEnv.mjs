// Pure env helpers shared by the vitest setup file. Dependency-free and
// side-effect-free, so a test can import the reducer without touching the real
// process.env.

/** Every key karst exports into a launched terminal's env. */
const KARST_ENV_KEY = /^KARST_/;

/**
 * Return a copy of `env` with every `KARST_*` key removed. Never mutates the
 * input — handing it `process.env` cannot change the real env.
 */
export function scrubKarstEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !KARST_ENV_KEY.test(key)));
}
