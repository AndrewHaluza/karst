<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/guides/spinning-the-stack.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'guide:SPIN-01'):
  awk "/^## \[@guide:SPIN-01\]/,/END_DOC_BLOCK: \[@guide:SPIN-01\]/" docs/guides/spinning-the-stack.md
-->

# Spinning the stack: why it works the way it does

Running several tickets' worth of real services at once is where the sharp edges
live. Most of this section exists because a plausible-looking shortcut was found
to be wrong.

The binding rules are in `docs/arch/worktrees-and-servers.md` (`@arch:PORTS`, `@arch:SPAWN-ENV`, `@arch:CONTAINER`, `@arch:ORPHANS`).
This guide gives the reasons for them.

## [@guide:SPIN-01] Ports

**Ports come in contiguous blocks.** A service with three slots gets three
adjacent ports, not three scattered ones. Allocations persist, and a `UNIQUE`
constraint — not the search — is what actually guarantees correctness. Every IDE
window shares one used-set, so overlapping ranges cannot double-book.

The allocator also probes for **live listeners** and unions them in. The registry
answers *what did Karst hand out*, which is a different question from *what is
bound*: a server leaked by a worktree nobody will re-spin holds a port the
registry believes is free. Hand it out and the child dies of `EADDRINUSE`, where
the only symptom Karst would see is a health check that never passes.

**Re-spinning returns the ports you already had.** Allocating fresh would move
one service while its peers keep the old URL in their env — miswiring that looks
like a bug in your code. A missing allocation row is a hard error telling you to
re-spin, never a quiet new port.

END_DOC_BLOCK: [@guide:SPIN-01]

## [@guide:SPIN-02] Health gating

**Health gating knows it might be talking to the wrong server.** Targets may be
HTTP or `tcp://host:port`, because postgres, redis and brokers answer nothing
`fetch` can read and an HTTP-only gate would reject exactly the services people
run as containers.

More importantly: each start carries a `KARST_INSTANCE_TOKEN` that the service
echoes back in a header. A health check that passes against *another worktree's*
service holding that port is a **wrong pass — worse than a failure**, because
everything downstream then wires itself to the wrong gateway. A mismatched token
fails immediately, since waiting cannot turn one instance into another. An
*absent* header keeps polling; it may just be booting.

END_DOC_BLOCK: [@guide:SPIN-02]

## [@guide:SPIN-03] Occupied ports and strangers

**A stranger's process is never killed.** When a port is occupied, occupancy is
decided by who *listens*, not who answers — a frontend dev server binding the
port and 404ing `/health` is still in the way. Killing it requires one of two
licences: a recorded server row whose pid still attributes, or a live process
whose working directory sits inside that service's repository. Anything else is
a stranger, and the start is refused naming the port rather than guessing.

Baseline services are protected under both rules, because killing one costs
every ticket depending on it. The exception is a genuine orphan — a listener
under a baseline checkout with no server row — which *is* reclaimed, since
nothing else would ever reap it and leaving it protected would wedge every
dependent spin until a human intervened.

END_DOC_BLOCK: [@guide:SPIN-03]

## [@guide:SPIN-04] Process and container identity

**A server row is a recollection, not a handle.** Reaping signals a whole
process group, so a wrong answer would `SIGKILL` an unrelated process tree.
Identity is therefore evidence-based: a working directory match corroborated by
an exact start time. A cwd match alone is not proof, because a process launched
from the same worktree can inherit a reissued pid. This replaced an earlier
boot-time check that was true for *any* pid issued since boot — including one
reissued hours after ours exited.

**A container is not its client.** `SIGKILL`ing an attached `docker run` detaches
it from a container that keeps running: port still bound, memory still held,
nothing pointing at it. So containers are always removed **by name** — the OS
reissues pids, Docker does not reissue names.

END_DOC_BLOCK: [@guide:SPIN-04]

## [@guide:SPIN-05] Env layering

**Env is layered so the right thing wins.** A repo's `.env` is read (never
written), then per-ticket overrides, then resolved port and peer URLs last — if
they didn't win, your main checkout's default ports would leak into the worktree
and defeat the whole alternate-port scheme. Overrides shadowed by that final
layer are reported rather than silently dropped.

END_DOC_BLOCK: [@guide:SPIN-05]

## [@guide:SPIN-06] Teardown

**Teardown only undoes what it did.** An aborted spin stops the servers it
started and removes only the worktrees it freshly created; an adopted leftover
from a prior spin is left intact. Each step is isolated, so one failure cannot
strand the rest.

END_DOC_BLOCK: [@guide:SPIN-06]
