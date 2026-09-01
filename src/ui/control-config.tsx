// The if-control configuration modal: the branch editor. One row per branch —
// `name | field <op> value` with the node edge (side) the branch tick renders
// on — reusing the port-row pattern (name + side) the edge-routing ports
// editor introduced in agent-config.tsx (the .pipeline-config classes come
// from there). The op picker carries the loop vocabulary (docs/proposals/
// loops.md): `==` is the default equality, `>=` compares numerically, and the
// field input suggests the reserved `$count` — the iteration counter whose
// rows fire even without a structured result. Branches evaluate top to
// bottom, first match wins, and the catch-all (empty value) must stay last —
// the editor enforces that ordering constraint live and blocks Save on a
// broken shape (the same discipline as the agent panel's output-schema
// check), while run-time matchability stays with validateGraph's warnings,
// rendered here as passed in by the view (`warnings` under the rows,
// `rowWarnings` — the shadowing diagnosis computed against the graph — inline
// on the offending row).
// Opened from the control node's context menu (nodes carry no edit buttons);
// local state is seeded from the control on mount (keyed by control id
// upstream). Saving
// replaces the control's branches and lets the debounced persist write the
// honest graph back.
import * as React from 'react';
import type { IfBranch, PortSide, ValidationError } from '../types.ts';
import { COUNT_KEY } from '../execution.ts';
import type { CanvasControl } from './shared.ts';
import './agent-config.css';

/** The node edges a branch tick may render on; branches default right. */
const PORT_SIDES: Array<{ value: PortSide; label: string }> = [
  { value: 'left', label: 'left' },
  { value: 'right', label: 'right' },
  { value: 'top', label: 'top' },
  { value: 'bottom', label: 'bottom' },
];

/** The comparison ops a branch row may declare; `==` is the default. */
const BRANCH_OPS: Array<{ value: '==' | '>='; label: string }> = [
  { value: '==', label: '==' },
  { value: '>=', label: '>=' },
];

function asSide(value: unknown): PortSide | null {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
    ? value
    : null;
}

/** One editable branch row (`value` empty = the catch-all). */
interface BranchRow {
  name: string;
  field: string;
  op: '==' | '>=';
  value: string;
  side: PortSide;
}

