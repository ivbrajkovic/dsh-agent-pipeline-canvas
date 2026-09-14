// The if-control configuration modal: the branch editor. Two levels — a
// GATE per branch (`name` + the node edge (side) its tick renders on) with
// any number of CONDITION rows beneath it (`field <op> value`), reusing the
// port-row pattern (name + side) the edge-routing ports editor introduced in
// agent-config.tsx (the .pipeline-config classes come from there). A gate
// fires when ANY of its conditions matches — OR — so "verdict == approve, or
// the count passed three" is one gate with two conditions and ONE tick on the
// canvas; the old shape (two branches stacked on one edge) is no longer
// needed. The op picker carries the loop vocabulary (docs/proposals/
// loops.md): `==` is the default equality, `>=` compares numerically. The
// field inputs suggest the reserved `$count` — the ONLY built-in field, the
// iteration counter whose rows fire even without a structured result — plus
// the feeding agent's output-schema properties (`fieldOptions`, passed in by
// the view), so the fields a gate may test are visible, not guessed. Gates
// evaluate top to bottom against the feeding agent's structured output,
// first MATCHING gate wins; the catch-all — a gate with no conditions, or a
// final condition with an empty value — must stay last. The editor enforces
// that ordering constraint live and blocks Save on a broken shape (the same
// discipline as the agent panel's output-schema check), while run-time
// matchability stays with validateGraph's warnings, rendered here as passed
// in by the view (`warnings` under the rows, `rowWarnings` — the shadowing
// diagnosis computed against the graph — inline on the offending gate).
// Opened from the control node's context menu or a double-click (nodes carry
// no edit buttons); local state is seeded from the control on mount (keyed by
// control id upstream). Saving replaces the control's display name (empty
// falls back to the kind) and its branches — a single-condition gate
// serializes the legacy flat keys, a multi-condition gate the `conditions`
// list — and lets the debounced persist write the honest graph back.
import * as React from 'react';
import type { IfBranch, PortSide, ValidationError } from '../types.ts';
import { COUNT_KEY } from '../execution.ts';
import { branchRows } from '../controls.ts';
import type { CanvasControl } from './shared.ts';
import './agent-config.css';

/** The node edges a branch tick may render on; branches default right. */
const PORT_SIDES: Array<{ value: PortSide; label: string }> = [
  { value: 'left', label: 'left' },
  { value: 'right', label: 'right' },
  { value: 'top', label: 'top' },
  { value: 'bottom', label: 'bottom' },
];

/** The comparison ops a condition row may declare; `==` is the default. */
const BRANCH_OPS: Array<{ value: '==' | '>='; label: string }> = [
  { value: '==', label: '==' },
  { value: '>=', label: '>=' },
];

function asSide(value: unknown): PortSide | null {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
    ? value
    : null;
}

/** One editable condition row (`value` empty = the catch-all row). */
interface ConditionDraft {
  field: string;
  op: '==' | '>=';
  value: string;
}

/** One editable gate: the branch name + side and its condition rows. */
interface BranchDraft {
  name: string;
  side: PortSide;
  conditions: ConditionDraft[];
}

