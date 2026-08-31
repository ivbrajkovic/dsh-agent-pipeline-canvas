// dsh-agent-pipeline-canvas — durable run registry (Host side).
//
// Replaces the old blocking `POST /run` with a durable execution model: a run
// is an executor fiber in the Host process whose whole state lives in a
// per-workspace record, `<cwd>/.agent-pipeline/runs/<runId>.json`, rewritten
// atomically on every transition (same protocol as pipeline.json — see
// storage.ts). The browser starts a run, then follows the record over SSE and
// issues control commands; the run — including a PAUSE — survives page reloads
// and profile restarts.
//
// Execution model (the firing kernel — see kernel.ts): the executor drives the
// pure stream kernel over the immutable snapshot instead of walking a
// topological order. A synthetic SOURCE emits the run input once to every
// wired root; each node fires whenever its input policy is satisfied — all-of
// ports need one unconsumed message per wired source (the fan-in rule: D fires
// once after both of B and C), any-of ports fire per arriving message — and
// every firing emits to its output ports, whose messages queue downstream.
// Emission is SELECTIVE (conditional-dispatch.md): a node's output bindings
// map a structured result field to a port (first match wins; no match — or no
// structured result — emits nowhere, the honest quiet), and a port bound is a
// delivery budget whose overflows are dropped and recorded. Firings run
// CONCURRENTLY as separate Harness children, capped by the run's
// `maxInFlight` (default 4); ready firings start in deterministic node-id
// order. FAIL-FAST (executor spec §2 — one rule, no continue-on-error): a
// firing that settles as anything but `completed` records its error + stop
// reason, closes the halt gate run-wide (nothing downstream of a failure
// starts anywhere), lets in-flight firings finish (drain — the same cost
// discipline as pause and abort), and finalizes the run `state: "error"` with
// all completed outputs preserved. The run otherwise ends at quiescence —
// nothing in flight, nothing fireable — with never-fired nodes reported. The
// record is the firing log (recordVersion
// 2; the per-node view the UI shows is projected from it by lib/projection.ts,
// never stored). A firing's composed prompt is written ONCE at start and is
// immutable for the run's lifetime; Rerun appends a NEW firing with the SAME
// verbatim input (a fresh child; the superseded firing stays in the log),
// never with steering content. Steering continues the same firing's child and
// updates its output in place.
//
// The executor decomposes into the spec's pieces (§6): the KERNEL (pure
// mechanics, kernel.ts), one NODE RUNNER task per firing (await inputs →
// compose → run one-shot or continuable epoch → emit → report terminal, with
// per-firing error attribution), the CONTROL PLANE — the pending-pause queue
// of settled-but-unresolved breakpoint firings whose head owns the control
// mailbox and the record's `pausedAt` pointer, rebuilt deterministically in
// firing-id order from the log so it survives a crash — and a COMMIT WRITER:
// every record mutation flows through one chained transition() so concurrent
// firings cannot interleave atomic writes.
//
//   - Non-breakpointed agents run through the historical one-shot path
//     (runOneAgent), parented to the user's session agent — unchanged.
//   - Breakpointed agents run as CONTINUABLE subagents (startContinuableAgent)
//     under a hidden `origin: "subagent"` PARENT ANCHOR that belongs to the
//     NODE (executor spec §5) — one anchor per continuable node, never shared
//     across branches, with `delegationDepth: 0`, so settlement notices never
//     reach the user's chat (the anchor is only live inside its own node's
//     control operations; notices to an absent parent are dropped) and
//     per-agent maxDepth caps keep their absolute semantics. The anchor handle
//     is disposed after every operation; its durable session id is persisted
//     in `nodes[nodeId].parentAnchorSessionId` before any child is created and
//     cold-resumed on demand (`agents.resume`) after a restart. Because
//     branches never touch each other's anchors there is no shared handle to
//     race, and a child cannot settle during its own admission, so a
//     settlement notice can never find a live parent (the wasted model call is
//     unreachable by construction). Records written before per-node anchors
//     carried one shared `coordinatorSessionId`; the first anchor a node needs
//     adopts that id and retires the field, so already-parented children keep
//     their durable address.
//
// Settlement is push-based: a single `subagent/end` listener is registered
// BEFORE any child starts/steers and settlements are matched by child id. A
// continuable epoch's `lastAssistantMessage` is epoch-relative (only the new
// answer), so it is adopted directly.
//
// Pause semantics (grouped — the control plane serves firings, and with
// concurrent branches a fan-out is one unit from the control surface's point
// of view): when a breakpointed firing settles, the HALT GATE closes — no new
// firing starts anywhere while in-flight firings run to completion (a paid
// turn is never cancelled to pause) — and the firing parks at the back of the
// pending-pause queue, awaiting a control command on an event-driven mailbox
// (no timers). The queue head owns the record's `pausedAt` pointer:
//
//   - resume  — mark the head done and release it: its output emits into the
//               kernel; when further parked firings remain, the head moves to
//               the next and the run stays paused.
//   - rerun   — a FRESH child (new childId; old transcript preserved) started
//               with the firing's verbatim input; after settle, back to parked.
//   - steer   — `subagents.followup` to the SAME child (cold-resume from its
//               persisted session — works after a restart); after settle, the
//               epoch output is adopted and the run stays parked. Repeatable.
//   - abort   — interrupt EVERY in-flight continuable child (the interrupt
//               target is a set under concurrency; authorized by the child's
//               node anchor's durable parentSession, so it works while the
//               anchor is disposed), cancel one-shots via the run signal,
//               drain every runner, and finalize `state: "aborted"` with
//               completed outputs preserved. No commit lands after
//               finalization.
//
// Durability: there is no boot scan. When a workspace's runs are first loaded
// (pipeline GET, run GET, SSE connect, or a new POST /run), a record found in
// `running` is stale — its executor died with the previous process — and is
// swept to `aborted` (in-flight firings aborted, outputs intact); a record
// found in `paused` is resurrected as a fully controllable executor: its whole
// pending-pause queue is rebuilt from the firing log (every settled-but-
// unresolved breakpoint firing, in firing-id order), so all parked branches —
// not just the crashed head — stay steerable across the restart, and a firing
// the crash caught IN FLIGHT re-fires on resume with its same composed input
// (exactly Rerun semantics — its old child died with the process). The
// executor re-enters the control wait without re-running anything else (nodes
// the log marks done never re-fire). One run is active (running|paused) per
// (workspace, session): enforced in-memory and re-checked on disk — two
// sessions in one workspace may run concurrently, and every discovery /
// sweep call is scoped to one session when asked (an absent key keeps the
// unscoped legacy behavior).
import { mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isValidSessionKey, writeAtomic } from "./storage.js";
import { validateGraph } from "./graph.js";
import { agentInput, agentPrompt, cmp, portGraph, renderValue } from "./execution.js";
import { projectNodes, unresolvedFirings } from "./projection.js";
import { Kernel, SOURCE_NODE_ID, normalizeMaxInFlight, } from "./kernel.js";
import { PROVIDER, continuableSupported, runOneAgent, startContinuableAgent, steerContinuableAgent, toText, } from "./runner.js";
const RUNS_DIR = ".agent-pipeline/runs";
/** Whether breakpointed agents can run as continuable (steerable) children. */
function continuableRuntime(services) {
    return continuableSupported(services) && services.sessionPersistence !== undefined;
}
/**
 * Matches `subagent/end` settlements to the child ids the executor waits on.
 * The listener is installed at construction — BEFORE any child is started or
 * steered — so a settlement can never slip past registration; events arriving
 * before their `wait()` call (the acceptance-to-wait window) are buffered and
 * matched then. One-shot children also emit the event; their ids never match a
 * continuable child id, and the unmatched buffer is kept whole (eviction could
 * drop a settlement its firing still needs).
 */
class EndWaiter {
    waiters = new Map();
    buffered = new Map();
    disposer;
    constructor(subscribe) {
        this.disposer = subscribe((info) => {
            const childId = info && typeof info.id === "string" ? info.id : "";
            if (childId.length === 0)
                return;
            const waiter = this.waiters.get(childId);
            if (waiter !== undefined) {
                this.waiters.delete(childId);
                waiter(info);
                return;
            }
            // Not (yet) waited on — keep it for a later wait(). Uncapped on
            // purpose: entries are tiny and bounded by the run's settlement
            // count, and evicting the oldest could drop a settlement that its
            // firing is still about to wait on (a lost epoch would stall the
            // run — abort would be the only recovery).
            this.buffered.set(childId, info);
        });
    }
    /** Resolve with the settlement for `childId`, or null when the signal aborts first. */
    wait(childId, signal) {
        const buffered = this.buffered.get(childId);
        if (buffered !== undefined) {
            this.buffered.delete(childId);
            return Promise.resolve(buffered);
        }
        return new Promise((resolve) => {
            const onAbort = () => {
                // Only when this child is still genuinely waited on: a settled
                // (consumed) waiter must not resolve a second time.
                if (this.waiters.delete(childId))
                    resolve(null);
            };
            this.waiters.set(childId, (info) => {
                signal.removeEventListener("abort", onAbort);
                resolve(info);
            });
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener("abort", onAbort);
        });
    }
    dispose() {
        this.disposer();
    }
}
/** The record file path for a run under its workspace root. */
function recordPath(cwd, runId) {
    return join(cwd, RUNS_DIR, runId + ".json");
}
/**
 * The session a discovery/load/sweep call filters by: a VALID session key
 * (storage.ts's charset rule) scopes the call to exactly that session's
 * records; anything else — absent, empty, or invalid (the routes already
 * answer 400 for an invalid key) — keeps the unscoped legacy behavior. Every
 * record startRun writes carries its `sessionId`, so scoping is a filter,
 * never a migration; a record with a MISSING `sessionId` (only possible from
 * hand editing) is invisible to scoped queries and stays visible through the
 * unscoped path alone.
 */
