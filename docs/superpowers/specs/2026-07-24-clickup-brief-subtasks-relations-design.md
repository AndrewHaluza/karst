# ClickUp Brief Subtasks and Relations

**Ticket:** 869e959kq  
**Date:** 2026-07-24  
**Status:** Approved design

## Problem

Karst's provider-neutral brief model and Markdown renderer already support
parent, child, linked, and dependency relations. The ClickUp provider currently
requests a task without `include_subtasks=true`, so child tasks never reach the
parser. Linked tasks and dependencies are rendered only as opaque task IDs even
when their task metadata can be fetched.

ClickUp's supported Get Task API explicitly does not return Docs attached to a
task. Karst authenticates with a ClickUp API token and will not depend on
ClickUp's undocumented browser endpoints or browser-session credentials.

## Scope

The fetched brief will include:

- immediate child subtasks as `child` relations;
- the current task's parent, linked tasks, and dependencies as today;
- title and status for task relations when that metadata can be obtained from
  the supported ClickUp API;
- a bare task ID when enrichment is unavailable.

The change will not:

- fetch or embed task descriptions for related tasks;
- recurse into nested subtasks;
- expose native attached ClickUp Docs, because the supported API omits them;
- use undocumented ClickUp endpoints or browser-session authentication;
- make a missing or inaccessible related task fail the primary ticket fetch.

## Design

### Fetch

The ClickUp provider will add `include_subtasks=true` to Get Task requests. The
existing `custom_task_ids=true&team_id=...` behavior remains unchanged.

Each immediate subtask included in the response becomes a normalized
`BriefRelation`:

```ts
{
  kind: 'child',
  ref: subtask.id,
  title: subtask.name,
  status: subtask.status?.status
}
```

Only entries whose `parent` equals the fetched task ID are immediate children.
Nested descendants are excluded even if ClickUp returns them in the same
payload.

### Relation enrichment

Relation parsing first builds the existing parent, linked-task, dependency, and
new child relations. The provider then enriches unique task references using
supported Get Task calls. Child relations already carrying title/status do not
require another request.

Enrichment is best effort:

- fetch each unique unresolved reference at most once;
- retain the relation's original kind and ref;
- add nonblank `name` and `status.status` values;
- on a non-2xx response, malformed response, or network failure, keep the bare
  relation rather than failing the primary brief.

The primary task request and comments request keep their current failure
semantics. Attachment materialization is unchanged.

### Rendering

No new Markdown section is needed. The existing `## Relations` renderer already
supports `child`, `title`, and `status`, producing rows such as:

```md
## Relations
- Child: 869abc — Add regression coverage (to do)
- Related to: 869xyz — Update importer (in progress)
```

This preserves byte-identical output for providers and fixtures that do not
supply enrichment fields.

## Error and Security Boundaries

- Related task payloads are untrusted and pass through the existing Markdown
  escaping.
- API tokens remain confined to `api.clickup.com`; no browser cookies or
  internal ClickUp endpoints are introduced.
- Related-task failures degrade locally to bare IDs.
- Query construction continues to use `URLSearchParams` so the subtask flag and
  custom-task parameters compose safely.

## Testing

Strict RED→GREEN coverage will verify:

1. Get Task includes `include_subtasks=true`, with and without `teamId`.
2. Immediate subtasks render as child relations with ID, title, and status.
3. Nested descendants are not presented as immediate children.
4. Parent, linked, and dependency references gain title/status from one
   supported fetch per unique task.
5. Failed related-task enrichment preserves the primary brief and bare relation.
6. Existing bare-brief Markdown remains byte-identical.

After focused tests pass, run the complete test suite, typecheck, and build.

## Upstream Limitation

Native ClickUp Docs attached through the task UI cannot be included because the
official Get Task API states that attached Docs are not returned. Supporting
them later requires ClickUp to expose that relationship through a supported API;
Karst will not infer or scrape it.