function ControlConfigPanel({
  control,
  warnings,
  rowWarnings,
  onSave,
  onClose,
}: {
  control: CanvasControl;
  /** validateGraph's warnings that name this control (never-fire sources,
   * side stacking) — surfaced under the rows. */
  warnings: readonly ValidationError[];
  /** The view-computed shadowing diagnosis (docs/proposals/loops.md L3),
   * keyed by branch name: a row wired back into the loop sitting ABOVE a
   * $count row shadows it — worded like cycle-unguarded's finding. */
  rowWarnings?: Record<string, string>;
  onSave: (branches: IfBranch[]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = React.useState<BranchRow[]>(
    control.branches.map((b) => ({
      name: b.name,
      field: typeof b.field === 'string' ? b.field : '',
      op: b.op === '>=' ? '>=' : '==',
      value: b.value === undefined ? '' : String(b.value),
      side: asSide(b.side) ?? 'right',
    })),
  );
  function stopKey(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
  }
  function setRow(index: number, patch: Partial<BranchRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function move(index: number, delta: -1 | 1) {
    setRows((prev) => {
      const next = prev.slice();
      const other = index + delta;
      if (other < 0 || other >= next.length) return prev;
      const tmp = next[index];
      next[index] = next[other];
      next[other] = tmp;
      return next;
    });
  }

  // Live shape check over the rows that carry content (a wholly empty row is
  // dropped at save, never an error): every kept row needs a name, valued
  // rows need a field, names stay unique, a ">=" row's value must coerce to a
  // finite number (a valueless ">=" row is malformed, not a catch-all — the
  // same rule validateBranches applies), and the catch-all — empty value —
  // is only allowed last.
  let shapeError: string | null = null;
  const seenNames = new Set<string>();
  rows.forEach((row, index) => {
    if (shapeError !== null) return;
    const name = row.name.trim();
    const field = row.field.trim();
    const value = row.value.trim();
    if (name.length === 0 && field.length === 0 && value.length === 0) return;
    if (name.length === 0) {
      shapeError = `Branch #${index + 1} has no name.`;
      return;
    }
    if (seenNames.has(name)) {
      shapeError = `Branch "${name}" is declared more than once.`;
      return;
    }
    seenNames.add(name);
    if (value.length > 0 && field.length === 0) {
      shapeError = `Branch "${name}" compares a value but names no field.`;
      return;
    }
    if (row.op === '>=' && !(value.length > 0 && Number.isFinite(Number(value)))) {
      shapeError = `Branch "${name}" compares with ">=" but its value is not a finite number.`;
      return;
    }
    if (value.length === 0 && index < rows.length - 1) {
      shapeError = `Branch "${name}" is a catch-all (empty value) — it must stay the last branch.`;
    }
  });

  // Assemble the persisted branches: wholly empty rows drop; the empty value
  // drops its key (the catch-all shape), a "==" op drops `op`, and a default
  // side drops `side` — buildGraph re-applies the same normalization.
  function assemble(): IfBranch[] {
    return rows
      .filter((r) => r.name.trim().length > 0 || r.field.trim().length > 0 || r.value.trim().length > 0)
      .map((r) => {
        const name = r.name.trim();
        const field = r.field.trim();
        const value = r.value.trim();
        return {
          name,
          field,
          ...(value.length > 0 ? { value } : {}),
          ...(r.op === '>=' ? { op: '>=' as const } : {}),
          ...(r.side !== 'right' ? { side: r.side } : {}),
        };
      });
  }

  return (
    <div
      className='pipeline-config-overlay'
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    >
      <div className='pipeline-config control-config'>
        <h3>Configure If</h3>
        <div className='config-hint'>
          Branches evaluate top to bottom on the feeding agent's structured
          output — first match wins. The op picker carries the loop vocabulary:
          <code> &gt;= </code>compares numerically, and the reserved{' '}
          <code>$count</code> field tests the iteration count (it matches even
          without a structured result). The catch-all (empty value) must stay
          last. Wire each branch tick to the agent that handles it.
        </div>
        <div className='config-row'>
          <label>Branches</label>
          <datalist id='pipeline-branch-fields'>
            <option value={COUNT_KEY}>iteration count</option>
          </datalist>
          {rows.map((row, index) => (
            <React.Fragment key={index}>
              <div
                className='config-mini-row'
              >
                <input
                  value={row.name}
                  placeholder='branch name'
                  title='Branch name — also the output port name connections leave "<controlId>:<branch>"'
                  style={{ flex: '1 1 26%' }}
                  onChange={(e) => {
                    setRow(index, { name: e.target.value });
                  }}
                  onKeyDown={stopKey}
                />
                <input
                  value={row.field}
                  placeholder='field'
                  list='pipeline-branch-fields'
                  title='Structured-output field to compare — the reserved "$count" tests the firing sequence of the feeding agent for this firing (the iteration number at a loop tail)'
                  style={{ flex: '1 1 22%' }}
                  onChange={(e) => {
                    setRow(index, { field: e.target.value });
                  }}
                  onKeyDown={stopKey}
                />
                <select
                  value={row.op}
                  title='Comparison — == matches the value against the field as text; >= compares numerically (Number both sides, finite required)'
                  aria-label='Branch comparison operator'
                  style={{ flex: '0 0 auto', width: 'auto' }}
                  onChange={(e) => {
                    setRow(index, { op: e.target.value === '>=' ? '>=' : '==' });
                  }}
                  onKeyDown={stopKey}
                >
                  {BRANCH_OPS.map((o) => (
                    <option
                      key={o.value}
                      value={o.value}
                    >
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  value={row.value}
                  placeholder={row.field.trim() === COUNT_KEY ? 'iterations — e.g. 3' : 'value — empty = catch-all'}
                  title={row.field.trim() === COUNT_KEY
                    ? 'The iteration threshold — with >= the row matches from this firing number on'
                    : 'Value the field must equal (compared as text). Empty matches any structured result — the catch-all, kept last.'}
                  style={{ flex: '1 1 26%' }}
                  onChange={(e) => {
                    setRow(index, { value: e.target.value });
                  }}
                  onKeyDown={stopKey}
                />
                <select
                  value={row.side}
                  title='Node edge this branch tick renders on'
                  aria-label='Branch side'
                  style={{ flex: '0 0 auto', width: 'auto' }}
                  onChange={(e) => {
                    setRow(index, { side: asSide(e.target.value) ?? 'right' });
                  }}
                  onKeyDown={stopKey}
                >
                  {PORT_SIDES.map((s) => (
                    <option
                      key={s.value}
                      value={s.value}
                    >
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  className='pipeline-btn config-mini-btn'
                  title='Move this branch up (earlier in the evaluation order)'
                  aria-label={'Move branch ' + (row.name || String(index + 1)) + ' up'}
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                >↑</button>
                <button
                  className='pipeline-btn config-mini-btn'
                  title='Move this branch down (later in the evaluation order)'
                  aria-label={'Move branch ' + (row.name || String(index + 1)) + ' down'}
                  disabled={index === rows.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                >↓</button>
                <button
                  className='pipeline-btn config-mini-btn'
                  title='Remove this branch'
                  aria-label={'Remove branch ' + (row.name || String(index + 1))}
                  onClick={() => {
                    setRows((prev) => prev.filter((_, i) => i !== index));
                  }}
                >×</button>
              </div>
              {row.field.trim() === COUNT_KEY ? (
                <div className='config-hint'>
                  {"count " + row.op + " " + (row.value.trim().length > 0 ? row.value.trim() : "…") + " → " + (row.name.trim().length > 0 ? row.name.trim() : "…")}
                  {" — iteration count: the feeding agent's firing sequence for this firing (1-based); with >= it escapes the loop from the threshold on"}
                </div>
              ) : null}
              {rowWarnings !== undefined && rowWarnings[row.name.trim()] ? (
                <div className='config-warning'>{rowWarnings[row.name.trim()]}</div>
              ) : null}
            </React.Fragment>
          ))}
          <button
            className='pipeline-btn config-mini-btn'
            title='Add a branch rule'
            onClick={() => {
              setRows((prev) => prev.concat([{ name: '', field: '', op: '==', value: '', side: 'right' }]));
            }}
          >+ Add branch</button>
          {shapeError !== null ? (
            <div className='config-error'>{shapeError}</div>
          ) : null}
          {warnings.map((w) => (
            <div
              key={w.code + ':' + w.message}
              className='config-warning'
            >{w.message}</div>
          ))}
        </div>
        <div className='config-actions'>
          <button
            className='pipeline-btn'
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className='pipeline-btn'
            disabled={shapeError !== null}
            title={shapeError ?? undefined}
            onClick={() => {
              onSave(assemble());
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export { ControlConfigPanel };
