import type { PipelineGraph, ValidationResult } from "./types.ts";
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
//# sourceMappingURL=graph.d.ts.map