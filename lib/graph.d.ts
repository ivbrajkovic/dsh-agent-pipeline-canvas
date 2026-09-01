import type { InputPortSpec, PipelineGraph, PortSide, ValidationResult } from "./types.ts";
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
 * The control ids lying on at least one directed cycle of the HONEST graph —
 * the canvas's membership test for the run view's iteration display
 * (docs/proposals/loops.md L4: an if on a cycle shows the loop's iteration).
 * A control lies on a cycle exactly when the drawn graph can walk back to it
 * (feeder → control → branch → … → feeder); a feeder that sits on some other
 * loop does not pull its control in, and a branch aimed into an unrelated
 * cycle does not either — participation, not presence (the cycleClosingFlip
 * precedent). Lowering contracts each such cycle onto the feeder, so every
 * cycle found here is one the kernel really runs. Total over malformed
 * declarations; never throws.
 */
export declare function loopControlIds(graph: unknown): ReadonlySet<string>;
/**
 * The agent ids lying on at least one directed cycle of the LOWERED graph —
 * the canvas's membership test for the branch editor's shadowing diagnosis
 * (which branches wire back into a loop). Lowered self-loops count (a branch
 * wired back to its own feeder is a real one-node cycle the kernel runs), and
 * so would an honest self-connection, which validateGraph refuses separately.
 * Total over malformed declarations; never throws.
 */
export declare function cycleNodeIds(graph: unknown): ReadonlySet<string>;
/** A per-agent port-declaration patch the canvas applies verbatim. A field set to undefined CLEARS it (the owner-handoff strip precedent). */
export interface PortPatch {
    inputPorts?: InputPortSpec[];
    outputPorts?: string[];
    outputPortSides?: Record<string, PortSide>;
}
/** The canvas's description of one wire gesture: where it left, where it landed, and the tick it grabbed (when it grabbed one). */
export interface WireDropDraft {
    source: string;
    target: string;
    /** The node edge the drag left from; default "right" when the grab pinned no tick. */
    sourceSide?: PortSide;
    /** The node edge the drop landed on (read for agent targets only — a control takes its single unnamed input). */
    targetSide?: PortSide;
    /** The grabbed output tick's port name — pins the source side when the edge stacks several. */
    grabbedSourcePort?: string;
}
/** One wire-drop resolution: the connection's port names plus the declarations to author in the same update. */
export interface WireDropVerdict {
    /** The resolved source port NAME (omitted = the default "out"). */
    sourcePort?: string;
    /** The resolved target port NAME (omitted = the default "in"; always omitted for a control target). */
    targetPort?: string;
    /** Per-agent patches to apply with the edge (minted ports, the folded cycle-entry flip). */
    agentUpdates: Record<string, PortPatch>;
}
/**
 * The input port NAME living on one node edge of an agent record — the first
 * declared port resolving there, the implicit "in" on the default edge of an
 * undeclared node, or null when the edge is open (a drop there mints one).
 * Shared by the canvas's snap ring and the drop resolution, so the preview
 * and the commit can never disagree.
 */
export declare function inputPortOnSide(agent: unknown, side: PortSide): string | null;
/**
 * The output port NAME living on one node edge of an agent record — same
 * reading as inputPortOnSide with the output defaults (implicit "out" on the
 * right edge of an undeclared node).
 */
export declare function outputPortOnSide(agent: unknown, side: PortSide): string | null;
/**
 * The wire-drop resolution (the four-point model's whole brain). Given the
 * honest graph WITHOUT the wire and where the wire was grabbed/dropped:
 *
 * - Source side: the grabbed tick pins the port; else the first declared
 *   output on the grabbed edge; else one is MINTED — named after the edge
 *   ("top"/"bottom"/"left"; "out" on the default right edge), numbered when
 *   taken, declared in `outputPorts` (+ `outputPortSides` for non-default
 *   edges) in the same update. Minting onto an undeclared node declares the
 *   default "out" too — a present list REPLACES the default, and the right
 *   point must keep working.
 * - Target side (agent targets): the first declared input on the landed edge,
 *   else a minted `{ name, side }` spec — with the same declare-the-default
 *   rule for `inputPorts`. A control target resolves to nothing (it owns no
 *   input port) and patches nothing.
 * - The cycle-entry flip (cycleClosingFlip) is folded in: it runs on the
 *   graph WITH the minted declarations and the prospective wire, so a
 *   cycle-closing drop that mints its own entry port flips THAT port to
 *   any-of; a control-sourced edge answers through its owner exactly as the
 *   kernel will run it.
 *
 * Total over malformed input: unresolved ids return `{ agentUpdates: {} }`,
 * never throws. The graph argument is always the canvas's buildGraph output —
 * the default in-port is composed as `<id>:in` there, and hand-edited legacy
 * `input` strings never reach canvas state (loadAgent drops them) — so this
 * resolution needs no legacy-wire-id guard of its own; the folded
 * cycleClosingFlip keeps its own guard, being a public helper that also
 * answers over persisted shapes.
 */
export declare function resolveWireDrop(graph: unknown, draft: unknown): WireDropVerdict;
/**
 * The unwire retraction (the mint's other half): after a connection goes
 * away, each endpoint port it used that now wires nowhere — and carries
 * nothing the author shaped — is retracted, so the honest graph never
 * accumulates invisible declarations behind deleted wires.
 *
 * A port survives when it still wires somewhere; when a binding row names it
 * (an emission target is behavior); or — on the input side — when it declares
 * a `bound` (a loop budget is deliberate numeric authoring; silently
 * deleting numbers is never right). Everything else retracts, including an
 * assist-flipped any-of policy: the flip existed for its wire, and re-drawing
 * the loop re-flips. Retraction canonicalizes back to the historical shape
 * when only a plain default remains (`outputPorts: ["out"]` still rendering
 * right, a bare `[{ name: "in" }]`) — the undeclared form the graph would
 * have had all along. An output port's side-map entry goes with it.
 *
 * Connection records are read tolerantly (wire-id or bare port names — the
 * canvas state and the persisted shape both work). Only the passed
 * connections' endpoints are touched; the graph is the AFTER-REMOVAL state.
 */
export declare function retractOrphanPorts(graphAfter: unknown, removed: readonly unknown[]): {
    agentUpdates: Record<string, PortPatch>;
};
//# sourceMappingURL=graph.d.ts.map