function sessionScope(sessionId) {
    return isValidSessionKey(sessionId) ? sessionId : null;
}
/** True when the parsed record is the v2 firing-log shape (legacy v1 otherwise). */
function isV2Record(rec) {
    return rec.recordVersion === 2;
}
/**
 * The fail-fast classification (executor spec §2): only a `completed`
 * settlement proceeds; `error`, `refusal`, `max-tokens`, `aborted`, or any
 * provider-added reason fails the run. The harness mirrors this exactly in
 * its own settlement mapping, and a non-`completed` output may be partial.
 */
function settledIncomplete(stopReason) {
    return stopReason !== "completed";
}
/**
 * The fail-fast error detail recorded on a firing whose settlement stopped
 * short of `completed`. The stop reason is the message's spine; a provider's
 * diagnostic (one-shot results carry one, continuable settlements do not)
 * rides along.
 */
function failFastError(stopReason, diagnostic) {
    const reason = typeof stopReason === "string" && stopReason.length > 0 ? stopReason : "unknown";
    const detail = typeof diagnostic === "string" && diagnostic.trim().length > 0 ? ": " + diagnostic.trim() : "";
    return `the firing settled as "${reason}" — failing the run (fail-fast)${detail}`;
}
/**
 * Parse one record file, or null when missing/corrupt (a bad file is skipped,
 * not fatal). Accepts BOTH record versions: v2 (the firing log) and legacy v1
 * (read-only — swept or finalized, never resurrected or run).
 */
async function readRecordFile(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return null;
        const rec = parsed;
        if (typeof rec.runId !== "string" || typeof rec.cwd !== "string" || typeof rec.state !== "string")
            return null;
        if (rec.recordVersion === 2) {
            if (!Array.isArray(rec.firings))
                return null;
            return rec;
        }
        // Legacy v1: the walk order + per-node status slots.
        const legacy = parsed;
        if (legacy.order === null || typeof legacy.order !== "object")
            return null;
        return legacy;
    }
    catch {
        return null;
    }
}
/**
 * One run's executor fiber: drives the firing kernel (kernel.ts), mutates the
 * record through the chained commit writer, persists every transition, and
 * awaits control commands while parked at a breakpoint. The fiber finishes
 * when the run reaches a terminal state (completed / aborted / error).
 */
