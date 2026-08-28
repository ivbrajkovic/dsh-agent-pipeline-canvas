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
// Execution model (sequential by design — a pause halts the whole run, not
// just one branch): the executor walks the immutable snapshot's topological
// order, skipping nodes already done. Each node's composed prompt is written
// ONCE when first reached and is immutable for the run's lifetime (Rerun
// restarts the agent with this verbatim input, never with steering content).
//
//   - Non-breakpointed agents run through the historical one-shot path
//     (runOneAgent), parented to the user's session agent — unchanged.
//   - Breakpointed agents run as CONTINUABLE subagents (startContinuableAgent)
//     under a disposable per-run COORDINATOR agent — a hidden `origin:
//     "subagent"` child of the user's session with `delegationDepth: 0`, so
//     settlement notices never reach the user's chat (the coordinator is only
//     live inside control operations; notices to an absent parent are dropped)
//     and per-agent maxDepth caps keep their absolute semantics. The
//     coordinator handle is disposed after every operation; its durable
//     session id is persisted in the record and cold-resumed on demand
//     (`agents.resume`) after a restart.
//
// Settlement is push-based: a single `subagent/end` listener is registered
// BEFORE any child starts/steers and settlements are matched by child id. A
// continuable epoch's `lastAssistantMessage` is epoch-relative (only the new
// answer), so it is adopted directly.
//
// Pause semantics: when a breakpointed agent's output settles, the node is
// marked `paused`, the record is persisted, and the executor awaits a control
// command on an event-driven mailbox (no timers):
//
//   - resume  — mark the node done and continue with the recorded output.
//   - rerun   — a FRESH child (new childId; old transcript preserved) started
//               with the node's verbatim input; after settle, back to paused.
//   - steer   — `subagents.followup` to the SAME child (cold-resume from its
//               persisted session — works after a restart); after settle, the
//               epoch output is adopted and the run stays paused. Repeatable.
//   - abort   — interrupt any in-flight continuable turn (authorized by the
//               coordinator's durable parentSession, so it works while the
//               coordinator is disposed), mark the in-flight node aborted, and
//               finalize `state: "aborted"` with completed outputs preserved.
//
// Durability: there is no boot scan. When a workspace's runs are first loaded
// (pipeline GET, run GET, SSE connect, or a new POST /run), a record found in
// `running` is stale — its executor died with the previous process — and is
// swept to `aborted` (in-flight node aborted, outputs intact); a record found
// in `paused` is resurrected as a fully controllable executor that re-enters
// the control wait without re-running anything. One run is active
// (running|paused) per workspace: enforced in-memory and re-checked on disk.
import { mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomic } from "./storage.js";
import { validateGraph } from "./graph.js";
import { agentInput, agentPrompt, classifyGraph, topoOrder } from "./execution.js";
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
 * continuable child id, and the unmatched buffer is FIFO-capped.
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
            // Not (yet) waited on — keep it for a later wait(), capped.
            this.buffered.set(childId, info);
            if (this.buffered.size > 32) {
                const oldest = this.buffered.keys().next().value;
                if (oldest !== undefined)
                    this.buffered.delete(oldest);
            }
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
/** Parse one record file, or null when missing/corrupt (a bad file is skipped, not fatal). */
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
        if (typeof rec.runId !== "string" || typeof rec.cwd !== "string")
            return null;
        if (typeof rec.state !== "string" || typeof rec.order !== "object" || rec.order === null)
            return null;
        return rec;
    }
    catch {
        return null;
    }
}
/**
 * One run's executor fiber: mutates the record in place, persists every
 * transition, and awaits control commands while paused. The fiber finishes
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
    coordinatorHandle = null;
    /** The continuable child that may currently have a turn in flight (abort target). */
    activeChildId = null;
    currentNodeId = null;
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
        // The interrupt-on-abort wiring: a live continuable turn is stopped via
        // the harness interrupt, authorized by the child's durable parentSession
        // (the coordinator's id) — the coordinator agent itself need not be
        // live. A paused control wait is woken so the loop can finalize.
        this.signal.addEventListener("abort", () => {
            const childId = this.activeChildId;
            const coordinatorId = this.record.coordinatorSessionId;
            const interrupt = this.services.subagents.interrupt;
            if (childId !== null && coordinatorId !== undefined && typeof interrupt === "function") {
                try {
                    interrupt.call(this.services.subagents, childId, { kind: "user", parentSessionId: coordinatorId });
                }
                catch (error) {
                    this.services.logger.warn(`agent-pipeline: interrupting child "${childId}" failed: ${String(error)}`);
                }
            }
            this.postControl({ action: "abort" });
        });
        void this.run(options.resume === true).catch(() => { });
    }
    // ---- Control surface (called by the registry on behalf of routes) ----
    /** Whether the executor is parked at a pause point waiting for a command. */
    get awaitingControl() {
        return this.controlWaiter !== null;
    }
    /** Whether a steer command can currently be accepted for the paused node. */
    canSteer() {
        if (!this.canContinuable)
            return false;
        const node = this.pausedNode();
        return node !== null && typeof node.childSessionId === "string" && node.childSessionId.length > 0;
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
    subscribe(fn) {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }
    pausedNode() {
        const id = this.record.pausedAt;
        if (id === undefined)
            return null;
        return this.record.nodes[id] ?? null;
    }
    awaitControl() {
        return new Promise((resolve) => { this.controlWaiter = resolve; });
    }
    /** Persist the record and notify subscribers. Call after every transition. */
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
    // ---- Coordinator lifecycle ----
    /**
     * Mirror the session agent's options onto the coordinator, minus the runtime
     * delegation-depth option: the coordinator's durable header stamps
     * `delegationDepth: 0`, and a stale runtime `subagentDepth` would override
     * it and silently shift every pipeline child one level deeper.
     */
    coordinatorOptions() {
        const src = this.sessionAgent && typeof this.sessionAgent.options === "object" && this.sessionAgent.options !== null
            ? this.sessionAgent.options
            : {};
        const out = { ...src };
        delete out.subagentDepth;
        return Object.keys(out).length > 0 ? out : undefined;
    }
    /**
     * Return the run's coordinator agent, creating or cold-resuming it on
     * demand. Live ONLY inside control operations: the caller disposes the
     * handle right after each start/followup acceptance, so the harness's
     * settlement notice — which would otherwise wake the parent with a real
     * model turn — finds no live parent and is dropped. The coordinator's
     * durable session id is persisted before any child is created, so a later
     * interrupt (and a post-restart steer) can authorize against it.
     */
    async ensureCoordinator() {
        const agents = this.services.agents;
        if (this.record.coordinatorSessionId !== undefined) {
            const live = agents.get(this.record.coordinatorSessionId);
            if (live !== undefined && live !== null && typeof live.id === "string") {
                return live;
            }
            // Not resident (disposed after the last operation, or a restart):
            // cold-resume the persisted coordinator session.
            const handle = await agents.resume({
                resumeSessionId: this.record.coordinatorSessionId,
                agentOptions: this.coordinatorOptions(),
                signal: this.signal,
            });
            this.coordinatorHandle = handle;
            return handle.agent;
        }
        if (this.sessionAgent === undefined) {
            throw new Error("the run's coordinator cannot be created because the session agent is not live");
        }
        const sessionId = randomUUID();
        const handle = await agents.create({
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
            agentOptions: this.coordinatorOptions(),
            signal: this.signal,
        });
        this.coordinatorHandle = handle;
        this.record.coordinatorSessionId = sessionId;
        await this.commit();
        return handle.agent;
    }
    /** Dispose the retained coordinator handle (the session itself persists). */
    async releaseCoordinator() {
        const handle = this.coordinatorHandle;
        this.coordinatorHandle = null;
        if (handle !== null) {
            try {
                await handle.dispose();
            }
            catch (error) {
                this.services.logger.warn(`agent-pipeline: disposing the run coordinator failed: ${String(error)}`);
            }
        }
    }
    // ---- Execution ----
    /**
     * Run one continuable epoch for node `id`: ensure the coordinator, start a
     * FRESH child with the node's verbatim prompt, dispose the coordinator
     * immediately after acceptance, and await the child's first settlement.
     * Returns the end info, or null when the run was aborted mid-flight.
     */
    async runContinuableEpoch(id, agent, agentById, prompt) {
        const node = this.record.nodes[id];
        try {
            const coordinator = await this.ensureCoordinator();
            let childId = "";
            try {
                ({ childId } = await startContinuableAgent(this.services, {
                    agent,
                    agentById,
                    prompt,
                    parent: coordinator,
                    signal: this.signal,
                }));
            }
            finally {
                // Dispose between operations: settlement notices to an absent
                // parent are dropped instead of burning a model turn.
                await this.releaseCoordinator();
            }
            node.childSessionId = childId;
            this.activeChildId = childId;
            await this.commit();
            const end = await this.endWaiter.wait(childId, this.signal);
            return this.signal.aborted ? null : end;
        }
        catch (error) {
            if (this.signal.aborted)
                return null;
            throw error;
        }
        finally {
            this.activeChildId = null;
        }
    }
    /**
     * Steer the paused node's SAME child with user feedback and adopt the
     * steering epoch's (epoch-relative) output. Throws on failure; the caller
     * keeps the run paused so the user can retry or take another action.
     */
    async steerNode(id, feedback) {
        const node = this.record.nodes[id];
        const childId = node.childSessionId;
        try {
            const coordinator = await this.ensureCoordinator();
            try {
                await steerContinuableAgent(this.services, {
                    parent: coordinator,
                    childId,
                    feedback,
                    signal: this.signal,
                });
            }
            finally {
                await this.releaseCoordinator();
            }
            this.activeChildId = childId;
            const end = await this.endWaiter.wait(childId, this.signal);
            if (this.signal.aborted)
                return;
            if (end !== null) {
                node.output = toText(end.lastAssistantMessage);
                node.stopReason = end.stopReason;
            }
        }
        finally {
            this.activeChildId = null;
        }
    }
    /**
     * The paused control loop for a breakpointed node. Returns true when the
     * node was released ("resume") and the topo loop should continue; false
     * when the run aborted. Rerun and Steer return to paused when done (or on
     * failure, with the failure recorded on the node).
     */
    async pauseLoop(id, agent, agentById, upstream, outputsById) {
        const node = this.record.nodes[id];
        while (true) {
            node.status = "paused";
            this.record.state = "paused";
            this.record.pausedAt = id;
            // Arm the mailbox BEFORE the paused state becomes visible (the commit
            // persists + publishes it): a client that observes the record as
            // paused can never hit a window where its command is rejected.
            const cmdPromise = new Promise((resolve) => { this.controlWaiter = resolve; });
            await this.commit();
            const cmd = await cmdPromise;
            if (cmd.action === "abort")
                return false;
            if (cmd.action === "resume") {
                node.status = "done";
                this.record.state = "running";
                delete this.record.pausedAt;
                await this.commit();
                return true;
            }
            if (cmd.action === "rerun") {
                // Fresh child, verbatim original input — never steering content.
                this.currentNodeId = id;
                try {
                    if (this.canContinuable) {
                        node.status = "running";
                        this.record.state = "running";
                        await this.commit();
                        const end = await this.runContinuableEpoch(id, agent, agentById, node.input);
                        if (end === null)
                            return false;
                        node.output = toText(end.lastAssistantMessage);
                        node.stopReason = end.stopReason;
                        outputsById[id] = node.output;
                    }
                    else {
                        // Degraded deployment: rerun as a fresh one-shot child. The
                        // structured inputs are recomposed deterministically from the
                        // immutable snapshot, so the prompt is `node.input` verbatim.
                        const parent = this.resolveSessionAgent();
                        if (parent === undefined) {
                            node.status = "paused";
                            node.error = "the session agent is not live — reopen the conversation, then rerun";
                            this.services.logger.warn(`agent-pipeline: rerun of agent "${id}" has no live session agent`);
                            continue;
                        }
                        node.status = "running";
                        this.record.state = "running";
                        await this.commit();
                        const inputs = agentInput(id, { upstream: [...upstream], upstreamOutputs: outputsById, pipelineInput: this.record.input });
                        const outcome = await runOneAgent(this.services, {
                            agent,
                            agentById,
                            inputs,
                            parent,
                            signal: this.signal,
                        });
                        if (this.signal.aborted)
                            return false;
                        if (outcome.error) {
                            node.error = outcome.error;
                            node.stopReason = outcome.stopReason;
                        }
                        else {
                            delete node.error;
                            node.output = outcome.output;
                            node.stopReason = outcome.stopReason;
                            node.childSessionId = outcome.childSessionId;
                            outputsById[id] = node.output;
                        }
                    }
                }
                catch (error) {
                    if (this.signal.aborted)
                        return false;
                    node.status = "paused";
                    node.error = String(error);
                    this.services.logger.warn(`agent-pipeline: rerun of agent "${id}" failed: ${String(error)}`);
                }
                finally {
                    this.currentNodeId = null;
                }
                continue; // back to paused — the user decides again
            }
            if (cmd.action === "steer") {
                this.currentNodeId = id;
                try {
                    node.status = "running";
                    // record.state stays "paused" with pausedAt intact: a crash or
                    // restart mid-steer must resurrect the pause, not sweep the run.
                    await this.commit();
                    await this.steerNode(id, cmd.feedback);
                    if (this.signal.aborted)
                        return false;
                    delete node.error;
                    outputsById[id] = node.output;
                }
                catch (error) {
                    if (this.signal.aborted)
                        return false;
                    node.error = String(error);
                    this.services.logger.warn(`agent-pipeline: steering agent "${id}" failed: ${String(error)}`);
                }
                finally {
                    this.currentNodeId = null;
                }
                continue; // still paused with the adopted output
            }
        }
    }
    /** Mark the in-flight/paused node aborted, keep completed outputs, and finalize. */
    async finalizeAborted() {
        for (const id of this.record.order) {
            const node = this.record.nodes[id];
            // A paused node never released its output into the pipeline flow —
            // the run was aborted AT it, so it reads aborted (output preserved).
            if (node !== undefined && (node.status === "running" || node.status === "paused"))
                node.status = "aborted";
        }
        this.record.state = "aborted";
        delete this.record.pausedAt;
        await this.releaseCoordinator();
        await this.commit();
        this.onSettle?.(this.record);
    }
    async finalizeCompleted() {
        this.record.state = "completed";
        delete this.record.pausedAt;
        await this.releaseCoordinator();
        await this.commit();
        this.onSettle?.(this.record);
    }
    /** The executor's main loop. */
    async run(resumeFromPause) {
        try {
            const record = this.record;
            const classified = classifyGraph(record.graph);
            const agentById = new Map();
            for (const agent of record.graph?.agents ?? []) {
                if (agent != null && agent.id != null)
                    agentById.set(String(agent.id), agent);
            }
            // Rebuild downstream inputs from every node that already has an
            // adopted output (done nodes, and the paused node's current output).
            const outputsById = {};
            for (const id of Object.keys(record.nodes)) {
                const node = record.nodes[id];
                if ((node.status === "done" || node.status === "paused") && typeof node.output === "string") {
                    outputsById[id] = node.output;
                }
            }
            const pausedIndex = resumeFromPause && record.pausedAt !== undefined ? record.order.indexOf(record.pausedAt) : -1;
            for (let i = 0; i < record.order.length; i++) {
                if (this.signal.aborted)
                    break;
                const id = record.order[i];
                const agent = agentById.get(id);
                const node = record.nodes[id];
                if (agent === undefined || node === undefined)
                    continue;
                if (node.status === "done")
                    continue;
                // A resurrected executor must not re-run anything before the pause.
                if (pausedIndex >= 0 && i < pausedIndex)
                    continue;
                // Compose the node's input ONCE — immutable for the run's lifetime.
                if (typeof node.input !== "string") {
                    const upstream = classified.upstream[id] ?? [];
                    const inputs = agentInput(id, { upstream, upstreamOutputs: outputsById, pipelineInput: record.input });
                    node.input = agentPrompt(agent, inputs, agentById);
                    await this.commit();
                }
                this.currentNodeId = id;
                try {
                    if (pausedIndex === i) {
                        // Resurrected at the pause point: re-enter the control wait
                        // with the existing output/child, running nothing.
                        if (!(await this.pauseLoop(id, agent, agentById, classified.upstream[id] ?? [], outputsById)))
                            break;
                        continue;
                    }
                    const useContinuable = this.canContinuable && agent.breakpoint === true;
                    if (useContinuable) {
                        node.status = "running";
                        await this.commit();
                        const end = await this.runContinuableEpoch(id, agent, agentById, node.input);
                        if (end === null)
                            break;
                        node.output = toText(end.lastAssistantMessage);
                        node.stopReason = end.stopReason;
                        outputsById[id] = node.output;
                        // Breakpoint armed (useContinuable implies breakpoint): park.
                        if (!(await this.pauseLoop(id, agent, agentById, classified.upstream[id] ?? [], outputsById)))
                            break;
                        continue;
                    }
                    // One-shot path (non-breakpointed, or breakpoints degraded).
                    const parent = this.resolveSessionAgent();
                    if (parent === undefined) {
                        // Typed failure instead of a harness TypeError: the session
                        // agent is not (yet) live — matches the runner's
                        // continue-on-error semantics for the remaining nodes.
                        node.status = "error";
                        node.error = "the session agent is not live — reopen the conversation and start a new run";
                        await this.commit();
                        continue;
                    }
                    node.status = "running";
                    await this.commit();
                    const upstream = classified.upstream[id] ?? [];
                    const inputs = agentInput(id, { upstream, upstreamOutputs: outputsById, pipelineInput: record.input });
                    const outcome = await runOneAgent(this.services, { agent, agentById, inputs, parent, signal: this.signal });
                    if (this.signal.aborted) {
                        node.status = "aborted";
                        node.stopReason = outcome.stopReason;
                        break;
                    }
                    if (outcome.error) {
                        // Runner parity: a failed agent is recorded, the loop continues.
                        node.status = "error";
                        node.error = outcome.error;
                        node.stopReason = outcome.stopReason;
                    }
                    else {
                        node.status = "done";
                        delete node.error;
                        node.output = outcome.output;
                        node.stopReason = outcome.stopReason;
                        if (outcome.childSessionId !== undefined)
                            node.childSessionId = outcome.childSessionId;
                        outputsById[id] = outcome.output;
                    }
                    await this.commit();
                    // Degraded breakpoints still pause (steering unavailable; the
                    // pause loop's rerun works, its steer is rejected upstream).
                    if (agent.breakpoint === true && this.canContinuable !== true) {
                        if (!(await this.pauseLoop(id, agent, agentById, classified.upstream[id] ?? [], outputsById)))
                            break;
                    }
                }
                finally {
                    this.currentNodeId = null;
                }
            }
            if (this.signal.aborted)
                await this.finalizeAborted();
            else
                await this.finalizeCompleted();
        }
        catch (error) {
            // Unforeseen executor failure: record it on the current node (when one
            // is attributable) and finalize as an errored run.
            this.services.logger.warn(`agent-pipeline: run "${this.record.runId}" executor failed: ${String(error)}`);
            if (this.currentNodeId !== null) {
                const node = this.record.nodes[this.currentNodeId];
                if (node !== undefined) {
                    node.status = "error";
                    node.error = String(error);
                }
            }
            try {
                this.record.state = "error";
                delete this.record.pausedAt;
                await this.releaseCoordinator();
                await this.commit();
                this.onSettle?.(this.record);
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
 * fiber; one active (running|paused) run per workspace.
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
     * Start a new run: validate, enforce the single-active-run rule (in-memory
     * AND on disk), create the record, and start the executor. Returns the
     * runId immediately — the browser follows the record over SSE.
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
        // One-shot children (and the coordinator's creation) need the live
        // session agent; fail with the historical error when it is gone.
        const sessionAgent = this.services.agents.get(sessionId);
        if (sessionAgent === undefined) {
            return { ok: false, error: `no live agent for session "${sessionId}"` };
        }
        if (!Array.isArray(this.services.subagents.list()) || this.services.subagents.list().indexOf(PROVIDER) === -1) {
            return { ok: false, error: `no subagent provider "${PROVIDER}" is registered` };
        }
        // Single active run per workspace: in-memory first, then disk.
        for (const executor of this.executors.values()) {
            if (executor.record.cwd === cwd) {
                return { ok: false, error: "another run is already active in this workspace", activeRunId: executor.record.runId };
            }
        }
        const diskActive = await this.loadFromDisk(cwd);
        if (diskActive !== null) {
            return { ok: false, error: "another run is already active in this workspace", activeRunId: diskActive.runId };
        }
        const order = topoOrder(graph);
        const nodes = {};
        for (const id of order)
            nodes[id] = { status: "pending" };
        const now = new Date().toISOString();
        const record = {
            runId: randomUUID(),
            cwd,
            sessionId,
            createdAt: now,
            updatedAt: now,
            state: "running",
            graph,
            ...(request.input === undefined ? {} : { input: request.input }),
            order,
            nodes,
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
     * The workspace's active run record, lazily loading (and sweeping /
     * resurrecting) from disk when no executor is in memory. Returns null when
     * the workspace has no active run.
     */
    async activeRunForCwd(cwd) {
        if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd))
            return null;
        let best = null;
        for (const executor of this.executors.values()) {
            const rec = executor.record;
            if (rec.cwd !== cwd)
                continue;
            if (rec.state !== "running" && rec.state !== "paused")
                continue;
            if (best === null || rec.updatedAt > best.updatedAt)
                best = rec;
        }
        if (best !== null)
            return best;
        return this.loadFromDisk(cwd);
    }
    /**
     * One run's full record: in-memory when an executor holds it, else from
     * disk under `cwd` (loading/sweeping the workspace first, so a stale
     * running record is swept and a paused one resurrected before it is read).
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
     * before the command is routed.
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
            // load its workspace first (sweeps stale runs, resurrects paused ones).
            await this.loadFromDisk(validCwd);
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
     * (or null). In-memory executors always win over their disk copies.
     */
    async loadFromDisk(cwd) {
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
            if (this.executors.has(rec.runId))
                continue; // in-memory state is fresher
            let isActive = false;
            if (rec.state === "running") {
                // Stale: the executor died with the previous process. Abort the
                // in-flight node, preserve completed outputs.
                for (const id of rec.order) {
                    const node = rec.nodes?.[id];
                    if (node !== undefined && node.status === "running")
                        node.status = "aborted";
                }
                rec.state = "aborted";
                delete rec.pausedAt;
                rec.updatedAt = new Date().toISOString();
                try {
                    await writeAtomic(recordPath(cwd, rec.runId), `${JSON.stringify(rec, null, 2)}\n`);
                }
                catch (error) {
                    this.services.logger.warn(`agent-pipeline: sweeping stale run "${rec.runId}" failed: ${String(error)}`);
                }
            }
            else if (rec.state === "paused") {
                // Fully controllable across the restart: resurrect the executor;
                // it re-enters the control wait without re-running anything.
                // Re-resolve the session agent so remaining ONE-SHOT nodes (and a
                // degraded Rerun) can still start; continuable steer/rerun work
                // through the cold-resumed coordinator even when it is not live.
                const executor = new RunExecutor(this.services, rec, {
                    resume: true,
                    sessionAgent: this.services.agents.get(rec.sessionId),
                    onSettle: () => { this.executors.delete(rec.runId); },
                });
                this.executors.set(rec.runId, executor);
                isActive = true;
            }
            if (isActive) {
                if (best === null || rec.updatedAt > best.updatedAt)
                    best = rec;
            }
        }
        return best;
    }
}
//# sourceMappingURL=runs.js.map