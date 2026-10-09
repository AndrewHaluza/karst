// A karst-launched terminal exports KARST_* (KARST_CLI, KARST_DB, KARST_MANIFEST,
// KARST_TICKET, KARST_OUTBOX, ...). Tests that default their env to process.env
// would inherit them and fail only when run from such a terminal, so scrub them
// once per test file before any test body runs (TEST-ISOLATE-UNIT-SUITE-FROM).
import { scrubKarstEnv } from './karstEnv.mjs';

const scrubbed = scrubKarstEnv(process.env);
for (const key of Object.keys(process.env)) {
  if (!(key in scrubbed)) delete process.env[key];
}

// React 18+ logs "not configured to support act(...)" on every `act()` call in
// a jsdom test unless this flag is set. The Settings COMPONENT tests call
// `act` deliberately, so declare the environment once here instead of letting
// ~240 identical stderr blocks bury real failures.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