class RunExecutor {
    /** The durable record — mutated in place; every transition is committed. */
    record;
    services;
    canContinuable;
    controller = new AbortController();
    signal;
    endWaiter;
    /** The constructor-captured session agent; `resolveSessionAgent()` may
     * refresh this when the registry's live agent differs (post-restart). */
    sessionAgent;
    onSettle;
    controlWaiter = null;
    listeners = new Set();
    /** Live parent-anchor handles by node id — each held ONLY inside its own
     * node's admission (the withAnchor bracket), disposed after. */
    anchorHandles = new Map();
    /**
     * Per-node admission serialization: admissions of the SAME node queue on
     * this chain so each holds the anchor alone (created → admitted → disposed
     * before the next begins), while different nodes admit fully concurrently —
     * branches never touch each other's anchors, so there is no shared handle
     * to race. Unreachable today (a parked breakpoint closes the halt gate
     * before its node could re-fire), but a cyclic graph could re-feed a node
     * while its firing is in flight, so same-node admissions stay safe anyway.
     */
    anchorChain = new Map();
    /** The continuable children that may have a turn in flight, keyed to their
     * node (the abort interrupt authorizes against the NODE's anchor id). */
    inFlightChildren = new Map();
    /** The kernel — created at the top of run(); notify() wakes its main loop. */
    kernel = null;
    /**
     * The commit writer's chain: every record mutation queues through
     * transition(), so concurrent firings can never interleave their atomic
     * writes (two free-running commits could race a stale snapshot into the
     * file). Mutators are synchronous by contract.
     */
    writeChain = Promise.resolve();
    /** The parked-breakpoint FIFO (settle order); the head owns the mailbox. */
    pauseQueue = [];
    /** Live NodeRunner tasks; finalization drains them before its own writes. */
    runners = new Set();
    /**
     * The fail-fast latch (executor spec §2): set once by the first firing
     * that settled non-completed. The dispatch loop treats it exactly like the
     * abort signal (no new firing starts), the parked control loops unwind on
     * it, and the main loop finalizes `error` once everything drained.
     */
    failed = false;
    constructor(services, record, options = {}) {
        this.services = services;
        this.record = record;
        this.canContinuable = continuableRuntime(services);
        this.signal = this.controller.signal;
        this.endWaiter = new EndWaiter(services.subscribeRunEnd);
        this.sessionAgent = options.sessionAgent !== undefined && options.sessionAgent !== null && typeof options.sessionAgent.id === "string"
            ? options.sessionAgent
            : undefined;
        this.onSettle = options.onSettle;
        // The interrupt-on-abort wiring: every live continuable turn is stopped
        // via the harness interrupt, authorized by the child's durable
        // parentSession (its NODE's anchor id — persisted before any child
        // starts), so the anchor agent itself need not be live. A parked control
        // wait is woken so the loop can finalize, and the kernel's main loop is
        // woken off its sleep.
        this.signal.addEventListener("abort", () => {
            const interrupt = this.services.subagents.interrupt;
            if (typeof interrupt === "function") {
                for (const [childId, nodeId] of [...this.inFlightChildren]) {
                    const anchorId = this.record.nodes[nodeId]?.parentAnchorSessionId;
                    if (anchorId === undefined) {
                        this.services.logger.warn(`agent-pipeline: cannot interrupt child "${childId}" — node "${nodeId}" has no parent anchor id`);
                        continue;
                    }
                    try {
                        interrupt.call(this.services.subagents, childId, { kind: "user", parentSessionId: anchorId });
                    }
                    catch (error) {
                        this.services.logger.warn(`agent-pipeline: interrupting child "${childId}" failed: ${String(error)}`);
                    }
                }
            }
            this.postControl({ action: "abort" });
            this.kernel?.notify();
        });
        void this.run(options.resume === true).catch(() => { });
    }
    // ---- Control surface (called by the registry on behalf of routes) ----
    /** Whether the executor is parked at a pause point waiting for a command. */
    get awaitingControl() {
        return this.controlWaiter !== null;
    }
    /** Whether a steer command can currently be accepted for the paused firing. */
    canSteer() {
        if (!this.canContinuable)
            return false;
        const firing = this.pausedFiring();
        return firing !== null && typeof firing.childSessionId === "string" && firing.childSessionId.length > 0;
    }
    /** Deposit a command into the mailbox; false when the executor is not waiting. */
    postControl(cmd) {
        if (this.controlWaiter === null)
            return false;
        const resolve = this.controlWaiter;
        this.controlWaiter = null;
        resolve(cmd);
        return true;
    }
    /** Request abort from outside (control route): interrupt in-flight work and wake the loop. */
    abort() {
        this.controller.abort();
    }
    /**
     * Fail-fast (executor spec §2): one firing settled as anything but
     * `completed`. Closes the halt gate run-wide — nothing downstream of the
     * failure starts anywhere — and wakes the loop, which finalizes `error`
     * once the in-flight firings drain (paid turns settle and record; the same
     * cost discipline as pause and abort). Idempotent: the first failure owns
     * the run's outcome; later failures only record on their own firings.
     */
    failRun() {
        if (this.failed)
            return;
        this.failed = true;
        this.kernel?.setHalted(true);
        // Wake an ARMED parked head so the drain cannot hang on its control
        // wait; entries behind it (and a head whose mailbox is disarmed mid-
        // rerun) unwind because drivePauseEntry re-checks `failed` each turn.
        this.postControl({ action: "abort" });
        // A park whose mailbox is about to disarm must not leave the record
        // claiming `paused` for the whole drain (observing paused ⇒ armed
        // mailbox): flip the state back so the run reads as executing — the
        // banner shows the failure — and finalize sweeps the parked firings.
        if (this.record.state === "paused") {
            void this.transition(() => {
                if (this.record.state === "paused") {
                    this.record.state = "running";
                    delete this.record.pausedAt;
                }
            });
        }
        this.kernel?.notify();
    }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }
    pausedFiring() {
        const firingId = this.record.pausedAt;
        if (firingId === undefined)
            return null;
        return this.record.firings.find((f) => f.firingId === firingId) ?? null;
    }
    // ---- The commit writer ---------------------------------------------------
    /**
     * Every record mutation flows through one chained transition (executor
     * spec §6): the synchronous mutation runs inside the chain and the
     * persist+notify rides the SAME chain — concurrent firings queue behind
     * each other instead of interleaving atomic renames. Mutators must be
     * synchronous so no other mutation can run between their read and write.
     */
    transition(mutate) {
        const applied = this.writeChain.then(mutate);
        this.writeChain = applied.then(() => this.commit(), () => this.commit());
        return applied;
    }
    /**
     * Apply a record mutation through the writer WITHOUT committing it: the
     * mutation is serialized by the chain and reaches disk with the next
     * committing transition. Control operations on the parked head use this —
     * a commit would publish the still-paused record while the mailbox is
     * disarmed, and a client that observes paused must always find the mailbox
     * armed or its command is rejected (the park invariant).
     */
    transitionQuiet(mutate) {
        const applied = this.writeChain.then(mutate);
        this.writeChain = applied.then(() => undefined, () => undefined);
        return applied;
    }
    /** Persist the record and notify subscribers. Call only inside the chain. */
    async commit() {
        this.record.updatedAt = new Date().toISOString();
        try {
            await mkdir(join(this.record.cwd, RUNS_DIR), { recursive: true });
            await writeAtomic(recordPath(this.record.cwd, this.record.runId), `${JSON.stringify(this.record, null, 2)}\n`);
        }
        catch (error) {
            this.services.logger.warn(`agent-pipeline: persisting run "${this.record.runId}" failed: ${String(error)}`);
        }
        for (const listener of this.listeners) {
            try {
                listener(this.record);
            }
            catch { /* a broken subscriber must not affect the run */ }
        }
    }
    /** Append bound-overflow records (design principle 4) through the writer. */
    async recordDrops(drops) {
        if (drops.length === 0)
            return;
        await this.transition(() => {
            const dropped = this.record.dropped ?? [];
            dropped.push(...drops);
            this.record.dropped = dropped;
        });
    }
    // ---- Firing bookkeeping --------------------------------------------------
    /**
     * Resolve the live parent for one-shot starts at USE time, not just at
     * executor construction: after a profile restart the executor may be
     * resurrected before the harness has resumed the session's agent, and a
     * parent captured then would be undefined (or stale) for every later
     * one-shot start. The registry lookup wins; the constructor-captured
     * object is only a fallback.
     */
    resolveSessionAgent() {
        const live = this.services.agents.get(this.record.sessionId);
        if (live !== undefined && live !== null && typeof live.id === "string") {
            this.sessionAgent = live;
            return this.sessionAgent;
        }
        return this.sessionAgent;
    }
    // ---- Per-node parent-anchor lifecycle (executor spec §5) ------------------
    /**
     * Mirror the session agent's options onto the anchor, minus the runtime
     * delegation-depth option: the anchor's durable header stamps
     * `delegationDepth: 0`, and a stale runtime `subagentDepth` would override
     * it and silently shift every pipeline child one level deeper.
     */
    anchorOptions() {
        const src = this.sessionAgent && typeof this.sessionAgent.options === "object" && this.sessionAgent.options !== null
            ? this.sessionAgent.options
            : {};
        const out = { ...src };
        delete out.subagentDepth;
        return Object.keys(out).length > 0 ? out : undefined;
    }
    /**
     * Run one admission for `nodeId`'s anchor — starting a child or steering
     * one — holding the anchor LIVE only for the duration of `admit` and
     * disposing it right after, so the harness's settlement notice (which
     * would otherwise wake the parent with a real model turn) finds no live
     * parent. Admissions of the same node serialize on the per-node chain;
     * different nodes never touch each other's anchors.
     */
    async withAnchor(nodeId, admit) {
        const prior = this.anchorChain.get(nodeId) ?? Promise.resolve();
        let open = () => { };
        const gate = new Promise((resolve) => { open = resolve; });
        this.anchorChain.set(nodeId, prior.then(() => gate));
        await prior;
        try {
            const anchor = await this.ensureAnchor(nodeId);
            try {
                return await admit(anchor);
            }
            finally {
                await this.releaseAnchor(nodeId);
            }
        }
        finally {
            open();
        }
    }
    /**
     * Return node `nodeId`'s parent anchor, creating or cold-resuming it on
     * demand. The anchor is a durable parent ADDRESS (authorization for
     * `interrupt`, the header for cold-resume), never a worker: its session id
     * is persisted into `nodes[nodeId]` before any child is created on it, so a
     * later interrupt — and a post-restart steer — can authorize against it
     * while the handle is disposed.
     */
    async ensureAnchor(nodeId) {
        // Fast path: the id, once set, is never unset, and same-node admissions
        // are serialized by withAnchor — so a synchronous read cannot race a
        // transition, and an already-anchored node's admission commits nothing.
        const settled = this.record.nodes[nodeId]?.parentAnchorSessionId;
        if (settled !== undefined)
            return this.liveOrResumedAnchor(nodeId, settled);
        // Adopt-or-create runs INSIDE the write chain, so two nodes can never
        // both claim a pre-P4 record's one shared coordinator id: the first
        // adoption deletes the field atomically with its seed; the second sees
        // neither and creates a fresh anchor of its own.
        const persisted = await this.transition(() => {
            const existing = this.record.nodes[nodeId]?.parentAnchorSessionId;
            if (existing !== undefined)
                return existing;
            // A record written before per-node anchors carried ONE shared
            // coordinator id for all continuable nodes. Adopt it as this node's
            // anchor — it is the durable address the node's already-parented
            // children authorize against — and retire the shared field.
            const legacy = this.record.coordinatorSessionId;
            if (typeof legacy === "string" && legacy.length > 0) {
                this.record.nodes[nodeId] = { parentAnchorSessionId: legacy };
                delete this.record.coordinatorSessionId;
                return legacy;
            }
            return undefined;
        });
        if (persisted !== undefined)
            return this.liveOrResumedAnchor(nodeId, persisted);
        if (this.sessionAgent === undefined) {
            throw new Error("the node's parent anchor cannot be created because the session agent is not live");
        }
        const sessionId = randomUUID();
        const handle = await this.services.agents.create({
            sessionId,
            meta: {
                cwd: this.record.cwd,
                parentSession: this.sessionAgent.id,
                origin: "subagent",
                // Depth 0: pipeline children stay at depth 1, so per-agent
                // maxDepth caps keep their absolute semantics.
                delegationDepth: 0,
            },
            seed: [],
            agentOptions: this.anchorOptions(),
            signal: this.signal,
        });
        this.anchorHandles.set(nodeId, handle);
        await this.transition(() => { this.record.nodes[nodeId] = { parentAnchorSessionId: sessionId }; });
        return handle.agent;
    }
    /**
     * The anchor's live agent, or a cold resume of its persisted session. A
     * RESIDENT anchor (live without our retained handle — someone else, say the
     * user's GUI, made it live) is admitted through but never disposed: we only
     * ever dispose handles WE created or resumed.
     */
    async liveOrResumedAnchor(nodeId, anchorId) {
        const live = this.services.agents.get(anchorId);
        if (live !== undefined && live !== null && typeof live.id === "string") {
            return live;
        }
        const handle = await this.services.agents.resume({
            resumeSessionId: anchorId,
            agentOptions: this.anchorOptions(),
            signal: this.signal,
        });
        this.anchorHandles.set(nodeId, handle);
        return handle.agent;
    }
    /** Dispose the node's retained anchor handle (the session itself persists). */
    async releaseAnchor(nodeId) {
        const handle = this.anchorHandles.get(nodeId);
        if (handle === undefined)
            return;
        this.anchorHandles.delete(nodeId);
        try {
            await handle.dispose();
        }
        catch (error) {
            this.services.logger.warn(`agent-pipeline: disposing node "${nodeId}"'s parent anchor failed: ${String(error)}`);
        }
    }
    /** Dispose every retained anchor handle (finalization's last touch). */
    async releaseAllAnchors() {
        for (const nodeId of [...this.anchorHandles.keys()]) {
            await this.releaseAnchor(nodeId);
        }
    }
    // ---- Per-firing primitives -------------------------------------------------
    /** The next stable firing id: start-ordered, zero-padded ("f-001"…). */
    nextFiringId() {
        return "f-" + String(this.record.firings.length + 1).padStart(3, "0");
    }
    /**
     * Open a firing for `nodeId` and append it to the log: the node's first
     * firing (`previous === null`, seq 1) or a re-firing superseding
     * `previous` (Rerun — one past its seq, same verbatim input). Call inside
     * a transition so concurrent starts cannot interleave id assignment.
     */
    openFiring(nodeId, previous, input) {
        const firing = {
            firingId: this.nextFiringId(),
            nodeId,
            seq: previous !== null ? previous.seq + 1 : 1,
            status: "running",
            input,
            startedAt: new Date().toISOString(),
        };
        this.record.firings.push(firing);
        return firing;
    }
    /**
     * Adopt a settled continuable epoch into its firing: the epoch's
     * `lastAssistantMessage` is epoch-relative (only the new answer), so it is
     * adopted directly. A successful adoption clears a prior steering error.
     */
    adoptEpoch(firing, end) {
        delete firing.error;
        firing.output = toText(end.lastAssistantMessage);
        firing.stopReason = end.stopReason;
        firing.settledAt = new Date().toISOString();
    }
    /**
     * Run one continuable epoch for `firing`: admit it under the NODE's parent
     * anchor (held live only for the admission), start a FRESH child with the
     * firing's verbatim prompt, and await the child's first settlement.
     * Returns the end info, or null when the run was aborted mid-flight.
     */
    async runContinuableEpoch(firing, agent, agentById, prompt) {
        let childId = "";
        try {
            ({ childId } = await this.withAnchor(firing.nodeId, (anchor) => startContinuableAgent(this.services, {
                agent,
                agentById,
                prompt,
                parent: anchor,
                signal: this.signal,
            })));
        }
        catch (error) {
            if (this.signal.aborted)
                return null;
            throw error;
        }
        this.inFlightChildren.set(childId, firing.nodeId);
        try {
            await this.transition(() => { firing.childSessionId = childId; });
            const end = await this.endWaiter.wait(childId, this.signal);
            return this.signal.aborted ? null : end;
        }
        finally {
            this.inFlightChildren.delete(childId);
        }
    }
    /**
     * Steer the firing's SAME child with user feedback (cold-resuming it from
     * its persisted session when it is not resident — this works across
     * profile restarts); the steering epoch's (epoch-relative) output is
     * adopted into the firing. The adoption is a QUIET mutation: it commits
     * with the park's next transition (steering runs while the park's mailbox
     * is disarmed — see transitionQuiet). Throws on failure.
     */
    async steerNode(firing, feedback) {
        const childId = firing.childSessionId;
        await this.withAnchor(firing.nodeId, (anchor) => steerContinuableAgent(this.services, {
            parent: anchor,
            childId,
            feedback,
            signal: this.signal,
        }));
        this.inFlightChildren.set(childId, firing.nodeId);
        try {
            const end = await this.endWaiter.wait(childId, this.signal);
            if (this.signal.aborted)
                return;
            if (end !== null) {
                await this.transitionQuiet(() => {
                    firing.output = toText(end.lastAssistantMessage);
                    firing.stopReason = end.stopReason;
                });
            }
        }
        finally {
            this.inFlightChildren.delete(childId);
        }
    }
    /**
     * The typed failure when the session agent is not live: no one-shot can
     * start, so the firing fails and — P6 — the run fails with it.
     */
    async recordSessionAgentGone(firing) {
        await this.transition(() => {
            firing.status = "error";
            firing.error = "the session agent is not live — reopen the conversation and start a new run";
            firing.settledAt = new Date().toISOString();
        });
        this.failRun();
    }
    /**
     * The shared ONE-SHOT settle commit (the NodeRunner's firing and the
     * resurrect path's re-fire classify identically — P6): adopt the outcome
     * in one commit, marking the firing `done` only when it settled
     * `completed`. A thrown error, or a settled stop reason short of
     * `completed`, leaves the firing `error` with the failure detail — the
     * partial output and the transcript address stay in the log. Returns true
     * when the firing FAILED the run.
     */
    async settleOneShotFiring(firing, outcome) {
        const failed = outcome.error !== undefined || settledIncomplete(outcome.stopReason);
        await this.transition(() => {
            firing.settledAt = new Date().toISOString();
            if (outcome.error) {
                firing.status = "error";
                firing.error = outcome.error;
                firing.stopReason = outcome.stopReason;
            }
            else {
                firing.output = outcome.output;
                firing.stopReason = outcome.stopReason;
                if (outcome.childSessionId !== undefined)
                    firing.childSessionId = outcome.childSessionId;
                if (failed) {
                    firing.status = "error";
                    firing.error = failFastError(outcome.stopReason, outcome.diagnostic);
                }
                else {
                    firing.status = "done";
                    delete firing.error;
                }
            }
        });
        return failed;
    }
    /**
     * Re-fire an orphaned PLAIN (non-breakpoint) firing with a fresh one-shot
     * child running the orphan's verbatim composed input (Rerun semantics —
     * executor spec §3). The record keeps its paused state while the re-fire
     * runs: parked heads' mailboxes stay armed and their commands valid, so
     * there is deliberately no `state` flip (unlike a head Rerun, which
     * disarms THE mailbox and must therefore flip the state). Returns the
     * adopted firing with its structured result (selective emission evaluates
     * bindings against it), or null when nothing was produced to emit.
     */
    async refirePlain(orphan, agent, agentById, inputs) {
        const fresh = await this.transition(() => this.openFiring(orphan.nodeId, orphan, orphan.input));
        if (this.signal.aborted)
            return null;
        const parent = this.resolveSessionAgent();
        if (parent === undefined) {
            await this.recordSessionAgentGone(fresh);
            return null;
        }
        const outcome = await runOneAgent(this.services, { agent, agentById, inputs, parent, signal: this.signal });
        if (this.signal.aborted)
            return null;
        // The re-fire is a firing like any other: fail-fast classifies it the
        // same way (P6) — a non-completed re-fire fails the run and unwinds
        // the parked heads it was re-fired behind.
        const failed = await this.settleOneShotFiring(fresh, outcome);
        if (failed)
            this.failRun();
        return failed ? null : { firing: fresh, structured: outcome.structured };
    }
    // ---- The control plane's pending-pause queue -------------------------------
    /**
     * The settled-but-unresolved breakpoint firings, rebuilt from the LOG
     * (crash-safe): every firing parked with status "paused" that no later
     * firing of the same node supersedes (a Rerun's superseded firing stays
     * parked as decision history and is never re-queued), in FIRING-ID order.
     * The deterministic order is what makes the rebuild crash-safe: the stale
     * record's `pausedAt` pointer is not consulted — the log is the truth, and
     * the head's first control transition re-points `pausedAt` at the rebuilt
     * head. Shared derivation with the projection (unresolvedFirings), so the
     * displayed queue depth and the rebuilt head can never drift.
     */
    rebuiltPauseQueue() {
        return unresolvedFirings(this.record.firings, "paused");
    }
    /**
     * The firings that were IN FLIGHT when the process died: status "running",
     * not superseded, in firing-id order. A resumed run re-fires each with its
     * same composed input — exactly Rerun semantics (executor spec §3) —
     * because the old child died with the process and no settlement can ever
     * arrive for it.
     */
    orphanedInFlight() {
        return unresolvedFirings(this.record.firings, "running");
    }
    /**
     * Park a settled breakpointed firing: push it at the back of the pending-
     * pause queue, close the halt gate (grouped pause — nothing new starts
     * anywhere while parked firings remain), and — for a JUST-settled firing,
     * not a resurrected one — park it in the LOG immediately, so a queued-but-
     * unresolved breakpoint is never mistaken for work in flight and a crash
     * leaves an expressive log for the queue rebuild. This commits while
     * `state` is still "running", so the park invariant (observing paused ⇒
     * armed mailbox) is untouched.
     */
    async parkFiring(firing, agent, agentById, inputs, options = {}) {
        let openTurn = () => { };
        const turn = new Promise((resolve) => { openTurn = resolve; });
        const entry = { firing, agent, agentById, inputs, turn, openTurn };
        this.pauseQueue.push(entry);
        this.kernel?.setHalted(true);
        if (options.alreadyParked !== true) {
            await this.transition(() => { firing.status = "paused"; });
        }
        return entry;
    }
    /**
     * Drive one parked entry's control loop until the run moves past it
     * (returns the released firing — Rerun may have replaced it) or the run
     * aborts (returns null). Only the queue HEAD arms the mailbox; entries
     * behind it wait for their turn. Releasing the head surfaces the next and
     * keeps the run parked; releasing the last one opens the halt gate. The
     * caller emits the released firing's output into the kernel.
     */
    async drivePauseEntry(entry) {
        try {
            while (true) {
                if (this.pauseQueue[0] !== entry) {
                    await entry.turn;
                    continue;
                }
                if (this.signal.aborted || this.failed) {
                    // Abort finalizes `aborted`; fail-fast unwinds the park so
                    // the drain cannot hang on a control wait that will never
                    // be answered — finalize sweeps the parked firing aborted.
                    this.retireEntry(entry);
                    return null;
                }
                const current = entry.firing;
                // Arm the mailbox BEFORE the paused state becomes visible (the
                // transition persists + publishes it): a client that observes the
                // record as paused can never hit a window where its command is
                // rejected.
                const cmdPromise = new Promise((resolve) => { this.controlWaiter = resolve; });
                await this.transition(() => {
                    current.status = "paused";
                    this.record.state = "paused";
                    this.record.pausedAt = current.firingId;
                });
                const cmd = await cmdPromise;
                if (cmd.action === "abort") {
                    this.retireEntry(entry);
                    return null;
                }
                if (cmd.action === "resume") {
                    await this.transition(() => {
                        current.status = "done";
                        current.settledAt = new Date().toISOString();
                    });
                    const next = this.retireEntry(entry);
                    await this.transition(() => {
                        if (next !== undefined) {
                            // The next parked breakpoint surfaces: the run stays paused.
                            this.record.pausedAt = next.firing.firingId;
                        }
                        else {
                            this.record.state = "running";
                            delete this.record.pausedAt;
                        }
                    });
                    return current;
                }
                if (cmd.action === "rerun") {
                    await this.rerunPaused(entry);
                    continue; // back to parked — the user decides again
                }
                if (cmd.action === "steer") {
                    await this.steerPaused(entry, cmd.feedback);
                    continue; // still parked with the adopted output
                }
            }
        }
        catch (error) {
            // The park itself failed: retire the entry so the halt gate can
            // never stay closed on its account, then rethrow — the NodeRunner
            // attributes the failure to the firing.
            this.retireEntry(entry);
            throw error;
        }
    }
    /**
     * Park a just-settled breakpointed firing and drive its control loop (the
     * NodeRunner path). Grouped pause: the halt gate closes when the first
     * breakpoint parks and opens when the last one releases, so in-flight
     * firings finish while nothing new starts anywhere. Concurrent settlements
     * queue; the head owns the mailbox and `pausedAt`.
     */
    async pauseAt(firing, agent, agentById, inputs) {
        const entry = await this.parkFiring(firing, agent, agentById, inputs);
        return this.drivePauseEntry(entry);
    }
    /**
     * Remove a parked entry from the queue. Returns the entry that becomes the
     * head next (whose turn this resolves); when none remains, the halt gate
     * opens. The caller moves `pausedAt`/`state` in its own transition.
     */
    retireEntry(entry) {
        const index = this.pauseQueue.indexOf(entry);
        if (index !== -1)
            this.pauseQueue.splice(index, 1);
        const next = this.pauseQueue[0];
        if (next !== undefined)
            next.openTurn();
        else
            this.kernel?.setHalted(false);
        // The queue's depth gates the main loop's quiescence check — wake it so
        // a release that emits nothing (or an abort drain) still re-evaluates.
        this.kernel?.notify();
        return next;
    }
    /**
     * Rerun the head firing: a FRESH child (new child id; the superseded
     * firing stays in the log with its parked output preserved) started with
     * the verbatim original input — never steering content. After the fresh
     * epoch settles (or fails), the entry parks again on the new firing.
     *
     * The control plane deliberately does NOT fail-fast on the fresh epoch's
     * stop reason: the user is at the decision point with the halt gate
     * closed, so a non-completed rerun re-parks for another decision (retry /
     * steer / abort) — a THROWN rerun records its error, a settled-but-not-
     * completed one carries only its stop reason. P6's one rule is the NODE
     * RUNNER's classification; the unattended re-fire (refirePlain)
     * classifies, this attended one does not.
     */
    async rerunPaused(entry) {
        const current = entry.firing;
        const nodeId = current.nodeId;
        let rerunFiring = null;
        try {
            if (this.canContinuable) {
                // Flip the record out of "paused" while the fresh epoch is in
                // flight ONLY when the rerunning entry IS the queue head: the
                // head's mailbox is disarmed during the epoch, so the record
                // must not claim paused (the park invariant). A re-fired crash-
                // orphan reruns BEHIND parked heads whose mailboxes stay armed
                // and whose commands must keep working — the state stays.
                const isHead = this.pauseQueue[0] === entry;
                rerunFiring = await this.transition(() => {
                    const firing = this.openFiring(nodeId, current, current.input);
                    if (isHead)
                        this.record.state = "running";
                    return firing;
                });
                entry.firing = rerunFiring;
                this.kernel?.beginFiring(nodeId);
                try {
                    const end = await this.runContinuableEpoch(rerunFiring, entry.agent, entry.agentById, rerunFiring.input);
                    if (end === null)
                        return; // aborted; finalization owns the record
                    await this.transitionQuiet(() => { this.adoptEpoch(rerunFiring, end); });
                }
                finally {
                    this.kernel?.endFiring(nodeId);
                }
                return;
            }
            // Degraded deployment: rerun as a fresh one-shot child. The keyed
            // inputs recompose deterministically to the firing's recorded input
            // verbatim. Without a live parent the SAME firing re-parks with the
            // error (nothing new started).
            const parent = this.resolveSessionAgent();
            if (parent === undefined) {
                await this.transitionQuiet(() => {
                    current.status = "paused";
                    current.error = "the session agent is not live — reopen the conversation, then rerun";
                });
                this.services.logger.warn(`agent-pipeline: rerun of agent "${nodeId}" has no live session agent`);
                return;
            }
            rerunFiring = await this.transition(() => {
                const firing = this.openFiring(nodeId, current, current.input);
                if (this.pauseQueue[0] === entry)
                    this.record.state = "running";
                return firing;
            });
            entry.firing = rerunFiring;
            this.kernel?.beginFiring(nodeId);
            try {
                const outcome = await runOneAgent(this.services, {
                    agent: entry.agent,
                    agentById: entry.agentById,
                    inputs: entry.inputs,
                    parent,
                    signal: this.signal,
                });
                if (this.signal.aborted)
                    return;
                await this.transitionQuiet(() => {
                    const firing = rerunFiring;
                    firing.settledAt = new Date().toISOString();
                    if (outcome.error) {
                        firing.error = outcome.error;
                        firing.stopReason = outcome.stopReason;
                    }
                    else {
                        delete firing.error;
                        firing.output = outcome.output;
                        firing.stopReason = outcome.stopReason;
                        if (outcome.childSessionId !== undefined)
                            firing.childSessionId = outcome.childSessionId;
                    }
                });
            }
            finally {
                this.kernel?.endFiring(nodeId);
            }
        }
        catch (error) {
            if (this.signal.aborted)
                return;
            if (rerunFiring !== null) {
                await this.transitionQuiet(() => {
                    const firing = rerunFiring;
                    firing.status = "paused";
                    firing.error = String(error);
                });
            }
            this.services.logger.warn(`agent-pipeline: rerun of agent "${nodeId}" failed: ${String(error)}`);
        }
    }
    /**
     * Steer the parked firing's SAME child with user feedback; the steering
     * epoch's (epoch-relative) output is adopted into the firing. The record
     * mutations here are QUIET — nothing commits until the park re-arms the
     * mailbox, so no client can observe a paused record it cannot act on. The
     * run stays parked; a failure keeps it parked with the error so the user
     * can retry or act again.
     */
    async steerPaused(entry, feedback) {
        const current = entry.firing;
        try {
            await this.steerNode(current, feedback);
            await this.transitionQuiet(() => { delete current.error; });
        }
        catch (error) {
            if (this.signal.aborted)
                return;
            await this.transitionQuiet(() => { current.error = String(error); });
            this.services.logger.warn(`agent-pipeline: steering agent "${current.nodeId}" failed: ${String(error)}`);
        }
    }
    // ---- The NodeRunner and the kernel driver ----------------------------------
    /**
     * Emit a terminal firing's output into the kernel — SELECTIVE emission
     * (conditional-dispatch §2): the kernel picks the ports (every declared
     * port without bindings; the first matched binding's port with bindings;
     * none when nothing matched), and the firing's `emittedTo` records the
     * selection. `structured` is the one-shot child's structured result, when
     * one came back — the only thing bindings evaluate against (a continuable
     * firing has none, so a bound breakpointed node always emits quietly).
     * Only reached for `completed` firings: a failed firing returns before
     * this point (P6 — nothing downstream of a failure runs), and a firing
     * without an output emits nothing — downstream starves and is reported at
     * quiescence.
     */
    async emitOutput(nodeId, firing, structured) {
        if (typeof firing.output !== "string")
            return;
        const emission = this.kernel !== null
            ? this.kernel.emit(nodeId, firing.output, structured)
            : { ports: [], drops: [] };
        await this.transition(() => { firing.emittedTo = emission.ports; });
        await this.recordDrops(emission.drops);
    }
    /**
     * The NODE RUNNER (executor spec §6): one async task per firing — compose
     * the input from the firing's consumed messages (the unchanged
     * agentInput/agentPrompt contract, so a fan-in composes the same `## Beta`
     * / `## Gamma` sections as the sequential walk did), open the firing in
     * the log, run one continuable epoch or one-shot child, adopt the
     * settlement, park at breakpoints, then emit the output. Failures attribute
     * to THIS firing and are recorded.
     */
    async runFiring(nodeId, messages, agentById) {
        const agent = agentById.get(nodeId);
        if (agent === undefined)
            return; // unreachable: the kernel only knows graph agents
        const upstream = [...new Set(messages.map((message) => message.from))].sort(cmp);
        const upstreamOutputs = {};
        for (const message of messages)
            upstreamOutputs[message.from] = message.output;
        const inputs = agentInput(nodeId, { upstream, upstreamOutputs, pipelineInput: this.record.input });
        const prompt = agentPrompt(agent, inputs, agentById);
        let firing;
        try {
            firing = await this.transition(() => {
                // seq is per-node: a node that re-fires from the stream (a
                // cycle, or any-of fed twice) continues its firing number the
                // same way a Rerun does.
                const log = this.record.firings;
                let previous = null;
                for (let i = log.length - 1; i >= 0; i--) {
                    if (log[i].nodeId === nodeId) {
                        previous = log[i];
                        break;
                    }
                }
                return this.openFiring(nodeId, previous, prompt);
            });
        }
        catch (error) {
            this.services.logger.warn(`agent-pipeline: opening a firing for "${nodeId}" failed: ${String(error)}`);
            return;
        }
        try {
            const useContinuable = this.canContinuable && agent.breakpoint === true;
            // The structured result bindings evaluate against: a one-shot child
            // with an outputSchema produces one; a continuable firing never does.
            let structured = undefined;
            if (useContinuable) {
                const end = await this.runContinuableEpoch(firing, agent, agentById, prompt);
                if (end === null)
                    return; // aborted mid-flight; finalization marks the firing
                // P6 classification in the same commit as the adoption, so the
                // record never shows a settled-but-unclassified firing: only a
                // `completed` epoch proceeds (to the breakpoint park); every
                // other stop reason fails the run — no park, no emission.
                const failed = settledIncomplete(end.stopReason);
                await this.transition(() => {
                    this.adoptEpoch(firing, end);
                    if (failed) {
                        firing.status = "error";
                        firing.error = failFastError(end.stopReason);
                    }
                });
                if (failed) {
                    this.failRun();
                    return;
                }
            }
            else {
                const parent = this.resolveSessionAgent();
                if (parent === undefined) {
                    // Typed failure instead of a harness TypeError: the session
                    // agent is not (yet) live — no one-shot can start, so the
                    // failure fails the run (P6).
                    await this.recordSessionAgentGone(firing);
                    return;
                }
                const outcome = await runOneAgent(this.services, { agent, agentById, inputs, parent, signal: this.signal });
                if (this.signal.aborted)
                    return; // finalization marks the firing aborted
                structured = outcome.structured;
                const failed = await this.settleOneShotFiring(firing, outcome);
                if (failed) {
                    this.failRun();
                    return;
                }
            }
            // A breakpoint parks the firing for the user's decision — unless the
            // run is already failing (P6): a decision point on a failed run is
            // never served, so the firing stays as-is for finalize's sweep.
            if (agent.breakpoint === true && !this.failed) {
                const released = await this.pauseAt(firing, agent, agentById, inputs);
                if (released === null)
                    return;
                firing = released; // Rerun replaced the firing; the release emits ITS output
                structured = undefined; // a parked firing's child is continuable — never structured
            }
            await this.emitOutput(nodeId, firing, structured);
        }
        catch (error) {
            if (this.signal.aborted)
                return;
            await this.transition(() => {
                firing.status = "error";
                firing.error = String(error);
                if (firing.settledAt === undefined)
                    firing.settledAt = new Date().toISOString();
            });
            this.services.logger.warn(`agent-pipeline: firing of agent "${nodeId}" failed: ${String(error)}`);
            this.failRun();
        }
    }
    /**
     * The keyed inputs for a RESURRECTED firing's degraded Rerun, recomposed
     * from the log (the sequential executor's restart parity): the wired
     * upstream sources with their projected outputs. Every source of a fired
     * all-of firing produced an output, so this reframes to the firing's
     * recorded input verbatim.
     */
    resurrectedInputs(nodeId, graph, projected) {
        const upstream = [...new Set(graph.byId[nodeId]?.inputs.flatMap((port) => port.sources) ?? [])].sort(cmp);
        const upstreamOutputs = {};
        for (const id of projected.order) {
            const state = projected.nodes[id];
            if ((state?.status === "done" || state?.status === "paused") && typeof state.output === "string") {
                upstreamOutputs[id] = state.output;
            }
        }
        return agentInput(nodeId, { upstream, upstreamOutputs, pipelineInput: this.record.input });
    }
    // ---- Finalization ----------------------------------------------------------
    /**
     * Finalize: drain every NodeRunner task and the write chain FIRST, so no
     * commit can land after the terminal state, then publish. Firings still
     * marked running/paused at this point are stale by definition (every
     * runner drained, no park queued — only a crash mid-control-op or a
     * fail-fast unwind can leave one) and are marked aborted in EVERY terminal
     * kind, EXCEPT the superseded parked firings a Rerun left behind: those
     * keep `paused` as the honest decision history the P2 record pins. Aborted
     * and parked outputs are preserved.
     */
    async finalize(kind) {
        await Promise.allSettled([...this.runners]);
        await this.writeChain;
        await this.transition(() => {
            const now = new Date().toISOString();
            for (const firing of this.record.firings) {
                if (firing.status === "running" || firing.status === "paused") {
                    const superseded = this.record.firings.some((later) => later.nodeId === firing.nodeId && later.seq > firing.seq);
                    if (!superseded)
                        firing.status = "aborted";
                }
                if (firing.status === "aborted" && firing.settledAt === undefined)
                    firing.settledAt = now;
            }
            this.record.state = kind;
            delete this.record.pausedAt;
        });
        // The terminal state must be DURABLE before the executor leaves the
        // registry: transition() resolves on the mutation, the persist rides
        // behind it, and once onSettle deletes this executor the next workspace
        // load would sweep a stale `running` disk snapshot over the truth.
        await this.writeChain;
        await this.releaseAllAnchors();
        this.onSettle?.(this.record);
    }
    async finalizeCompleted(projected, noRefire) {
        // Quiescence with starving nodes is a surfaced outcome, never a silent
        // skip (design principle 3): the report names every node that never
        // fired and can no longer fire — minus nodes the log already satisfied
        // before a restart.
        const waiting = (this.kernel?.starvingCandidates() ?? []).filter((id) => {
            if (noRefire.has(id))
                return false;
            const status = projected.nodes[id]?.status;
            return status !== "done" && status !== "paused";
        });
        if (waiting.length > 0) {
            this.services.logger.warn(`agent-pipeline: run "${this.record.runId}" ended quiet with waiting nodes: ${waiting.join(", ")}`);
        }
        await this.finalize("completed");
    }
    /**
     * The kernel driver — the executor's main loop. Seed the source (or, on a
     * resurrection, re-enter the paused control wait), then repeatedly start
     * ready firings while the halt gate is open and the cap allows, and sleep
     * on kernel readiness until quiescence or abort. The loop never touches
     * agents: each firing runs in its own NodeRunner task.
     */
    async run(resumeFromPause) {
        try {
            const record = this.record;
            const graph = portGraph(record.graph);
            const agentById = new Map();
            // Selective emission (conditional-dispatch §2): each node's output
            // bindings ride the kernel as data — nodes without any emit
            // non-selectively (the default-graph behavior).
            const bindings = {};
            for (const candidate of record.graph?.agents ?? []) {
                const entry = candidate;
                if (entry == null || typeof entry !== "object" || entry.id == null)
                    continue;
                const id = String(entry.id);
                agentById.set(id, entry);
                if (Array.isArray(entry.bindings) && entry.bindings.length > 0) {
                    bindings[id] = entry.bindings;
                }
            }
            const kernel = new Kernel(graph, { maxInFlight: record.maxInFlight, bindings });
            this.kernel = kernel;
            const projected = projectNodes(record);
            // Restart guards: nodes whose projected status is done/paused never
            // re-fire from kernel messages — the log is the truth. Kernel queue
            // state is not reconstructed on a resume: the pending-pause rebuild
            // re-parks settled breakpoints, re-fired crash-orphans join this
            // set, and released parked firings emit directly — so only
            // post-resume emissions ever flow through the kernel.
            const noRefire = new Set();
            if (resumeFromPause) {
                for (const id of projected.order) {
                    const status = projected.nodes[id]?.status;
                    if (status === "done" || status === "paused")
                        noRefire.add(id);
                }
            }
            if (resumeFromPause) {
                // Resurrected: rebuild the WHOLE pending-pause queue from the log
                // (crash-safe) — every settled-but-unresolved breakpoint firing,
                // not just the crashed `pausedAt` head, so all parked branches
                // stay steerable across the restart. Each entry is driven by its
                // own task holding a kernel slot until it releases (quiescence
                // can then never fire while a release-emission is in flight),
                // emits on release, and nothing re-runs: nodes the log marks
                // done/paused never fire from kernel messages.
                const parkedFirings = this.rebuiltPauseQueue();
                for (const firing of parkedFirings) {
                    const agent = agentById.get(firing.nodeId);
                    if (agent === undefined)
                        continue;
                    const inputs = this.resurrectedInputs(firing.nodeId, graph, projected);
                    const entry = await this.parkFiring(firing, agent, agentById, inputs, { alreadyParked: true });
                    kernel.beginFiring(firing.nodeId);
                    const task = this.drivePauseEntry(entry)
                        .then((released) => { if (released !== null)
                        return this.emitOutput(firing.nodeId, released); })
                        .finally(() => { kernel.endFiring(firing.nodeId); });
                    this.runners.add(task);
                    void task.catch((error) => {
                        this.services.logger.warn(`agent-pipeline: parked firing "${firing.firingId}" control task failed: ${String(error)}`);
                    }).finally(() => { this.runners.delete(task); });
                }
                // Restart rule (executor spec §3): a firing still marked
                // `running` from before the crash — a paid turn was in flight
                // when the process died, and no settlement can ever arrive for
                // it — RE-FIRES on resume with its same composed input, exactly
                // Rerun semantics. The dead firing is marked aborted first (the
                // honest decision history); a breakpointed node re-parks on its
                // fresh firing, a plain one adopts and emits.
                for (const firing of this.orphanedInFlight()) {
                    const agent = agentById.get(firing.nodeId);
                    if (agent === undefined)
                        continue;
                    noRefire.add(firing.nodeId);
                    await this.transition(() => {
                        firing.status = "aborted";
                        if (firing.settledAt === undefined)
                            firing.settledAt = new Date().toISOString();
                    });
                    const inputs = this.resurrectedInputs(firing.nodeId, graph, projected);
                    kernel.beginFiring(firing.nodeId);
                    const task = (agent.breakpoint === true
                        ? (async () => {
                            // Re-fire under the node's parent anchor, then re-park
                            // on the fresh firing and serve control commands.
                            // drivePauseEntry runs UNCONDITIONALLY: on abort it is
                            // what retires the entry, so the halt gate can never
                            // stay closed on a parked orphan's account.
                            const entry = await this.parkFiring(firing, agent, agentById, inputs, { alreadyParked: true });
                            await this.rerunPaused(entry);
                            const released = await this.drivePauseEntry(entry);
                            if (released !== null)
                                await this.emitOutput(firing.nodeId, released);
                            return undefined;
                        })()
                        : this.refirePlain(firing, agent, agentById, inputs)
                            .then((adopted) => { if (adopted !== null)
                            return this.emitOutput(firing.nodeId, adopted.firing, adopted.structured); }))
                        .finally(() => { kernel.endFiring(firing.nodeId); });
                    this.runners.add(task);
                    void task.catch((error) => {
                        this.services.logger.warn(`agent-pipeline: re-firing of "${firing.nodeId}" failed: ${String(error)}`);
                    }).finally(() => { this.runners.delete(task); });
                }
            }
            else if (!this.signal.aborted) {
                // The SOURCE (stream model): the run input emits once to every
                // wired root — a node with no incoming edges is source-fed on
                // all of its ports.
                const sourceMessage = { from: SOURCE_NODE_ID, output: renderValue(record.input) };
                const drops = [];
                for (const id of graph.ids) {
                    const node = graph.byId[id];
                    if (node.inputs.some((port) => port.edges.length > 0))
                        continue;
                    for (const port of node.inputs) {
                        const drop = kernel.deliver(id, port.portId, sourceMessage);
                        if (drop !== null)
                            drops.push(drop);
                    }
                }
                await this.recordDrops(drops);
            }
            while (!this.signal.aborted) {
                // Start ready firings — gate open, under the cap, in node-id
                // order. The stretch from fireableNodes() to waitChange() must
                // not await, so no kernel change can slip between the checks
                // and the sleep. A parked breakpoint firing keeps its kernel
                // slot until its control task ends (the NodeRunner's dispatch
                // slot on the live path, a rebuilt slot on the resurrect path) —
                // harmless while parked (the halt gate is closed, so the cap
                // never binds) and load-bearing at quiescence: the last
                // release's emission must land before the run can end. Once
                // failed, NO firing starts — the check rides along with the
                // abort/gate checks so the halt gate reopening on the last
                // parked unwind cannot restart anything (P6).
                for (const nodeId of kernel.fireableNodes()) {
                    if (this.signal.aborted || this.failed || kernel.halted || kernel.inFlight >= kernel.maxInFlight)
                        break;
                    if (noRefire.has(nodeId))
                        continue;
                    const messages = kernel.takeForFiring(nodeId);
                    kernel.beginFiring(nodeId);
                    const task = this.runFiring(nodeId, messages, agentById).finally(() => kernel.endFiring(nodeId));
                    this.runners.add(task);
                    void task.catch(() => { }).finally(() => { this.runners.delete(task); });
                }
                if (this.signal.aborted)
                    break;
                if (this.failed) {
                    // Fail-fast drain: every kernel slot belongs to a runner
                    // (or parked control) task that releases it exactly when
                    // the task ends, so inFlight === 0 means every firing and
                    // parked entry has finished recording — finalize `error`.
                    if (kernel.inFlight === 0 && this.pauseQueue.length === 0)
                        break;
                    await kernel.waitChange();
                    continue;
                }
                if (this.pauseQueue.length === 0 && kernel.quiescent(noRefire))
                    break;
                await kernel.waitChange();
            }
            if (this.signal.aborted)
                await this.finalize("aborted");
            else if (this.failed)
                await this.finalize("error");
            else
                await this.finalizeCompleted(projected, noRefire);
        }
        catch (error) {
            // Unforeseen executor failure: drain the runners (no commit lands
            // after finalization) and finalize as an errored run.
            this.services.logger.warn(`agent-pipeline: run "${this.record.runId}" executor failed: ${String(error)}`);
            try {
                await this.finalize("error");
            }
            catch (commitError) {
                this.services.logger.warn(`agent-pipeline: run "${this.record.runId}" could not persist its failure: ${String(commitError)}`);
            }
        }
        finally {
            this.endWaiter.dispose();
        }
    }
}
/**
 * The per-workspace run registry: starts executors, lazily loads and sweeps
 * persisted records, and routes control commands. One registry per plugin
 * fiber; one active (running|paused) run per (workspace, session).
 */
