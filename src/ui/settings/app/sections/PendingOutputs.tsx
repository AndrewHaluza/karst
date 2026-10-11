/**
 * Install-time output suggestions for one approach, awaiting the user's call.
 *
 * The scan that produced them never touched karst.yml; this panel is the only
 * path there. Each row can be edited (glob + kind) and accepted or rejected;
 * nothing is sent until "Apply", and only the accepted rows travel to the host,
 * which merges them into the approach's `outputs:`. The approach's built-in
 * default outputs (T1 table) are already in force, so they are listed as
 * pre-accepted and are not editable here.
 */
import { useEffect, useRef, useState } from 'react';
import { OUTPUT_KINDS } from '../../../../manifest/types.js';
import type { OutputDef, OutputKind } from '../../../../manifest/types.js';
import type { PendingOutputsView } from '../../../../approaches/pendingOutputs.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import { Button } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';

interface Row {
  readonly glob: string;
  readonly kind: OutputKind;
  readonly accept: boolean;
}

const KIND_OPTIONS = OUTPUT_KINDS.map((k) => ({ value: k, label: k }));

function isKind(v: string): v is OutputKind {
  return (OUTPUT_KINDS as readonly string[]).includes(v);
}

function toRows(suggestions: readonly OutputDef[]): Row[] {
  return suggestions.map((s) => ({ glob: s.glob, kind: s.kind, accept: true }));
}

export function PendingOutputs({
  approachId,
  view,
}: {
  readonly approachId: string;
  readonly view: PendingOutputsView;
}) {
  const { state, send } = useSettingsApp();
  const [rows, setRows] = useState<Row[]>(() => toRows(view.suggestions));

  const resolve = useHostMutation<[OutputDef[]]>({
    kind: 'Resolve pending outputs',
    send: (requestId, accepted) => send.resolvePendingOutputs(approachId, accepted, requestId),
  });

  // Settle from the reducer's receipt, once per request (same shape as the
  // roster card's prompt link).
  const receipts = state.receipts;
  const settledRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const id = resolve.requestId;
    if (id === undefined || settledRef.current.has(id)) return;
    const receipt = receipts[id];
    if (!receipt) return;
    settledRef.current = new Set(settledRef.current).add(id);
    resolve.settle({
      requestId: id,
      result: receipt.ok ? 'success' : 'failure',
      message: receipt.message ?? undefined,
    });
  }, [receipts, resolve]);

  const patch = (index: number, change: Partial<Row>): void =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...change } : r)));

  const accepted = rows
    .filter((r) => r.accept && r.glob.trim() !== '')
    .map((r): OutputDef => ({ glob: r.glob.trim(), kind: r.kind }));

  return (
    <div className="pending-outputs" data-pending-outputs={approachId}>
      <div className="graph-subsection-title">Suggested output locations</div>
      <div className="page-desc">
        Found in this approach&apos;s prompts at install. Nothing is added to karst.yml until you
        apply.
      </div>
      {view.preAccepted.map((o) => (
        <div className="pending-output-row" key={`default:${o.glob}`}>
          <span className="approach-id">{o.glob}</span>
          <span className="approach-label">{o.kind}</span>
          <span className="builtin-tag">Built-in · accepted</span>
        </div>
      ))}
      {rows.map((row, index) => (
        <div className="pending-output-row" key={`${approachId}:${view.suggestions[index]?.glob ?? index}`}>
          <Field
            label="Accept"
            hideLabel
            control={{
              kind: 'checkbox',
              name: `pending-accept-${approachId}-${index}`,
              checked: row.accept,
              onChange: (accept) => patch(index, { accept }),
              switchLabel: row.accept ? 'Accept' : 'Reject',
            }}
          />
          <Field
            label="Glob"
            hideLabel
            control={{
              kind: 'input',
              name: `pending-glob-${approachId}-${index}`,
              value: row.glob,
              onChange: (glob) => patch(index, { glob }),
            }}
          />
          <Field
            label="Kind"
            hideLabel
            control={{
              kind: 'select',
              name: `pending-kind-${approachId}-${index}`,
              value: row.kind,
              options: KIND_OPTIONS,
              onChange: (value) => {
                if (isKind(value)) patch(index, { kind: value });
              },
            }}
          />
        </div>
      ))}
      <div className="approach-actions">
        <Button
          variant="primary"
          size="sm"
          busy={resolve.pending}
          disabled={resolve.disabled}
          onClick={() => resolve.trigger(accepted)}
        >
          {accepted.length > 0 ? `Accept ${accepted.length} selected` : 'Dismiss all'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          busy={resolve.pending}
          disabled={resolve.disabled}
          onClick={() => resolve.trigger([])}
        >
          Reject all
        </Button>
      </div>
    </div>
  );
}
