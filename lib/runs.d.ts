import { type RunnerContext, type SubagentRunEndInfoLike } from "./runner.ts";
import type { LegacyRunRecord, PipelineGraph, RunRecord } from "./types.ts";
/** The live-Agent fields the parent-anchor machinery reads. */
interface LiveAgentLike {
    id: string;
    options?: Record<string, unknown>;
}
interface AgentHandleLike {
    agent: LiveAgentLike;
    dispose(): Promise<void> | void;
}
/**
 * Structural view of the agents service's parent-anchor surface
 * (`ctx.agents.create` / `ctx.agents.resume` — the agent-loop registers the
 * factory in the base bundle, so a plugin may call both).
 */
interface AnchorAgentsService {
    get(sessionId: string): unknown | undefined;
    create(options: {
        sessionId: string;
        meta?: {
            cwd?: string;
            parentSession?: string;
            origin?: "subagent";
            delegationDepth?: number;
        };
        seed?: unknown[];
        agentOptions?: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<AgentHandleLike>;
    resume(options: {
        resumeSessionId: string;
        agentOptions?: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<AgentHandleLike>;
}
/** The services a RunRegistry needs (a superset of the runner's seams). */
export interface RunRegistryServices extends RunnerContext {
    agents: AnchorAgentsService;
    subagents: RunnerContext["subagents"];
    /** Settlement seam — production wires `ctx.on("subagent/end", fn)`. */
    subscribeRunEnd(fn: (info: SubagentRunEndInfoLike) => void): () => void;
    /** Feature probe: continuable children additionally require persistence. */
    sessionPersistence?: unknown;
}
/** Where a control action may be routed. */
export type ControlOutcome = {
    ok: true;
} | {
    ok: false;
    error: string;
};
/**
 * The per-workspace run registry: starts executors, lazily loads and sweeps
 * persisted records, and routes control commands. One registry per plugin
 * fiber; one active (running|paused) run per (workspace, session).
 */
export declare class RunRegistry {
    private readonly services;
    private readonly executors;
    constructor(services: RunRegistryServices);
    /** Drop in-memory executor state. Used on plugin unload: records on disk are
     * intentionally left untouched so a paused run survives the unload exactly
     * like a process death (the restart sweep resurrects it). */
    dispose(): void;
    /**
     * Start a new run: validate, enforce the single-active-run rule per
     * (cwd, session) — in-memory AND on disk, both scoped to the REQUEST's
     * session — create the record, and start the executor. Returns the runId
     * immediately — the browser follows the record over SSE.
     */
    startRun(request: {
        sessionId: string;
        cwd: string;
        graph?: PipelineGraph | null;
        input?: unknown;
        maxInFlight?: unknown;
    }): Promise<{
        ok: true;
        runId: string;
    } | {
        ok: false;
        error: string;
        activeRunId?: string;
    }>;
    /**
     * The workspace's active run record — or, when `sessionId` is a valid key,
     * THAT session's active run — lazily loading (and sweeping / resurrecting)
     * from disk when no executor is in memory. Returns null when nothing is
     * active within the scope. Without a valid key the unscoped legacy path
     * picks the newest active run of any session.
     */
    activeRunForCwd(cwd: unknown, sessionId?: string | null): Promise<RunRecord | null>;
    /**
     * The most recent record of ANY state for the workspace — or, when
     * `sessionId` is a valid key, of THAT session — the discovery path that
     * lets a remounted canvas restore the last run's outcome (the Result button
     * and the per-node statuses) after its live view is gone. Runs within one
     * (workspace, session) are serialized (one active run at a time, a new run
     * starts only after the previous one settled), so the newest `updatedAt` is
     * the latest run. An in-memory executor is always that run (settled
     * executors leave the map); on disk a stale `running` record is swept and a
     * `paused` one resurrected exactly like `activeRunForCwd` before the newest
     * wins — both scoped to the session when one is given, so another session's
     * records are neither picked nor touched. A parseable record missing stamps
     * can only come from hand editing — it compares on `createdAt`, then
     * loses — so it can never pin the pick.
     */
    latestRunForCwd(cwd: unknown, sessionId?: string | null): Promise<RunRecord | LegacyRunRecord | null>;
    /**
     * One run's full record: in-memory when an executor holds it, else from
     * disk under `cwd` (loading/sweeping the workspace first, so a stale
     * running record is swept and a paused one resurrected before it is read).
     * A legacy v1 record is served read-only.
     */
    getRun(runId: unknown, cwd?: unknown): Promise<RunRecord | LegacyRunRecord | null>;
    /**
     * Subscribe to a run's transitions. Returns a disposer, or null when the
     * run has no live executor (a terminal record will never update again).
     */
    subscribe(runId: unknown, fn: (record: RunRecord) => void): (() => void) | null;
    /**
     * Route a control command to a run. `resume`/`rerun`/`steer` are accepted
     * only while the run is parked at a pause point; `abort` is accepted any
     * time the run is still active. `cwd` is the workspace hint that lets a
     * paused record surviving a profile restart be loaded (swept + resurrected)
     * before the command is routed — scoped to the target run's own session, so
     * the load never sweeps or resurrects another session's records.
     */
    control(runId: unknown, request: {
        action?: unknown;
        feedback?: unknown;
    }, cwd?: unknown): Promise<ControlOutcome>;
    /**
     * Lazy per-workspace load: sweep stale `running` records to `aborted`
     * (their executor died with the previous process), resurrect `paused`
     * records as controllable executors, and return the newest active record
     * (or null). In-memory executors always win over their disk copies. With a
     * session scope, records of OTHER sessions are invisible — skipped before
     * any sweep/resurrect, so their files are never touched — and only the
     * scope's records are swept, resurrected, or picked; a null/invalid key
     * keeps the unscoped legacy behavior.
     */
    private loadFromDisk;
    /**
     * First contact with an active record after a (re)load. v2 `running`
     * records are stale (their executor died with the previous process) and
     * sweep to `aborted` — in-flight firings aborted, completed outputs
     * preserved; v2 `paused` records resurrect as fully controllable
     * executors. Legacy v1 records are read-only: a stale `running` one sweeps
     * to `aborted` exactly as before; a `paused` one finalizes `aborted` with
     * an explanatory error — the v2 executor cannot drive the old shape, and a
     * paused run has nothing in flight, so its remaining cost is zero.
     */
    private sweepOrResurrect;
    /** Persist a swept record (best effort — a failed sweep is logged, not fatal). */
    private persistSwept;
}
export {};
//# sourceMappingURL=runs.d.ts.map