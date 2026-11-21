// Setup file of the mutation gate only (vitest.mutation.config.ts).
// The Stryker vitest runner forces worker threads. On Node 22 a worker thread that ends
// while V8 incremental marking is in progress crashes in GC (`~IsolateData` ->
// `DetachCppHeap`). The gate reads that SIGSEGV as a crashed test runner (@arch:GATE-MUTATION).
// V8 flags are process-wide, so turning incremental marking off here also covers the Stryker
// child process that hosts the workers.
import v8 from 'node:v8';

v8.setFlagsFromString('--no-incremental-marking');
