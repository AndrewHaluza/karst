// Base drift: tell the ticket's own screenshot breaks from develop's.
//
// A visual/layout gate that fails on screens the ticket never touched costs a
// fix round per ticket whenever develop's baselines drift. So after a failed
// sweep the failing screenshots are re-run at the ticket's merge base (same
// container slot, same install): one that fails there too is DRIFT (reported,
// not failed), one that passes there is the TICKET'S BREAK (fails the gate).
// Pure functions only; scripts/dockerGate.mjs does the git/docker work.

import { isAbsolute, relative } from 'node:path';

/** Most screenshots re-run at the base; above it the base is judged drifted wholesale. */
export const BASE_RERUN_CAP = 40;

function* specsOf(node, project) {
  for (const spec of node.specs ?? []) {
    for (const t of spec.tests ?? []) {
      yield { project: t.projectName ?? project, title: spec.title, status: t.status, results: t.results ?? [] };
    }
  }
  for (const child of node.suites ?? []) yield* specsOf(child, project);
}

const posixRelative = (path, root) => (isAbsolute(path) ? relative(root, path) : path).split('\\').join('/');

/** The failed specs of a Playwright JSON report: screenshot mismatches, plus a count of every other failure. */
export function failingScreenshots(report, root) {
  const screenshots = [];
  let otherFailures = 0;
  for (const spec of specsOf(report, undefined)) {
    if (spec.status !== 'unexpected') continue;
    const expected = spec.results
      .flatMap((r) => r.attachments ?? [])
      .find((a) => a.name?.endsWith('-expected.png') && a.path);
    if (!expected) {
      otherFailures++;
      continue;
    }
    screenshots.push({ project: spec.project, title: spec.title, baseline: posixRelative(expected.path, root) });
  }
  return { screenshots, otherFailures };
}

/**
 * Whether a failed gate can be re-judged against the base.
 * `ownBaselines` are the baselines the ticket itself recorded (never drift).
 */
export function planBaseCheck({ screenshots, otherFailures }, ownBaselines) {
  if (screenshots.length === 0 && otherFailures === 0) return { kind: 'skip' };
  if (otherFailures > 0) {
    return { kind: 'fail', reason: `${otherFailures} failure(s) are not screenshot mismatches; no base comparison` };
  }
  const own = screenshots.filter((s) => ownBaselines.has(s.baseline));
  if (own.length > 0) {
    return {
      kind: 'fail',
      reason: `baseline(s) this ticket recorded fail their own screenshot (approval flow, never drift): ${own
        .map((s) => s.baseline)
        .join(', ')}`,
    };
  }
  if (screenshots.length > BASE_RERUN_CAP) {
    return {
      kind: 'fail',
      reason: `${screenshots.length} screenshots fail (cap ${BASE_RERUN_CAP}): base likely drifted wholesale, so no per-screenshot base check`,
    };
  }
  return { kind: 'run' };
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The playwright argv that re-runs exactly these screenshots in their projects. */
export function baseRerunArgv(screenshots) {
  const projects = [...new Set(screenshots.map((s) => s.project))];
  const titles = [...new Set(screenshots.map((s) => s.title))];
  return [
    'npx', 'playwright', 'test',
    ...projects.map((p) => `--project=${p}`),
    '--grep', titles.map(escapeRegex).join('|'),
  ];
}

/** Split the ticket's failures by what the base run says: failed there = drift, else the ticket's break. */
export function classifyFailures(screenshots, baseReport) {
  const failedAtBase = new Set(
    [...specsOf(baseReport, undefined)].filter((s) => s.status === 'unexpected').map((s) => `${s.project}\0${s.title}`),
  );
  const drift = [];
  const breaks = [];
  for (const s of screenshots) (failedAtBase.has(`${s.project}\0${s.title}`) ? drift : breaks).push(s);
  return { drift, breaks };
}

/** The one-line ticket notice. */
export function driftNotice(count) {
  return `develop has ${count} drifted screenshot${count === 1 ? '' : 's'}; see D311-style cleanup`;
}

const label = (s) => `${s.project}: ${s.title}`;

/** The gate-output lines (the recorded artifact) for a classification. */
export function reportLines({ drift, breaks }) {
  const lines = [];
  if (drift.length > 0) {
    lines.push(`base drift (develop drift, not this ticket) — ${drift.length}:`, ...drift.map((s) => `  - ${label(s)}`));
    lines.push(`NOTICE: ${driftNotice(drift.length)}`);
  }
  if (breaks.length > 0) {
    lines.push(`ticket breaks (pass at the base, fail here) — ${breaks.length}:`, ...breaks.map((s) => `  - ${label(s)}`));
  }
  return lines;
}
