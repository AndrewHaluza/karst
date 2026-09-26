# Troubleshooting: Ticket Stuck at UAT

## Symptoms

Ticket is at `uat` stage with:
- `gates: []` (no gates resolved)
- Repo shows `unknown: true` in context
- Stage status is `running` but nothing happens

## Cause

The repo's gate scripts weren't found — typically because:
- The repo is non-runnable (no `service:` block) and the worktree lacks `node_modules`
- The manifest `repositories` entry doesn't match the ticket's selected repo

**Note:** When all gates are deliberately **disabled** by the user, UAT advances **bypassed** (the user chose to skip every check): the stage records `bypassed`, not `passed`, because no gate outcome was proven — and the pipeline continues. This is not a stuck state.

## Fix: Reset to impl, then advance to UAT

### Step 1: Check current state

```bash
node "<ext>/dist/cli/main.js" --db "<db>" context <TICKET_KEY> --json 2>/dev/null
```

Confirm `stageCurrent: "uat"` with `gates: []` and no `blocked` field.

### Step 2: Reset to impl

```bash
node "<ext>/dist/cli/main.js" --db "<db>" test set-stage \
  --ticket <TICKET_KEY> --stage impl --status running
```

### Step 3: Advance to UAT

```bash
node "<ext>/dist/cli/main.js" --db "<db>" stage impl pass \
  --ticket <TICKET_KEY>
```

Output should be `uat`.

### Step 4: Wait for sweep or park manually

The activation sweep should pick up the ticket and resolve gates. If the repo is unknown and gates can't resolve, park manually:

```bash
node "<ext>/dist/cli/main.js" --db "<db>" test set-stage \
  --ticket <TICKET_KEY> --stage uat --status running \
  --block nothing-to-run --block-reason "no gates resolved for this ticket"
```

## Paths

- **Extension dist:** `~/.cursor/extensions/Karst.karst-1.0.0/dist/cli/main.js`
- **Database:** `~/Library/Application Support/Cursor/User/globalStorage/Karst.karst/karst.db`

Both paths carry the extension id, `<publisher>.<name>`, and the publisher is
`Karst` with a capital K. An install made before that casing changed sits under
`karst.karst-1.0.0` / `globalStorage/karst.karst/` instead, and the two
directories do not share a database — an IDE that has seen both shows the newer
one as empty rather than as an error. If tickets you expect are missing, look in
the other directory before concluding anything was lost.
