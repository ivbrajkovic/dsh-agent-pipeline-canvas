import type { OutputBinding, PortGraph } from "./types.ts";
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
    /**
     * Output-port bindings per node id (selective emission — the node model's
     * `bindings` field, lifted from the graph snapshot). A node absent from the
     * map emits non-selectively (every output port).
     */
    bindings?: Record<string, OutputBinding[]>;
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
    /** Output ports per node, declaration order — the emission fan-out map. */
    private readonly outPorts;
    private readonly bindings;
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
     * port's delivery bound (design principle 4 — the loop budget): when the
     * port has already ACCEPTED its bound this run, the ARRIVING message is
     * dropped and returned as a record entry; nothing fires for it. The count
     * is deliveries, not backlog — a cycle's consumer drains each message
     * before the next arrives, so only a delivery cap can overflow a loop.
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
     * Emit one firing's output from `nodeId` — SELECTIVE emission (conditional-
     * dispatch §2). Without bindings the message is copied to every edge of
     * every output port (the default-graph behavior, unchanged). With bindings,
     * the first binding matching the firing selects its port — content rows
     * against the firing's STRUCTURED result, `$count` rows against `seq` (the
     * firing's per-node sequence; the executor assigns it, the kernel only
     * receives it); no match — or no structured result at all — selects NO port
     * (the honest quiet: starved downstream nodes surface in the run report,
     * and the empty selection is what the firing's `emittedTo` records; a valued
     * `$count` row is the one match that survives a missing structured result).
     * Returns the selected port names plus the bound overflows to record.
     */
    emit(nodeId: string, output: string, structured?: unknown, seq?: number): {
        ports: string[];
        drops: KernelDrop[];
    };
    /**
     * The ports one firing emits on: every declared port for an unbound node;
     * otherwise the first matched binding's port (when the node declares it —
     * validateGraph reports the mismatch, the kernel stays total), else none.
     */
    private selectEmissionPorts;
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
     * reporting. Known shape of the report (fine in practice): a node that DID
     * fire but now waits on an unsatisfied re-firing round is not listed —
     * harmless because the executor's completed-finalize filter excludes every
     * done/paused node anyway, and a run whose fired node is left non-done
     * finalizes through fail-fast, not here.
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