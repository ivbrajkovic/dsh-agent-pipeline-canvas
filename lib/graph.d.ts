import type { InputPortSpec, PipelineGraph, ValidationResult } from "./types.ts";
/**
 * Validate a pipeline graph against the port-graph contract above.
 *
 * @param graph - a value from ``{ agents, connections }``, or null/undefined
 *   (an absent pipeline is valid: there is simply nothing to run).
 * @returns `{ ok, errors, warnings? }` where `ok` is true only when `errors`
 *   is empty. Each error/warning is `{ code, message }`; `code` is a stable
 *   discriminator (link of the class of problem) and `message` is a
 *   human-readable, targeted string (e.g. which agent / connection / port is
 *   at fault). `warnings` carries non-fatal findings (`cycle-present`) and is
 *   present only when non-empty.
 */
export declare function validateGraph(graph: unknown): ValidationResult;
/** The cycle findings behind validateGraph's cycle block (see walkCycles). */
export interface CycleWalk {
    /** The first cycle found on the unmodified lowered graph — a closed path (last == first); [] when acyclic. */
    firstCycle: string[];
    /** The first unguarded cycle's `cycle-unguarded` message, when the walk found one. */
    unguarded?: string;
    /** One `cycle-entry-all-of` message per starved entry port, in discovery order. */
    entryWarnings: string[];
}
/**
 * The guard walk over a LOWERED graph (lowerControls output): find a cycle;
 * if it carries a guard, exclude its guard hop and repeat until no cycle
 * remains or an unguarded one is found — every directed cycle must carry its
 * own guard, and one guard does not cover a second, disjoint cycle. All
 * discovered cycles feed the `cycle-entry-all-of` scan. Total over malformed
 * declarations: unresolvable edges and missing ports never resolve to a
 * guard, and are otherwise invisible (the passes above report them).
 *
 * @param agentIds - the known agent ids (the walk's node universe).
 * @param lowered - the lowered graph (agents and connections only; controls
 *   are gone).
 * @param honestConnections - the HONEST graph's raw connections array, used
 *   to keep honest self-connections out of the walk (they are reported as
 *   `connection-self` once); only the self-loops LOWERING introduces — a
 *   branch wired back to its own feeder — join the walk, matched by
 *   connection id.
 * @returns the walk findings; never throws.
 */
export declare function walkCycles(agentIds: ReadonlySet<string>, lowered: PipelineGraph, honestConnections: readonly unknown[]): CycleWalk;
/** The canvas assist's verdict for one prospective connection (see cycleClosingFlip). */
export interface CycleClosingVerdict {
    /** True when adding the connection closes a directed cycle. */
    closesCycle: boolean;
    /**
     * The target agent's rewritten `inputPorts` declaration — the entered port
     * flipped to "any-of", or the default entry declared as any-of — present
     * only when a cycle-closing drop can safely make the flip (the assist that
     * preempts `cycle-entry-all-of`). Absent when: the drop closes no cycle,
     * the target is a control (it owns no input port), the entered port is
     * already any-of, the ports do not resolve, or the flip would orphan
     * legacy wiring. The declaration is a real graph edit the canvas writes
     * verbatim — visible in the agent panel and View JSON.
     */
    inputPorts?: InputPortSpec[];
}
/**
 * The backward-edge assist's decision (loops L3): does adding this connection
 * close a directed cycle, and which target input port must flip to "any-of"?
 *
 * Cycle detection runs on the lowered form of the honest graph PLUS the
 * prospective connection (lowerControls — the same contraction the run path
 * applies), so a control's branch edge is judged as the owner-agent edge it
 * becomes. The drop closes a cycle exactly when its target can reach its
 * source WITHOUT it — walkCycles reports the first cycle of a graph, not
 * whether a given hop joins one, so the after-graph alone cannot tell a
 * loop-closing back edge from an unrelated wire dropped into an
 * already-cyclic graph (the multi-loop canvases this feature enables); the
 * reachability probe below is the minimal exact consumer of the same lowered
 * machinery.
 *
 * The flip follows the pinned policy: the default entry is declared as
 * `inputPorts: [{ name: "in", policy: "any-of" }]` only when the entered wire
 * id IS the agent's default in-port — a hand-edited legacy `input` string
 * resolves to a different port id, and declaring `inputPorts` there would
 * orphan the existing wiring (skip the flip; the warning speaks) — else the
 * entered declared port's policy set to "any-of" in place (bound and side
 * preserved). A port already at "any-of" needs no flip.
 *
 * Total over malformed input: anything unresolved returns
 * `{ closesCycle: false }`, never throws.
 *
 * @param graph - the HONEST graph in its persisted shape (wire-id ports,
 *   controls allowed) WITHOUT the prospective connection.
 * @param connection - the prospective connection in the same persisted shape
 *   (a control-targeted edge carries no targetPort, a control-sourced one
 *   names its branch as sourcePort).
 */
export declare function cycleClosingFlip(graph: unknown, connection: unknown): CycleClosingVerdict;
/**
 * The agent ids lying on at least one directed cycle of the LOWERED graph —
 * the canvas's membership test for the branch editor's shadowing diagnosis
 * (which branches wire back into a loop). Lowered self-loops count (a branch
 * wired back to its own feeder is a real one-node cycle the kernel runs), and
 * so would an honest self-connection, which validateGraph refuses separately.
 * Total over malformed declarations; never throws.
 */
export declare function cycleNodeIds(graph: unknown): ReadonlySet<string>;
//# sourceMappingURL=graph.d.ts.map