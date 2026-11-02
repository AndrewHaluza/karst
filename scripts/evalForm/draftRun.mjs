// Draft pass loop: per exported draft -> commits -> static checks -> diff budget -> judge. Strictly sequential.
import { archKeys, buildDiff, changedFiles, resolveCommits, staticChecks } from './draftChecks.mjs';
import { judgeDraft } from './draftJudge.mjs';

/** `gitFor(repo)` -> git runner or null (no clone configured). */
export async function runDraftEval({ opts, rows, gitFor, judgeAdapter, cwd, onProgress = () => {} }) {
  const results = [];
  for (const row of rows) {
    const r = { id: row.id, ticketId: row.ticketId, ticketKey: row.ticketKey, title: row.payload.title ?? '(untitled)', core: row.core, model: row.model ?? 'unknown', repo: row.repo };
    try {
      const git = gitFor(row.repo);
      if (!git) r.unavailable = 'missing-repo';
      else if (row.model && row.model === opts.judgeModel) r.unavailable = 'judge-wrote-draft';
      else {
        const commits = resolveCommits(git, row.mergeSha);
        if (!commits) r.unavailable = 'missing-commit';
        else {
          const files = changedFiles(git, commits);
          r.defects = staticChecks({ git, commits, files, payload: row.payload, refs: row.refs, docKeys: archKeys(git, commits.parent) });
          const diff = buildDiff(git, commits, files);
          r.truncation = { wasTruncated: diff.wasTruncated, dropped: diff.dropped, truncated: diff.truncated };
          r.files = files.length;
          r.judge = await judgeDraft(judgeAdapter, { draft: row.payload, files, diff: diff.text, model: opts.judgeModel, cwd });
        }
      }
    } catch (e) { r.error = e instanceof Error ? e.message : String(e); }
    results.push(r);
    onProgress(r);
  }
  return results;
}
