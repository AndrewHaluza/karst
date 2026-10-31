import { isAbsolute, relative, resolve, sep } from 'node:path';
import { statSync } from 'node:fs';
import { AUTH_MOUNT, TASK_MOUNT, allowedHosts, credentialNames, dockerCredentialArgs, evalCore } from './evalMode.mjs';

const valuesOf = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
const DOCKER_ONLY = ['--eval-task', '--eval-env', '--eval-auth-dir'];

/**
 * Splits docker-level eval flags from the ones forwarded to run.mjs and builds the extra
 * `docker run` args. The task dir must be OUTSIDE the checkout (the one named extension of the
 * checkout-containment rule, arch:UATHOST-02) and is mounted at /task; credentials are `-e NAME`
 * only; an auth dir is mounted read-only. Returns null when not an eval run.
 */
export function evalDockerPlan(argv, checkoutRoot, isDir = (p) => statSync(p).isDirectory()) {
  const core = valuesOf(argv, '--eval')[0];
  if (!core) return null;
  evalCore(core);
  const [task] = valuesOf(argv, '--eval-task');
  if (!task) throw new Error('uat-host eval: --eval-task <dir> (the task repo checkout) is required');
  const taskDir = resolve(task);
  const rel = relative(resolve(checkoutRoot), taskDir);
  if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`uat-host eval: --eval-task must be outside the karst checkout: ${taskDir}`);
  }
  if (!isDir(taskDir)) throw new Error(`uat-host eval: --eval-task is not a directory: ${taskDir}`);
  const [authDir] = valuesOf(argv, '--eval-auth-dir');
  if (authDir && !isDir(resolve(authDir))) throw new Error(`uat-host eval: --eval-auth-dir is not a directory: ${resolve(authDir)}`);
  const envNames = credentialNames(valuesOf(argv, '--eval-env'));
  const forwarded = argv.filter((a, i) => !DOCKER_ONLY.includes(a) && !DOCKER_ONLY.includes(argv[i - 1] ?? ''));
  return {
    forwarded,
    dockerArgs: [
      '-v', `${taskDir}:${TASK_MOUNT}`,
      ...(authDir ? ['-v', `${resolve(authDir)}:${AUTH_MOUNT}:ro`, '-e', 'UAT_EVAL_AUTH_DIR=1', '-e', `UAT_EVAL_CORE=${core}`] : []),
      ...dockerCredentialArgs(envNames),
      // NET_ADMIN lets the eval lockdown hook install the egress rule (docker/uat-host/eval-lockdown.sh).
      '--cap-add', 'NET_ADMIN',
      '-e', `EVAL_ALLOWED_HOSTS=${allowedHosts(core).join(',')}`,
    ],
  };
}
