import { OUTPUT_TRUNCATION_MARKER } from '../../runtime/boundedOutput.js';

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ParsedFile {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
}

export interface CommitHeader {
  hash: string;
  shortHash: string;
  author: string;
  authoredAt: string;
  subject: string;
}

function rejectTruncated(output: string): void {
  if (output.includes(OUTPUT_TRUNCATION_MARKER)) {
    throw new Error('Git output is incomplete because it was truncated');
  }
}

function required(fields: string[], cursor: number, what: string): string {
  const value = fields[cursor];
  if (value === undefined || value === '') throw new Error(`Incomplete Git ${what} record`);
  return value;
}

/** Strictly parses Git's -z --name-status output without interpreting filenames. */
export function parseNameStatus(output: string): ParsedFile[] {
  rejectTruncated(output);
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const parsed: ParsedFile[] = [];

  for (let cursor = 0; cursor < fields.length;) {
    const token = required(fields, cursor++, 'name-status');
    const code = token[0];
    if (code === 'R' || code === 'C') {
      const oldPath = required(fields, cursor++, 'rename');
      const path = required(fields, cursor++, 'rename');
      parsed.push({ status: code === 'R' ? 'renamed' : 'modified', path, oldPath });
      continue;
    }

    const path = required(fields, cursor++, 'name-status');
    parsed.push({
      status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
      path,
      oldPath: null,
    });
  }

  return parsed;
}

/** Parses the five NUL-delimited fields emitted by the inspection log command. */
export function parseCommitHeaders(output: string): CommitHeader[] {
  rejectTruncated(output);
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 5 !== 0) throw new Error('Incomplete Git commit record');

  const commits: CommitHeader[] = [];
  for (let cursor = 0; cursor < fields.length; cursor += 5) {
    commits.push({
      hash: required(fields, cursor, 'commit'),
      shortHash: required(fields, cursor + 1, 'commit'),
      author: required(fields, cursor + 2, 'commit'),
      authoredAt: required(fields, cursor + 3, 'commit'),
      subject: fields[cursor + 4]!,
    });
  }
  return commits;
}

/**
 * Parses `git ls-files --stage -z`, retaining only stage zero. The first TAB
 * terminates Git's fixed metadata prefix; every later byte belongs to the path.
 */
export function parseStageZeroEntries(output: string): Map<string, string> {
  rejectTruncated(output);
  const records = output.split('\0');
  if (records.at(-1) === '') records.pop();
  const entries = new Map<string, string>();

  for (const record of records) {
    const separator = record.indexOf('\t');
    if (separator <= 0 || separator === record.length - 1) {
      throw new Error('Incomplete Git index record');
    }
    const metadata = record.slice(0, separator).split(' ');
    if (metadata.length !== 3) throw new Error('Malformed Git index metadata');
    const [mode, object, stage] = metadata;
    if (!mode || !/^[0-7]{6}$/.test(mode)) throw new Error('Malformed Git index mode');
    if (!object || !/^[0-9a-f]{40,64}$/i.test(object)) {
      throw new Error('Malformed Git index object id');
    }
    if (!stage || !/^[0-3]$/.test(stage)) throw new Error('Malformed Git index stage');
    if (stage !== '0') continue;

    const path = record.slice(separator + 1);
    if (entries.has(path)) throw new Error('Duplicate stage-zero Git index path');
    entries.set(path, object);
  }

  return entries;
}
