import type { LegacyRunNodeState, RunFiring, RunFiringStatus, RunNodeControlState } from "./types.ts";
/** Any record's per-node slot: a legacy v1 status slot and/or the v2 executor control state. */
export type ProjectableNodeSlot = Partial<LegacyRunNodeState> & RunNodeControlState;
/** What projectNodes reads: a v2 record (firings), a legacy v1 record (order + nodes), or a client mirror of either. */
export interface ProjectableRecord {
    /** The pause pointer: a firing id on v2, a node id on v1. */
    pausedAt?: string;
    /** v2: the firing log. */
    firings?: RunFiring[];
    /** v1: the walk order and per-node status slots. */
    order?: string[];
    nodes?: Record<string, ProjectableNodeSlot>;
}
/** One node's projected view: what the UI would have read off a status slot. */
export interface ProjectedNode {
    nodeId: string;
    /** The last firing's status ("pending" before the node's first firing). */
    status: RunFiringStatus;
    /** The composed input (immutable for the run; shared by every re-firing). */
    input?: string;
    /** Latest defined output across the node's firings. */
    output?: string;
    error?: string;
    stopReason?: string;
    /** Latest defined child session id (the newest firing's child). */
    childSessionId?: string;
    /** The node's firings in log order (the per-firing runs list; empty on v1). */
    firings: RunFiring[];
}
/** The computed per-node view of a run record. */
export interface NodeProjection {
    nodes: Record<string, ProjectedNode>;
    /** Node ids in first-appearance order (v2: firing log; v1: the record's order). */
    order: string[];
    /** The node the run is paused at — from the paused FIRING on v2, from pausedAt on v1. Undefined when not paused or the pointer dangles. */
    pausedNodeId?: string;
    /** The paused firing (v2 only; undefined on legacy records). */
    pausedFiring?: RunFiring;
    /**
     * The pending-pause queue (v2; empty on legacy records): the queue HEAD
     * first (the pausedAt firing), then the other settled-but-unresolved
     * breakpoint firings — status "paused", not superseded by a later firing
     * of the same node — in firing-id order. The live queue is settle-ordered;
     * the depth (length) is what the UI surfaces, and the crash-safe rebuild
     * on the executor side uses the pure id order (the log is the truth).
     */
    pausedQueue: RunFiring[];
}
/**
 * Every firing with `status` that no later firing of the same node supersedes,
 * in firing-id order — the log's unresolved work of that kind. For "paused"
 * these are the settled-but-unresolved breakpoints: the pending-pause queue
 * the UI surfaces and the executor's crash-safe rebuild re-parks (the shared
 * derivation keeps the displayed depth and the rebuilt head from drifting).
 * For "running" these are the firings that were in flight when the process
 * died, which a resumed run must re-fire (executor spec §3). Total over
 * malformed entries (a projection must never be the thing that breaks a
 * render).
 */
export declare function unresolvedFirings(firings: readonly RunFiring[], status: RunFiringStatus): RunFiring[];
/**
 * Project a run record onto the per-node view the UI and tests consume.
 * Total over both record versions and over malformed entries (a projection
 * must never be the thing that breaks a render).
 */
export declare function projectNodes(record: ProjectableRecord): NodeProjection;
//# sourceMappingURL=projection.d.ts.map