export class RunRegistry {
    services;
    executors = new Map();
    constructor(services) {
        this.services = services;
    }
    /** Drop in-memory executor state. Used on plugin unload: records on disk are
     * intentionally left untouched so a paused run survives the unload exactly
     * like a process death (the restart sweep resurrects it). */
    dispose() {
        this.executors.clear();
    }
    /**
     * Start a new run: validate, enforce the single-active-run rule per
     * (cwd, session) — in-memory AND on disk, both scoped to the REQUEST's
     * session — create the record, and start the executor. Returns the runId
     * immediately — the browser follows the record over SSE.
     */
    async startRun(request) {
        const { cwd, sessionId } = request;
        const graph = request.graph ?? undefined;
        if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
            return { ok: false, error: "invalid or missing cwd" };
        }
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            return { ok: false, error: "a live sessionId is required to run the pipeline" };
        }
        if (graph === undefined || typeof graph !== "object" || !Array.isArray(graph.agents)) {
            return { ok: false, error: "the pipeline snapshot is required to run" };
        }
        const validation = validateGraph(graph);
        if (!validation.ok) {
            return { ok: false, error: "graph is invalid: " + validation.errors.map((e) => e.message).join("; ") };
        }
        // One-shot children (and parent-anchor creation) need the live
        // session agent; fail with the historical error when it is gone.
        const sessionAgent = this.services.agents.get(sessionId);
        if (sessionAgent === undefined) {
            return { ok: false, error: `no live agent for session "${sessionId}"` };
        }
        if (!Array.isArray(this.services.subagents.list()) || this.services.subagents.list().indexOf(PROVIDER) === -1) {
            return { ok: false, error: `no subagent provider "${PROVIDER}" is registered` };
        }
        // One active run per (workspace, session): in-memory first, then disk.
        // Another session's active run in the same workspace does not block.
        for (const executor of this.executors.values()) {
            if (executor.record.cwd === cwd && executor.record.sessionId === sessionId) {
                return { ok: false, error: "another run is already active in this session", activeRunId: executor.record.runId };
            }
        }
        const diskActive = await this.loadFromDisk(cwd, sessionId);
        if (diskActive !== null) {
            return { ok: false, error: "another run is already active in this session", activeRunId: diskActive.runId };
        }
        const now = new Date().toISOString();
        // The kernel derives its streams from the immutable snapshot; the
        // firing log fills as nodes fire. Each continuable node's parent anchor
        // id appears in `nodes` when the node first admits a child.
        const record = {
            runId: randomUUID(),
            cwd,
            sessionId,
            createdAt: now,
            updatedAt: now,
            state: "running",
            graph,
            ...(request.input === undefined ? {} : { input: request.input }),
            recordVersion: 2,
            maxInFlight: normalizeMaxInFlight(request.maxInFlight),
            firings: [],
            nodes: {},
        };
        await mkdir(join(cwd, RUNS_DIR), { recursive: true });
        await writeAtomic(recordPath(cwd, record.runId), `${JSON.stringify(record, null, 2)}\n`);
        const executor = new RunExecutor(this.services, record, {
            sessionAgent,
            onSettle: () => { this.executors.delete(record.runId); },
        });
        this.executors.set(record.runId, executor);
        return { ok: true, runId: record.runId };
    }
    /**
     * The workspace's active run record — or, when `sessionId` is a valid key,
     * THAT session's active run — lazily loading (and sweeping / resurrecting)
     * from disk when no executor is in memory. Returns null when nothing is
     * active within the scope. Without a valid key the unscoped legacy path
     * picks the newest active run of any session.
     */
    async activeRunForCwd(cwd, sessionId) {
        if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd))
            return null;
        const scope = sessionScope(sessionId);
        let best = null;
        for (const executor of this.executors.values()) {
            const rec = executor.record;
            if (rec.cwd !== cwd)
                continue;
            if (scope !== null && rec.sessionId !== scope)
                continue;
            if (rec.state !== "running" && rec.state !== "paused")
                continue;
            if (best === null || rec.updatedAt > best.updatedAt)
                best = rec;
        }
        if (best !== null)
            return best;
        return this.loadFromDisk(cwd, scope);
    }
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
    async latestRunForCwd(cwd, sessionId) {
        if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd))
            return null;
        const scope = sessionScope(sessionId);
        let best = null;
        let bestStamp = "";
        for (const executor of this.executors.values()) {
            const rec = executor.record;
            if (rec.cwd !== cwd)
                continue;
            if (scope !== null && rec.sessionId !== scope)
                continue;
            if (best === null || rec.updatedAt > bestStamp) {
                best = rec;
                bestStamp = rec.updatedAt;
            }
        }
        if (best !== null)
            return best;
        let entries;
        try {
            entries = await readdir(join(cwd, RUNS_DIR));
        }
        catch {
            return null; // no runs directory yet
        }
        for (const entry of entries) {
            if (!entry.endsWith(".json"))
                continue;
            const rec = await readRecordFile(join(cwd, RUNS_DIR, entry));
            if (rec === null || rec.cwd !== cwd)
                continue;
            if (scope !== null && rec.sessionId !== scope)
                continue;
            if (this.executors.has(rec.runId))
                continue; // in-memory state is fresher
            if (rec.state === "running" || rec.state === "paused")
                await this.sweepOrResurrect(rec);
            const stamp = typeof rec.updatedAt === "string"
                ? rec.updatedAt
                : typeof rec.createdAt === "string" ? rec.createdAt : "";
            if (best === null || stamp > bestStamp) {
                best = rec;
                bestStamp = stamp;
            }
        }
        return best;
    }
    /**
     * One run's full record: in-memory when an executor holds it, else from
     * disk under `cwd` (loading/sweeping the workspace first, so a stale
     * running record is swept and a paused one resurrected before it is read).
     * A legacy v1 record is served read-only.
     */
    async getRun(runId, cwd) {
        if (typeof runId !== "string" || runId.length === 0)
            return null;
        const executor = this.executors.get(runId);
        if (executor !== undefined)
            return executor.record;
        if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd))
            return null;
        const active = await this.loadFromDisk(cwd);
        if (active !== null && active.runId === runId)
            return active;
        return readRecordFile(recordPath(cwd, runId));
    }
    /**
     * Subscribe to a run's transitions. Returns a disposer, or null when the
     * run has no live executor (a terminal record will never update again).
     */
    subscribe(runId, fn) {
        if (typeof runId !== "string" || runId.length === 0)
            return null;
        const executor = this.executors.get(runId);
        if (executor === undefined)
            return null;
        return executor.subscribe(fn);
    }
    /**
     * Route a control command to a run. `resume`/`rerun`/`steer` are accepted
     * only while the run is parked at a pause point; `abort` is accepted any
     * time the run is still active. `cwd` is the workspace hint that lets a
     * paused record surviving a profile restart be loaded (swept + resurrected)
     * before the command is routed — scoped to the target run's own session, so
     * the load never sweeps or resurrects another session's records.
     */
    async control(runId, request, cwd) {
        if (typeof runId !== "string" || runId.length === 0)
            return { ok: false, error: "missing runId" };
        const action = request?.action;
        if (action !== "resume" && action !== "rerun" && action !== "steer" && action !== "abort") {
            return { ok: false, error: "action must be one of resume, rerun, steer, abort" };
        }
        if (action === "steer" && (typeof request.feedback !== "string" || request.feedback.trim().length === 0)) {
            return { ok: false, error: "steer requires non-empty feedback" };
        }
        const validCwd = typeof cwd === "string" && cwd.length > 0 && isAbsolute(cwd) ? cwd : null;
        if (validCwd !== null && !this.executors.has(runId)) {
            // Make sure a paused record surviving a restart is controllable:
            // load its workspace first (sweeps stale runs, resurrects paused
            // ones). The load is scoped to the TARGET record's session — read
            // best-effort off its file (this gate already establishes that no
            // live executor holds the runId, so a live control command pays no
            // disk read) — so session A's control command cannot sweep or
            // resurrect session B's records. An unreadable target file skips
            // the sweep; a target without a usable `sessionId` (only
            // hand-crafted records lack it) keeps the unscoped legacy sweep.
            // The "no run" error below answers as before.
            const target = await readRecordFile(recordPath(validCwd, runId));
            if (target !== null) {
                await this.loadFromDisk(validCwd, target.sessionId);
            }
        }
        const live = this.executors.get(runId);
        if (live === undefined) {
            const rec = validCwd !== null ? await readRecordFile(recordPath(validCwd, runId)) : null;
            return {
                ok: false,
                error: rec !== null
                    ? `run "${runId}" is ${rec.state} and accepts no control commands`
                    : `no run "${runId}"`,
            };
        }
        if (action === "abort") {
            live.abort();
            return { ok: true };
        }
        if (!live.awaitingControl) {
            return { ok: false, error: "the run is not paused at a breakpoint" };
        }
        if (action === "steer" && !live.canSteer()) {
            return { ok: false, error: "steering is unavailable for this run (requires continuable subagent support and a started child)" };
        }
        const posted = live.postControl(action === "steer" ? { action: "steer", feedback: request.feedback } : { action });
        return posted ? { ok: true } : { ok: false, error: "the run is not paused at a breakpoint" };
    }
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
    async loadFromDisk(cwd, sessionId) {
        const scope = sessionScope(sessionId);
        let entries;
        try {
            entries = await readdir(join(cwd, RUNS_DIR));
        }
        catch {
            return null; // no runs directory yet
        }
        let best = null;
        for (const entry of entries) {
            if (!entry.endsWith(".json"))
                continue;
            const rec = await readRecordFile(join(cwd, RUNS_DIR, entry));
            if (rec === null || rec.cwd !== cwd)
                continue;
            if (scope !== null && rec.sessionId !== scope)
                continue;
            if (this.executors.has(rec.runId))
                continue; // in-memory state is fresher
            if (rec.state === "running" || rec.state === "paused") {
                await this.sweepOrResurrect(rec);
            }
            if (rec.state === "running" || rec.state === "paused") {
                if (best === null || rec.updatedAt > best.updatedAt)
                    best = rec;
            }
        }
        return best;
    }
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
    async sweepOrResurrect(rec) {
        if (isV2Record(rec)) {
            if (rec.state === "running") {
                const now = new Date().toISOString();
                for (const firing of rec.firings) {
                    if (firing.status === "running") {
                        firing.status = "aborted";
                        firing.settledAt = now;
                    }
                }
                rec.state = "aborted";
                delete rec.pausedAt;
                rec.updatedAt = now;
                await this.persistSwept(rec);
                return;
            }
            // Fully controllable across the restart: resurrect the executor;
            // it re-enters the control wait without re-running anything.
            // Re-resolve the session agent so remaining ONE-SHOT nodes (and a
            // degraded Rerun) can still start; continuable steer/rerun work
            // through the node's cold-resumed parent anchor even when it is not live.
            const executor = new RunExecutor(this.services, rec, {
                resume: true,
                sessionAgent: this.services.agents.get(rec.sessionId),
                onSettle: () => { this.executors.delete(rec.runId); },
            });
            this.executors.set(rec.runId, executor);
            return;
        }
        // Legacy v1: read-only — swept or finalized, never resurrected.
        const now = new Date().toISOString();
        for (const id of rec.order) {
            const node = rec.nodes?.[id];
            if (node === undefined)
                continue;
            if (node.status === "running")
                node.status = "aborted";
            if (rec.state === "paused" && id === rec.pausedAt && node.status === "paused") {
                node.status = "aborted";
                node.error = "this paused run predates the firing-log executor and cannot be resumed — start a new run";
            }
        }
        rec.state = "aborted";
        delete rec.pausedAt;
        rec.updatedAt = now;
        await this.persistSwept(rec);
    }
    /** Persist a swept record (best effort — a failed sweep is logged, not fatal). */
    async persistSwept(rec) {
        try {
            await writeAtomic(recordPath(rec.cwd, rec.runId), `${JSON.stringify(rec, null, 2)}\n`);
        }
        catch (error) {
            this.services.logger.warn(`agent-pipeline: sweeping stale run "${rec.runId}" failed: ${String(error)}`);
        }
    }
}
//# sourceMappingURL=runs.js.map