function ControlConfigPanel({
  control,
  warnings,
  rowWarnings,
  fieldOptions,
  onSave,
  onClose,
}: {
  control: CanvasControl;
  /** validateGraph's warnings that name this control (never-fire sources,
   * side stacking) — surfaced under the rows. */
  warnings: readonly ValidationError[];
  /** The view-computed shadowing diagnosis (docs/proposals/loops.md L3),
   * keyed by branch name: a condition wired back into the loop sitting ABOVE
   * a $count row shadows it — worded like cycle-unguarded's finding. */
  rowWarnings?: Record<string, string>;
  /** Candidate fields from the feeding agent's output schema (top-level
   * property names), for the field inputs' suggestions; empty when the
   * source declares no schema. */
  fieldOptions?: readonly string[];
  onSave: (name: string, branches: IfBranch[]) => void;
  onClose: () => void;
}) {
  const [name, setName] = React.useState(control.name ?? '');
  const [gates, setGates] = React.useState<BranchDraft[]>(
    control.branches.map((b) => ({
      name: b.name,
      side: asSide(b.side) ?? 'right',
      conditions: branchRows(b).map((row) => ({
        field: typeof row.field === 'string' ? row.field : '',
        op: row.op === '>=' ? '>=' : '==',
        value: row.value === undefined ? '' : String(row.value),
      })),
    })),
  );
  function stopKey(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
  }
  function setGate(index: number, patch: Partial<BranchDraft>) {
    setGates((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  }
  function setCondition(gateIndex: number, condIndex: number, patch: Partial<ConditionDraft>) {
    setGates((prev) => prev.map((g, i) => (
      i !== gateIndex ? g : { ...g, conditions: g.conditions.map((c, j) => (j === condIndex ? { ...c, ...patch } : c)) }
    )));
  }
  function addCondition(gateIndex: number) {
    setGates((prev) => prev.map((g, i) => (
      i !== gateIndex ? g : { ...g, conditions: g.conditions.concat([{ field: '', op: '==', value: '' }]) }
    )));
  }
  function removeCondition(gateIndex: number, condIndex: number) {
    setGates((prev) => prev.map((g, i) => (
      i !== gateIndex ? g : { ...g, conditions: g.conditions.filter((_, j) => j !== condIndex) }
    )));
  }
  function removeGate(index: number) {
    setGates((prev) => prev.filter((_, i) => i !== index));
  }
  function move(index: number, delta: -1 | 1) {
    setGates((prev) => {
      const next = prev.slice();
      const other = index + delta;
      if (other < 0 || other >= next.length) return prev;
      const tmp = next[index];
      next[index] = next[other];
      next[other] = tmp;
      return next;
    });
  }

  // What saves: wholly empty condition rows drop, then a gate left with no
  // name AND no conditions drops. Everything else must pass the live shape
  // check below — the same rules validateBranches applies to the file.
  function kept(): BranchDraft[] {
    return gates
      .map((g) => ({ ...g, conditions: g.conditions.filter((c) => c.field.trim().length > 0 || c.value.trim().length > 0) }))
      .filter((g) => g.name.trim().length > 0 || g.conditions.length > 0);
  }

  // Live shape check over the gates that carry content: every kept gate needs
  // a name, names stay unique, a valued condition needs a field, a ">="
  // condition's value must coerce to a finite number (a valueless ">="
  // condition is malformed, not a catch-all), and the catch-all — a gate
  // with no conditions, or an empty-value condition — is only allowed at the
  // very end (the final condition of the final gate).
  let shapeError: string | null = null;
  const seenNames = new Set<string>();
  const keptGates = kept();
  keptGates.forEach((gate, gateIndex) => {
    if (shapeError !== null) return;
    const gateName = gate.name.trim();
    const gateLabel = gateName.length > 0 ? `"${gateName}"` : `#${gateIndex + 1}`;
    if (gateName.length === 0) {
      shapeError = `Branch #${gateIndex + 1} has no name.`;
      return;
    }
    if (seenNames.has(gateName)) {
      shapeError = `Branch "${gateName}" is declared more than once.`;
      return;
    }
    seenNames.add(gateName);
    if (gate.conditions.length === 0) {
      if (gateIndex < keptGates.length - 1) {
        shapeError = `Branch ${gateLabel} is a catch-all (no conditions) — it must stay the last branch.`;
      }
      return;
    }
    gate.conditions.forEach((cond, condIndex) => {
      if (shapeError !== null) return;
      const field = cond.field.trim();
      const value = cond.value.trim();
      const rowLabel = gate.conditions.length > 1 ? ` condition #${condIndex + 1}` : '';
      if (value.length > 0 && field.length === 0) {
        shapeError = `Branch ${gateLabel}${rowLabel} compares a value but names no field.`;
        return;
      }
      if (cond.op === '>=' && !(value.length > 0 && Number.isFinite(Number(value)))) {
        shapeError = `Branch ${gateLabel}${rowLabel} compares with ">=" but its value is not a finite number.`;
        return;
      }
      if (value.length === 0 && !(gateIndex === keptGates.length - 1 && condIndex === gate.conditions.length - 1)) {
        shapeError = `Branch ${gateLabel}${rowLabel} is a catch-all (empty value) — it must stay the last condition of the last branch.`;
      }
    });
  });
  // Removing every gate leaves a control with no branches — the broken shape
  // validation refuses ("has no branches"), so the editor refuses it too.
  if (shapeError === null && keptGates.length === 0) {
    shapeError = 'Add at least one branch.';
  }

  // Assemble the persisted branches: a single-condition gate serializes the
  // legacy flat keys (byte-identical to the pre-conditions shape), a
  // multi-condition gate the `conditions` list; the empty value drops its
  // key (the catch-all shape), a "==" op drops `op`, and a default side
  // drops `side` — buildGraph re-applies the same normalization.
  function assemble(): IfBranch[] {
    return keptGates.map((gate) => {
      const gateName = gate.name.trim();
      const side = gate.side !== 'right' ? { side: gate.side } : {};
      if (gate.conditions.length === 0) return { name: gateName, ...side };
      const conditions = gate.conditions.map((cond) => {
        const field = cond.field.trim();
        const value = cond.value.trim();
        return {
          field,
          ...(value.length > 0 ? { value } : {}),
          ...(cond.op === '>=' ? { op: '>=' as const } : {}),
        };
      });
      if (conditions.length === 1) return { name: gateName, ...conditions[0], ...side };
      return { name: gateName, conditions, ...side };
    });
  }

  const fieldList = ['' + COUNT_KEY].concat(fieldOptions ?? []);

  return (
    <div
      className='pipeline-config-overlay'
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    >
      <div className='pipeline-config control-config'>
        <h3>Configure If</h3>
        <div className='config-row'>
          <label>Name</label>
          <input
            value={name}
            placeholder='if'
            title='Display name on the canvas — empty shows the kind ("if"). The id (used by wires and the executor) never changes.'
            onChange={(e) => {
              setName(e.target.value);
            }}
            onKeyDown={stopKey}
          />
        </div>
        <div className='config-hint'>
          Branches evaluate top to bottom on the feeding agent's structured
          output — the first MATCHING branch wins, and a branch fires when ANY
          of its conditions matches (so one gate can carry several: a verdict
          check and a count check together). The op picker carries the loop
          vocabulary: <code>&gt;=</code> compares numerically. The catch-all —
          a branch with no conditions, or a last condition with an empty value
          — must stay last. Wire each branch tick to the agent that handles it.
        </div>
        <div className='config-row'>
          <label>Branches</label>
          <div className='config-hint'>
            {'Built-in fields: '}
            <code>$count</code>
            {' — the feeding agent\'s firing count for this firing (1-based; matches even without a structured result). It is the only built-in. Other fields come from the feeding agent\'s output schema'}
            {fieldOptions !== undefined && fieldOptions.length > 0 ? ': ' + fieldOptions.join(', ') : ' — none declared yet.'}
          </div>
          <datalist id='pipeline-branch-fields'>
            {fieldList.map((field) => (
              <option
                key={field}
                value={field}
              >
                {field === COUNT_KEY ? 'iteration count (built-in)' : field}
              </option>
            ))}
          </datalist>
          {gates.map((gate, gateIndex) => (
            <div
              className='config-branch'
              key={gateIndex}
            >
              <div className='config-mini-row'>
                <input
                  value={gate.name}
                  placeholder='branch name'
                  title='Branch name — also the output port name connections leave "<controlId>:<branch>"'
                  style={{ flex: '1 1 40%' }}
                  onChange={(e) => {
                    setGate(gateIndex, { name: e.target.value });
                  }}
                  onKeyDown={stopKey}
                />
                <select
                  value={gate.side}
                  title='Node edge this branch tick renders on'
                  aria-label='Branch side'
                  style={{ flex: '0 0 auto', width: 'auto' }}
                  onChange={(e) => {
                    setGate(gateIndex, { side: asSide(e.target.value) ?? 'right' });
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
                  aria-label={'Move branch ' + (gate.name || String(gateIndex + 1)) + ' up'}
                  disabled={gateIndex === 0}
                  onClick={() => {
                    move(gateIndex, -1);
                  }}
                >↑</button>
                <button
                  className='pipeline-btn config-mini-btn'
                  title='Move this branch down (later in the evaluation order)'
                  aria-label={'Move branch ' + (gate.name || String(gateIndex + 1)) + ' down'}
                  disabled={gateIndex === gates.length - 1}
                  onClick={() => {
                    move(gateIndex, 1);
                  }}
                >↓</button>
                <button
                  className='pipeline-btn config-mini-btn'
                  title='Remove this branch (with its conditions)'
                  aria-label={'Remove branch ' + (gate.name || String(gateIndex + 1))}
                  onClick={() => {
                    removeGate(gateIndex);
                  }}
                >×</button>
              </div>
              {gate.conditions.length === 0 ? (
                <div className='config-hint config-branch-else'>
                  catch-all — matches any structured result (fires only if no
                  branch above matched)
                </div>
              ) : null}
              {gate.conditions.map((cond, condIndex) => (
                <React.Fragment key={condIndex}>
                  <div className='config-mini-row config-condition'>
                    <input
                      value={cond.field}
                      placeholder='field'
                      list='pipeline-branch-fields'
                      title={'Structured-output field to compare — the reserved "$count" tests the firing sequence of the feeding agent for this firing (the iteration number at a loop tail); other suggestions come from the feeding agent\'s output schema'}
                      style={{ flex: '1 1 32%' }}
                      onChange={(e) => {
                        setCondition(gateIndex, condIndex, { field: e.target.value });
                      }}
                      onKeyDown={stopKey}
                    />
                    <select
                      value={cond.op}
                      title='Comparison — == matches the value against the field as text; >= compares numerically (Number both sides, finite required)'
                      aria-label='Condition comparison operator'
                      style={{ flex: '0 0 auto', width: 'auto' }}
                      onChange={(e) => {
                        setCondition(gateIndex, condIndex, { op: e.target.value === '>=' ? '>=' : '==' });
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
                      value={cond.value}
                      placeholder={cond.field.trim() === COUNT_KEY ? 'iterations — e.g. 3' : 'value — empty = catch-all'}
                      title={cond.field.trim() === COUNT_KEY
                        ? 'The iteration threshold — with >= the row matches from this firing number on'
                        : 'Value the field must equal (compared as text). Empty matches any structured result — the catch-all, kept last.'}
                      style={{ flex: '1 1 32%' }}
                      onChange={(e) => {
                        setCondition(gateIndex, condIndex, { value: e.target.value });
                      }}
                      onKeyDown={stopKey}
                    />
                    <button
                      className='pipeline-btn config-mini-btn'
                      title='Remove this condition'
                      aria-label={'Remove condition ' + (condIndex + 1) + ' of branch ' + (gate.name || String(gateIndex + 1))}
                      onClick={() => {
                        removeCondition(gateIndex, condIndex);
                      }}
                    >×</button>
                  </div>
                  {cond.field.trim() === COUNT_KEY ? (
                    <div className='config-hint'>
                      {"count " + cond.op + " " + (cond.value.trim().length > 0 ? cond.value.trim() : "…") + " → " + (gate.name.trim().length > 0 ? gate.name.trim() : "…")}
                      {" — iteration count: the feeding agent's firing sequence for this firing (1-based); with >= it escapes the loop from the threshold on"}
                    </div>
                  ) : null}
                </React.Fragment>
              ))}
              <button
                className='pipeline-btn config-mini-btn config-add-condition'
                title='Add another condition to this branch — it fires when ANY condition matches'
                onClick={() => {
                  addCondition(gateIndex);
                }}
              >+ condition</button>
              {rowWarnings !== undefined && rowWarnings[gate.name.trim()] ? (
                <div className='config-warning'>{rowWarnings[gate.name.trim()]}</div>
              ) : null}
            </div>
          ))}
          <button
            className='pipeline-btn config-mini-btn'
            title='Add a branch rule'
            onClick={() => {
              setGates((prev) => prev.concat([{ name: '', side: 'right', conditions: [{ field: '', op: '==', value: '' }] }]));
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
              onSave(name.trim(), assemble());
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
