/**
 * `gate_runs.source` of a row the host's gate re-run wrote: evidence, never a UAT batch verdict.
 * A leaf module: a read-only reader (`karst stats`) imports it without reaching a gate_runs writer.
 */
export const HOST_RERUN_SOURCE = 'host-rerun';
