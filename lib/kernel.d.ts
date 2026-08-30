import type { PortGraph } from "./types.ts";
/** The synthetic source node's id — the key the run input composes under. */
export declare const SOURCE_NODE_ID = "$input";
/** Default concurrent-firing cap (executor spec §1). */
export declare const DEFAULT_MAX_IN_FLIGHT = 4;
/** One message on a stream: a producing node's output. */
export interface KernelMessage {
    /** The node the message came from (SOURCE_NODE_ID for the run input). */
    from: string;
    /** The producing firing's output text. */
    output: string;
}
/** A bound-overflow record (design principle 4): the arriving message was dropped. */
export interface KernelDrop {
    nodeId: string;
    /** The input port NAME the message arrived at. */
    port: string;
    /** The source the dropped message came from. */
    from: string;
}
export interface KernelOptions {
    /** Max firings in flight; DEFAULT_MAX_IN_FLIGHT when absent/invalid. */
    maxInFlight?: unknown;
}
/**
 * The firing kernel over one immutable graph snapshot. The executor drives it:
 * deliver() on every emission, takeForFiring() when starting a node, and
 * beginFiring()/endFiring() around each run; waitChange() is the readiness
 * primitive the executor's main loop sleeps on — every state change resolves
 * it, and the loop re-evaluates gates, caps, and quiescence.
 */
export declare class Kernel {
    /** Max concurrent firings (executor spec §1); the executor enforces it. */
    readonly maxInFlight: number;
    private readonly ports;
    private readonly outEdges;
    private inFlightCount;
    private haltedFlag;
    private readonly firedNodes;
    private readonly changeWaiters;
    constructor(graph: PortGraph, options?: KernelOptions);
    /** How many firings currently hold a kernel slot (started, not finished). */
    get inFlight(): number;
    /** Whether the halt gate is closed (grouped pause: no new firing starts). */
    get halted(): boolean;
    setHalted(halted: boolean): void;
    /** Take an in-flight slot for one firing of `nodeId`. */
    beginFiring(nodeId: string): void;
    /** Release the slot when the firing's runner task is done. */
    endFiring(nodeId: string): void;
    /** Wake waiters when executor-side state changed (abort, control ops). */
    notify(): void;
    /**
     * Deliver one message to a node's input port (wire port id). Enforces the
     * port's delivery bound: when the port already queues its bound, the
     * ARRIVING message is dropped (design principle 4 — "further messages are
     * dropped") and returned as a record entry; nothing fires for it.
     */
    deliver(targetId: string, targetPortId: string, message: KernelMessage): KernelDrop | null;
    /**
     * Nodes whose input policy is currently satisfied, in deterministic (node
     * id) order — the ready order every batch of new firings starts in. The
     * executor additionally applies its own gates on top (halt gate,
     * maxInFlight, restart guards).
     */
    fireableNodes(): string[];
    /**
     * Consume the messages one firing of `nodeId` runs with, in deterministic
     * (port declaration) order: from every non-empty all-of port the oldest
     * message per wired source; from every non-empty any-of port the single
     * head message. Call only for a node fireableNodes() just reported —
     * otherwise the queues would consume partially, which is a caller bug.
     */
    takeForFiring(nodeId: string): KernelMessage[];
    /**
     * Emit one firing's output from `nodeId`: P3 emission is non-selective —
     * the message is copied to every edge of every output port (selective
     * emission and bindings are P7). Returns the bound overflows to record.
     */
    emit(nodeId: string, output: string): KernelDrop[];
    /**
     * The run's end predicate: nothing in flight and nothing fireable outside
     * `exclude` (the executor's restart guard — nodes the log already
     * satisfied never re-fire). When this holds, no future message can arrive
     * (messages come only from firings), so the run is over — the executor
     * reports starving nodes.
     */
    quiescent(exclude?: ReadonlySet<string>): boolean;
    /**
     * Nodes the run went quiet while waiting for: they never fired and can
     * never fire again at quiescence — either they track wired sources whose
     * messages never (all) arrived, or they declare no input ports at all
     * (a port-less node can never fire — surfaced as starvation, not an error).
     * Sorted; the executor subtracts nodes already satisfied by the log before
     * reporting.
     */
    starvingCandidates(): string[];
    /**
     * Promise-per-node readiness, executor-shaped: resolve on the next kernel
     * state change so the main loop can re-evaluate gates, caps, and
     * quiescence. A spurious wake is harmless — the loop re-checks everything.
     */
    waitChange(): Promise<void>;
    /** The firing rule (see the module comment for the pinned interpretation). */
    private satisfied;
    private wake;
}
/** Resolve the run's max-in-flight: a positive integer, else the default (4). */
export declare function normalizeMaxInFlight(value: unknown): number;
//# sourceMappingURL=kernel.d.ts.map