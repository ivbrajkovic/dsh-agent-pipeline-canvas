import type { IfBranch, PipelineGraph, ValidationError } from "./types.ts";
/** What the shared graph rules need to know about a graph's controls. */
export interface ControlAnalysis {
    /**
     * The resolvable control ids: well-shaped entries with a non-empty id,
     * first of any duplicates, none colliding with an agent id — exactly the
     * ids a connection endpoint may resolve to unambiguously.
     */
    ids: ReadonlySet<string>;
    /** control id -> the single feeding agent's id, when that agent exists. */
    sourceByControl: ReadonlyMap<string, string>;
    /** control id -> declared branch names (a control-sourced edge's sourcePort must name one). */
    branchNames: ReadonlyMap<string, readonly string[]>;
}
/**
 * The control-aware validation rules, run by validateGraph after the agents
 * pass and before the connections pass (which consumes the returned
 * analysis). Control-specific failures report on the control
 * (`control-invalid` shape/ids, `if-source-invalid` feeding, `if-owner-conflict`
 * emission ownership, `if-branch-invalid` branch rules); non-fatal findings
 * ride `warnings` (`if-side-conflict` side stacking, plus the never-fire
 * warnings for a schema-less or breakpointed source). Only `kind: "if"`
 * controls carry the if rules — a future kind passes the shape checks and
 * owns its own.
 *
 * @param graph - the raw graph value (agents/connections/controls as unknown).
 * @param agentIds - the known agent ids (from validateGraph's agents pass).
 * @param errors - validateGraph's error sink.
 * @param warnings - validateGraph's warning sink.
 * @returns the analysis for graph.ts's endpoint/cycle handling.
 */
export declare function validateControls(graph: {
    agents?: unknown;
    connections?: unknown;
    controls?: unknown;
}, agentIds: ReadonlySet<string>, errors: ValidationError[], warnings: ValidationError[]): ControlAnalysis;
/**
 * Lower an honest graph (controls as nodes) onto the port/binding mechanics
 * the kernel already runs: for control `K` with source agent `A`, `A` gains
 * `K.branches[].name` as its `outputPorts` and the branch rules as its
 * `bindings`, every connection `K:<branch> → T:<port>` becomes
 * `A:<branch> → T:<port>` (the sourcePort wire id re-prefixed), and `K` —
 * with its feeding edge — is dropped. The result is exactly the graph a
 * hand-authored ports+bindings twin would be:
 *
 *   - a branch authored `value: ""` lowers to a binding with NO `value` key
 *     (the executor's catch-all test is `value === undefined`, so a literal
 *     empty string would compare against "" and never catch);
 *   - a `>=` branch forwards its `op` into the binding (the key drops for
 *     `==`/absent — the house convention for non-defaults; `$count` fields
 *     pass through untouched);
 *   - non-default branch sides forward into `A`'s `outputPortSides`, the map
 *     omitted when it would be empty (the house convention);
 *   - the `controls` key is absent from the result (it is never persisted).
 *
 * TOTAL over malformed records: a hand-edited control normalizes or skips,
 * never throws — the resurrection path re-enters run() without validation.
 * A graph without controls lowers to itself.
 */
export declare function lowerControls(graph: PipelineGraph | null | undefined): PipelineGraph;
/**
 * The branches one source-agent firing CHOSE, from the firing's `emittedTo`
 * (the P7 kernel's emission record). Lowering maps each branch onto an output
 * port of the SAME name, so `emittedTo`'s port names are the branch names;
 * intersecting with the declared branches keeps a drifted or hand-edited graph
 * honest — a port the control never declared reports no branch. Returns the
 * chosen names in declaration order. Total over malformed input, and `[]` is
 * also the no-selection answer: the caller distinguishes "decided quiet" from
 * "not yet decided" by whether the firing carries an `emittedTo` at all, not
 * by this return value.
 */
export declare function firedBranches(branches: readonly IfBranch[] | undefined | null, emittedTo: readonly unknown[] | undefined | null): string[];
//# sourceMappingURL=controls.d.ts.map