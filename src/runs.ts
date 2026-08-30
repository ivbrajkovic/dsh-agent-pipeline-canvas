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
// order (derived on demand, never persisted), one FIRING per node start —
// the sequential run is the special case of one firing per node, and the
// record is the firing log (recordVersion 2; the per-node view the UI shows
// is projected from it by lib/projection.ts, never stored). A firing's
// composed prompt is written ONCE at start and is immutable for the run's
// lifetime; Rerun appends a NEW firing with the SAME verbatim input (a fresh
// child; the superseded firing stays in the log), never with steering
// content. Steering continues the same firing's child and updates its
// output in place.
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
import { writeAtomic } from "./storage.ts";
import { validateGraph } from "./graph.ts";
import { agentInput, agentPrompt, classifyGraph, topoOrder } from "./execution.ts";
import { projectNodes } from "./projection.ts";
import {
	PROVIDER,
	continuableSupported,
	runOneAgent,
	startContinuableAgent,
	steerContinuableAgent,
	toText,
	type RunnerContext,
	type SubagentRunEndInfoLike,
} from "./runner.ts";
import type { Agent, LegacyRunRecord, PipelineGraph, RunFiring, RunRecord } from "./types.ts";

const RUNS_DIR = ".agent-pipeline/runs";

// ---- Minimal, structural views of the harness services the registry touches ----
// Same discipline as runner.ts: standalone zero-dep plugin, so only the fields
// actually called are named; the real services satisfy the shapes structurally.

/** The live-Agent fields the coordinator machinery reads. */
interface LiveAgentLike {
	id: string;
	options?: Record<string, unknown>;
}

interface AgentHandleLike {
	agent: LiveAgentLike;
	dispose(): Promise<void> | void;
}

/**
 * Structural view of the agents service's coordinator surface
 * (`ctx.agents.create` / `ctx.agents.resume` — the agent-loop registers the
 * factory in the base bundle, so a plugin may call both).
 */
interface CoordinatorAgentsService {
	get(sessionId: string): unknown | undefined;
	create(options: {
		sessionId: string;
		meta?: { cwd?: string; parentSession?: string; origin?: "subagent"; delegationDepth?: number };
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
	agents: CoordinatorAgentsService;
	subagents: RunnerContext["subagents"];
	/** Settlement seam — production wires `ctx.on("subagent/end", fn)`. */
	subscribeRunEnd(fn: (info: SubagentRunEndInfoLike) => void): () => void;
	/** Feature probe: continuable children additionally require persistence. */
	sessionPersistence?: unknown;
}

/** Whether breakpointed agents can run as continuable (steerable) children. */
function continuableRuntime(services: RunRegistryServices): boolean {
	return continuableSupported(services) && services.sessionPersistence !== undefined;
}

/** A control command resolved into the executor's pause mailbox. */
type ControlCommand =
	| { action: "resume" }
	| { action: "rerun" }
	| { action: "steer"; feedback: string }
	| { action: "abort" };

/**
 * Matches `subagent/end` settlements to the child ids the executor waits on.
 * The listener is installed at construction — BEFORE any child is started or
 * steered — so a settlement can never slip past registration; events arriving
 * before their `wait()` call (the acceptance-to-wait window) are buffered and
 * matched then. One-shot children also emit the event; their ids never match a
 * continuable child id, and the unmatched buffer is FIFO-capped.
 */
class EndWaiter {
	private readonly waiters = new Map<string, (info: SubagentRunEndInfoLike) => void>();
	private readonly buffered = new Map<string, SubagentRunEndInfoLike>();
	private readonly disposer: () => void;

	constructor(subscribe: (fn: (info: SubagentRunEndInfoLike) => void) => () => void) {
		this.disposer = subscribe((info) => {
			const childId = info && typeof info.id === "string" ? info.id : "";
			if (childId.length === 0) return;
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
				if (oldest !== undefined) this.buffered.delete(oldest);
			}
		});
	}

	/** Resolve with the settlement for `childId`, or null when the signal aborts first. */
	wait(childId: string, signal: AbortSignal): Promise<SubagentRunEndInfoLike | null> {
		const buffered = this.buffered.get(childId);
		if (buffered !== undefined) {
			this.buffered.delete(childId);
			return Promise.resolve(buffered);
		}
		return new Promise((resolve) => {
			const onAbort = () => {
				// Only when this child is still genuinely waited on: a settled
				// (consumed) waiter must not resolve a second time.
				if (this.waiters.delete(childId)) resolve(null);
			};
			this.waiters.set(childId, (info) => {
				signal.removeEventListener("abort", onAbort);
				resolve(info);
			});
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort);
		});
	}

	dispose(): void {
		this.disposer();
	}
}

/** The record file path for a run under its workspace root. */
function recordPath(cwd: string, runId: string): string {
	return join(cwd, RUNS_DIR, runId + ".json");
}

/** True when the parsed record is the v2 firing-log shape (legacy v1 otherwise). */
function isV2Record(rec: RunRecord | LegacyRunRecord): rec is RunRecord {
	return (rec as RunRecord).recordVersion === 2;
}

/**
 * Parse one record file, or null when missing/corrupt (a bad file is skipped,
 * not fatal). Accepts BOTH record versions: v2 (the firing log) and legacy v1
 * (read-only — swept or finalized, never resurrected or run).
 */
async function readRecordFile(path: string): Promise<RunRecord | LegacyRunRecord | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const rec = parsed as RunRecord;
		if (typeof rec.runId !== "string" || typeof rec.cwd !== "string" || typeof rec.state !== "string") return null;
		if (rec.recordVersion === 2) {
			if (!Array.isArray(rec.firings)) return null;
			return rec;
		}
		// Legacy v1: the walk order + per-node status slots.
		const legacy = parsed as LegacyRunRecord;
		if (legacy.order === null || typeof legacy.order !== "object") return null;
		return legacy;
	} catch {
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
	readonly record: RunRecord;
	private readonly services: RunRegistryServices;
	private readonly canContinuable: boolean;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private readonly endWaiter: EndWaiter;
	/** The constructor-captured session agent; `resolveSessionAgent()` may
	 * refresh this when the registry's live agent differs (post-restart). */
	private sessionAgent: LiveAgentLike | undefined;
	private readonly onSettle: ((record: RunRecord) => void) | undefined;
	private controlWaiter: ((cmd: ControlCommand) => void) | null = null;
	private readonly listeners = new Set<(record: RunRecord) => void>();
	private coordinatorHandle: AgentHandleLike | null = null;
	/** The continuable child that may currently have a turn in flight (abort target). */
	private activeChildId: string | null = null;
	/** The firing any in-flight work is attributed to (executor-failure bookkeeping). */
	private currentFiringId: string | null = null;

	constructor(services: RunRegistryServices, record: RunRecord, options: { sessionAgent?: unknown; resume?: boolean; onSettle?: (record: RunRecord) => void } = {}) {
		this.services = services;
		this.record = record;
		this.canContinuable = continuableRuntime(services);
		this.signal = this.controller.signal;
		this.endWaiter = new EndWaiter(services.subscribeRunEnd);
		this.sessionAgent = options.sessionAgent !== undefined && options.sessionAgent !== null && typeof (options.sessionAgent as LiveAgentLike).id === "string"
			? (options.sessionAgent as LiveAgentLike)
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
				} catch (error) {
					this.services.logger.warn(`agent-pipeline: interrupting child "${childId}" failed: ${String(error)}`);
				}
			}
			this.postControl({ action: "abort" });
		});
		void this.run(options.resume === true).catch(() => { /* run() finalizes internally */ });
	}

	// ---- Control surface (called by the registry on behalf of routes) ----

	/** Whether the executor is parked at a pause point waiting for a command. */
	get awaitingControl(): boolean {
		return this.controlWaiter !== null;
	}

	/** Whether a steer command can currently be accepted for the paused firing. */
	canSteer(): boolean {
		if (!this.canContinuable) return false;
		const firing = this.pausedFiring();
		return firing !== null && typeof firing.childSessionId === "string" && firing.childSessionId.length > 0;
	}

	/** Deposit a command into the mailbox; false when the executor is not waiting. */
	postControl(cmd: ControlCommand): boolean {
		if (this.controlWaiter === null) return false;
		const resolve = this.controlWaiter;
		this.controlWaiter = null;
		resolve(cmd);
		return true;
	}

	/** Request abort from outside (control route): interrupt in-flight work and wake the loop. */
	abort(): void {
		this.controller.abort();
	}

	subscribe(fn: (record: RunRecord) => void): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	private pausedFiring(): RunFiring | null {
		const firingId = this.record.pausedAt;
		if (firingId === undefined) return null;
		return this.record.firings.find((f) => f.firingId === firingId) ?? null;
	}

	/** The next stable firing id: start-ordered, zero-padded ("f-001"…). */
	private nextFiringId(): string {
		return "f-" + String(this.record.firings.length + 1).padStart(3, "0");
	}

	/**
	 * Open a firing for `nodeId` and append it to the log: the node's first
	 * firing (`previous === null`, seq 1) or a re-firing superseding
	 * `previous` (Rerun — one past its seq, same verbatim input).
	 */
	private openFiring(nodeId: string, previous: RunFiring | null, input: string): RunFiring {
		const firing: RunFiring = {
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
	private adoptEpoch(firing: RunFiring, end: SubagentRunEndInfoLike): void {
		delete firing.error;
		firing.output = toText(end.lastAssistantMessage);
		firing.stopReason = end.stopReason;
		firing.settledAt = new Date().toISOString();
	}

	private awaitControl(): Promise<ControlCommand> {
		return new Promise((resolve) => { this.controlWaiter = resolve; });
	}

	/** Persist the record and notify subscribers. Call after every transition. */
	private async commit(): Promise<void> {
		this.record.updatedAt = new Date().toISOString();
		try {
			await mkdir(join(this.record.cwd, RUNS_DIR), { recursive: true });
			await writeAtomic(recordPath(this.record.cwd, this.record.runId), `${JSON.stringify(this.record, null, 2)}\n`);
		} catch (error) {
			this.services.logger.warn(`agent-pipeline: persisting run "${this.record.runId}" failed: ${String(error)}`);
		}
		for (const listener of this.listeners) {
			try { listener(this.record); } catch { /* a broken subscriber must not affect the run */ }
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
	private resolveSessionAgent(): LiveAgentLike | undefined {
		const live = this.services.agents.get(this.record.sessionId);
		if (live !== undefined && live !== null && typeof (live as LiveAgentLike).id === "string") {
			this.sessionAgent = live as LiveAgentLike;
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
	private coordinatorOptions(): Record<string, unknown> | undefined {
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
	private async ensureCoordinator(): Promise<LiveAgentLike> {
		const agents = this.services.agents;
		if (this.record.coordinatorSessionId !== undefined) {
			const live = agents.get(this.record.coordinatorSessionId);
			if (live !== undefined && live !== null && typeof (live as LiveAgentLike).id === "string") {
				return live as LiveAgentLike;
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
	private async releaseCoordinator(): Promise<void> {
		const handle = this.coordinatorHandle;
		this.coordinatorHandle = null;
		if (handle !== null) {
			try { await handle.dispose(); } catch (error) {
				this.services.logger.warn(`agent-pipeline: disposing the run coordinator failed: ${String(error)}`);
			}
		}
	}

	// ---- Execution ----

	/**
	 * Run one continuable epoch for `firing`: ensure the coordinator, start a
	 * FRESH child with the firing's verbatim prompt, dispose the coordinator
	 * immediately after acceptance, and await the child's first settlement.
	 * Returns the end info, or null when the run was aborted mid-flight.
	 */
	private async runContinuableEpoch(firing: RunFiring, agent: Agent, agentById: Map<string, Agent>, prompt: string): Promise<SubagentRunEndInfoLike | null> {
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
			} finally {
				// Dispose between operations: settlement notices to an absent
				// parent are dropped instead of burning a model turn.
				await this.releaseCoordinator();
			}
			firing.childSessionId = childId;
			this.activeChildId = childId;
			await this.commit();
			const end = await this.endWaiter.wait(childId, this.signal);
			return this.signal.aborted ? null : end;
		} catch (error) {
			if (this.signal.aborted) return null;
			throw error;
		} finally {
			this.activeChildId = null;
		}
	}

	/**
	 * Steer the paused firing's SAME child with user feedback and adopt the
	 * steering epoch's (epoch-relative) output into the firing. Throws on
	 * failure; the caller keeps the run paused so the user can retry or take
	 * another action.
	 */
	private async steerNode(firing: RunFiring, feedback: string): Promise<void> {
		const childId = firing.childSessionId as string;
		try {
			const coordinator = await this.ensureCoordinator();
			try {
				await steerContinuableAgent(this.services, {
					parent: coordinator,
					childId,
					feedback,
					signal: this.signal,
				});
			} finally {
				await this.releaseCoordinator();
			}
			this.activeChildId = childId;
			const end = await this.endWaiter.wait(childId, this.signal);
			if (this.signal.aborted) return;
			if (end !== null) {
				firing.output = toText(end.lastAssistantMessage);
				firing.stopReason = end.stopReason;
			}
		} finally {
			this.activeChildId = null;
		}
	}

	/**
	 * The paused control loop for a breakpointed node's firing. Returns true
	 * when the run should continue past the node ("resume"); false when it
	 * aborted. Rerun appends a NEW firing for the node (a fresh child started
	 * with the verbatim input; the superseded firing stays in the log with its
	 * parked output preserved) and parks again on the new one. Steer continues
	 * the SAME firing's child and returns to paused with the adopted output.
	 */
	private async pauseLoop(firing: RunFiring, agent: Agent, agentById: Map<string, Agent>, upstream: readonly string[], outputsById: Record<string, unknown>): Promise<boolean> {
		let current = firing;
		while (true) {
			current.status = "paused";
			this.record.state = "paused";
			this.record.pausedAt = current.firingId;
			// Arm the mailbox BEFORE the paused state becomes visible (the commit
			// persists + publishes it): a client that observes the record as
			// paused can never hit a window where its command is rejected.
			const cmdPromise = new Promise<ControlCommand>((resolve) => { this.controlWaiter = resolve; });
			await this.commit();
			const cmd = await cmdPromise;
			const nodeId = current.nodeId;
			if (cmd.action === "abort") return false;
			if (cmd.action === "resume") {
				current.status = "done";
				current.settledAt = new Date().toISOString();
				this.record.state = "running";
				delete this.record.pausedAt;
				await this.commit();
				return true;
			}
			if (cmd.action === "rerun") {
				let rerunFiring: RunFiring | null = null;
				try {
					if (this.canContinuable) {
						// Fresh child, verbatim original input — never steering content.
						rerunFiring = this.openFiring(nodeId, current, current.input as string);
						this.record.state = "running";
						this.currentFiringId = rerunFiring.firingId;
						await this.commit();
						const end = await this.runContinuableEpoch(rerunFiring, agent, agentById, rerunFiring.input as string);
						if (end === null) return false;
						this.adoptEpoch(rerunFiring, end);
						outputsById[nodeId] = rerunFiring.output;
					} else {
						// Degraded deployment: rerun as a fresh one-shot child. The
						// structured inputs are recomposed deterministically from the
						// immutable snapshot, so the prompt is the firing's input
						// verbatim. Without a live parent the SAME firing re-parks
						// with the error (nothing new started).
						const parent = this.resolveSessionAgent();
						if (parent === undefined) {
							current.status = "paused";
							current.error = "the session agent is not live — reopen the conversation, then rerun";
							this.services.logger.warn(`agent-pipeline: rerun of agent "${nodeId}" has no live session agent`);
							continue;
						}
						rerunFiring = this.openFiring(nodeId, current, current.input as string);
						this.record.state = "running";
						await this.commit();
						this.currentFiringId = rerunFiring.firingId;
						const inputs = agentInput(nodeId, { upstream: [...upstream], upstreamOutputs: outputsById, pipelineInput: this.record.input });
						const outcome = await runOneAgent(this.services, {
							agent,
							agentById,
							inputs,
							parent,
							signal: this.signal,
						});
						rerunFiring.settledAt = new Date().toISOString();
						if (this.signal.aborted) return false;
						if (outcome.error) {
							rerunFiring.error = outcome.error;
							rerunFiring.stopReason = outcome.stopReason;
						} else {
							delete rerunFiring.error;
							rerunFiring.output = outcome.output;
							rerunFiring.stopReason = outcome.stopReason;
							if (outcome.childSessionId !== undefined) rerunFiring.childSessionId = outcome.childSessionId;
							outputsById[nodeId] = rerunFiring.output;
						}
					}
				} catch (error) {
					if (this.signal.aborted) return false;
					if (rerunFiring !== null) {
						rerunFiring.status = "paused";
						rerunFiring.error = String(error);
					}
					this.services.logger.warn(`agent-pipeline: rerun of agent "${nodeId}" failed: ${String(error)}`);
				} finally {
					this.currentFiringId = null;
				}
				if (rerunFiring !== null) current = rerunFiring;
				continue; // back to paused — the user decides again
			}
			if (cmd.action === "steer") {
				this.currentFiringId = current.firingId;
				try {
					current.status = "running";
					// record.state stays "paused" with pausedAt intact: a crash or
					// restart mid-steer must resurrect the pause, not sweep the run.
					await this.commit();
					await this.steerNode(current, cmd.feedback);
					if (this.signal.aborted) return false;
					delete current.error;
					outputsById[nodeId] = current.output;
				} catch (error) {
					if (this.signal.aborted) return false;
					current.error = String(error);
					this.services.logger.warn(`agent-pipeline: steering agent "${nodeId}" failed: ${String(error)}`);
				} finally {
					this.currentFiringId = null;
				}
				continue; // still paused with the adopted output
			}
		}
	}

	/**
	 * Mark every in-flight or parked firing aborted (its output preserved — a
	 * paused firing never released its output into the pipeline flow), keep
	 * completed firings as they are, and finalize.
	 */
	private async finalizeAborted(): Promise<void> {
		const now = new Date().toISOString();
		for (const firing of this.record.firings) {
			if (firing.status === "running" || firing.status === "paused") firing.status = "aborted";
			if (firing.status === "aborted" && firing.settledAt === undefined) firing.settledAt = now;
		}
		this.record.state = "aborted";
		delete this.record.pausedAt;
		await this.releaseCoordinator();
		await this.commit();
		this.onSettle?.(this.record);
	}

	private async finalizeCompleted(): Promise<void> {
		this.record.state = "completed";
		delete this.record.pausedAt;
		await this.releaseCoordinator();
		await this.commit();
		this.onSettle?.(this.record);
	}

	/** The executor's main loop: the topological walk, one firing per start. */
	private async run(resumeFromPause: boolean): Promise<void> {
		try {
			const record = this.record;
			const classified = classifyGraph(record.graph);
			const agentById = new Map<string, Agent>();
			for (const agent of record.graph?.agents ?? []) {
				if (agent != null && agent.id != null) agentById.set(String(agent.id), agent);
			}
			// The walk order is derived from the immutable snapshot — deterministic,
			// so a resurrected executor re-derives exactly the order it followed.
			const order = topoOrder(record.graph);
			// Rebuild downstream inputs from the projection: every node with an
			// adopted output (done nodes, and the paused node's current output).
			const projected = projectNodes(record);
			const outputsById: Record<string, unknown> = {};
			for (const id of projected.order) {
				const node = projected.nodes[id];
				if ((node.status === "done" || node.status === "paused") && typeof node.output === "string") {
					outputsById[id] = node.output;
				}
			}

			const pausedFiring = resumeFromPause ? projected.pausedFiring : undefined;
			const pausedIndex = pausedFiring !== undefined ? order.indexOf(pausedFiring.nodeId) : -1;

			for (let i = 0; i < order.length; i++) {
				if (this.signal.aborted) break;
				const id = order[i];
				const agent = agentById.get(id);
				if (agent === undefined) continue;
				// Done nodes never re-fire (the log is the truth).
				if (projected.nodes[id]?.status === "done") continue;
				// A resurrected executor must not re-run anything before the pause.
				if (pausedIndex >= 0 && i < pausedIndex) continue;

				if (pausedIndex === i) {
					// Resurrected at the pause point: re-enter the control wait
					// on the paused firing, running nothing.
					if (!(await this.pauseLoop(pausedFiring as RunFiring, agent, agentById, classified.upstream[id] ?? [], outputsById))) break;
					continue;
				}

				// Open the node's firing: compose the input ONCE — immutable for
				// the run's lifetime; every re-firing repeats it verbatim.
				const upstream = classified.upstream[id] ?? [];
				const inputs = agentInput(id, { upstream, upstreamOutputs: outputsById, pipelineInput: record.input });
				const firing = this.openFiring(id, null, agentPrompt(agent, inputs, agentById));
				await this.commit();

				this.currentFiringId = firing.firingId;
				try {
					const useContinuable = this.canContinuable && agent.breakpoint === true;
					if (useContinuable) {
						const end = await this.runContinuableEpoch(firing, agent, agentById, firing.input as string);
						if (end === null) break;
						this.adoptEpoch(firing, end);
						outputsById[id] = firing.output;
						await this.commit();
						// Breakpoint armed (useContinuable implies breakpoint): park.
						if (!(await this.pauseLoop(firing, agent, agentById, upstream, outputsById))) break;
						continue;
					}

					// One-shot path (non-breakpointed, or breakpoints degraded).
					const parent = this.resolveSessionAgent();
					if (parent === undefined) {
						// Typed failure instead of a harness TypeError: the session
						// agent is not (yet) live — matches the runner's
						// continue-on-error semantics for the remaining nodes.
						firing.status = "error";
						firing.error = "the session agent is not live — reopen the conversation and start a new run";
						firing.settledAt = new Date().toISOString();
						await this.commit();
						continue;
					}
					const outcome = await runOneAgent(this.services, { agent, agentById, inputs, parent, signal: this.signal });
					firing.settledAt = new Date().toISOString();
					if (this.signal.aborted) {
						firing.status = "aborted";
						firing.stopReason = outcome.stopReason;
						break;
					}
					if (outcome.error) {
						// Runner parity: a failed agent is recorded, the loop continues.
						firing.status = "error";
						firing.error = outcome.error;
						firing.stopReason = outcome.stopReason;
					} else {
						firing.status = "done";
						delete firing.error;
						firing.output = outcome.output;
						firing.stopReason = outcome.stopReason;
						if (outcome.childSessionId !== undefined) firing.childSessionId = outcome.childSessionId;
						outputsById[id] = outcome.output;
					}
					await this.commit();
					// Degraded breakpoints still pause (steering unavailable; the
					// pause loop's rerun works, its steer is rejected upstream).
					if (agent.breakpoint === true && this.canContinuable !== true) {
						if (!(await this.pauseLoop(firing, agent, agentById, upstream, outputsById))) break;
					}
				} finally {
					this.currentFiringId = null;
				}
			}

			if (this.signal.aborted) await this.finalizeAborted();
			else await this.finalizeCompleted();
		} catch (error) {
			// Unforeseen executor failure: record it on the firing in flight
			// (when one is attributable) and finalize as an errored run.
			this.services.logger.warn(`agent-pipeline: run "${this.record.runId}" executor failed: ${String(error)}`);
			if (this.currentFiringId !== null) {
				const firing = this.record.firings.find((f) => f.firingId === this.currentFiringId);
				if (firing !== undefined) {
					firing.status = "error";
					firing.error = String(error);
					if (firing.settledAt === undefined) firing.settledAt = new Date().toISOString();
				}
			}
			try {
				this.record.state = "error";
				delete this.record.pausedAt;
				await this.releaseCoordinator();
				await this.commit();
				this.onSettle?.(this.record);
			} catch (commitError) {
				this.services.logger.warn(`agent-pipeline: run "${this.record.runId}" could not persist its failure: ${String(commitError)}`);
			}
		} finally {
			this.endWaiter.dispose();
		}
	}
}

/** Where a control action may be routed. */
export type ControlOutcome = { ok: true } | { ok: false; error: string };

/**
 * The per-workspace run registry: starts executors, lazily loads and sweeps
 * persisted records, and routes control commands. One registry per plugin
 * fiber; one active (running|paused) run per workspace.
 */
export class RunRegistry {
	private readonly services: RunRegistryServices;
	private readonly executors = new Map<string, RunExecutor>();

	constructor(services: RunRegistryServices) {
		this.services = services;
	}

	/** Drop in-memory executor state. Used on plugin unload: records on disk are
	 * intentionally left untouched so a paused run survives the unload exactly
	 * like a process death (the restart sweep resurrects it). */
	dispose(): void {
		this.executors.clear();
	}

	/**
	 * Start a new run: validate, enforce the single-active-run rule (in-memory
	 * AND on disk), create the record, and start the executor. Returns the
	 * runId immediately — the browser follows the record over SSE.
	 */
	async startRun(request: { sessionId: string; cwd: string; graph?: PipelineGraph | null; input?: unknown }): Promise<{ ok: true; runId: string } | { ok: false; error: string; activeRunId?: string }> {
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

		const now = new Date().toISOString();
		// The executor derives its walk order from the immutable snapshot; the
		// firing log fills as nodes fire. Per-node control state is empty until
		// per-node parent anchors land.
		const record: RunRecord = {
			runId: randomUUID(),
			cwd,
			sessionId,
			createdAt: now,
			updatedAt: now,
			state: "running",
			graph,
			...(request.input === undefined ? {} : { input: request.input }),
			recordVersion: 2,
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
	 * The workspace's active run record, lazily loading (and sweeping /
	 * resurrecting) from disk when no executor is in memory. Returns null when
	 * the workspace has no active run.
	 */
	async activeRunForCwd(cwd: unknown): Promise<RunRecord | null> {
		if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return null;
		let best: RunRecord | null = null;
		for (const executor of this.executors.values()) {
			const rec = executor.record;
			if (rec.cwd !== cwd) continue;
			if (rec.state !== "running" && rec.state !== "paused") continue;
			if (best === null || rec.updatedAt > best.updatedAt) best = rec;
		}
		if (best !== null) return best;
		return this.loadFromDisk(cwd);
	}

	/**
	 * One run's full record: in-memory when an executor holds it, else from
	 * disk under `cwd` (loading/sweeping the workspace first, so a stale
	 * running record is swept and a paused one resurrected before it is read).
	 * A legacy v1 record is served read-only.
	 */
	async getRun(runId: unknown, cwd?: unknown): Promise<RunRecord | LegacyRunRecord | null> {
		if (typeof runId !== "string" || runId.length === 0) return null;
		const executor = this.executors.get(runId);
		if (executor !== undefined) return executor.record;
		if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return null;
		const active = await this.loadFromDisk(cwd);
		if (active !== null && active.runId === runId) return active;
		return readRecordFile(recordPath(cwd, runId));
	}

	/**
	 * Subscribe to a run's transitions. Returns a disposer, or null when the
	 * run has no live executor (a terminal record will never update again).
	 */
	subscribe(runId: unknown, fn: (record: RunRecord) => void): (() => void) | null {
		if (typeof runId !== "string" || runId.length === 0) return null;
		const executor = this.executors.get(runId);
		if (executor === undefined) return null;
		return executor.subscribe(fn);
	}

	/**
	 * Route a control command to a run. `resume`/`rerun`/`steer` are accepted
	 * only while the run is parked at a pause point; `abort` is accepted any
	 * time the run is still active. `cwd` is the workspace hint that lets a
	 * paused record surviving a profile restart be loaded (swept + resurrected)
	 * before the command is routed.
	 */
	async control(runId: unknown, request: { action?: unknown; feedback?: unknown }, cwd?: unknown): Promise<ControlOutcome> {
		if (typeof runId !== "string" || runId.length === 0) return { ok: false, error: "missing runId" };
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
		const posted = live.postControl(action === "steer" ? { action: "steer", feedback: request.feedback as string } : { action });
		return posted ? { ok: true } : { ok: false, error: "the run is not paused at a breakpoint" };
	}

	/**
	 * Lazy per-workspace load: sweep stale `running` records to `aborted`
	 * (their executor died with the previous process), resurrect `paused`
	 * records as controllable executors, and return the newest active record
	 * (or null). In-memory executors always win over their disk copies.
	 */
	private async loadFromDisk(cwd: string): Promise<RunRecord | null> {
		let entries: string[];
		try {
			entries = await readdir(join(cwd, RUNS_DIR));
		} catch {
			return null; // no runs directory yet
		}
		let best: RunRecord | null = null;
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const rec = await readRecordFile(join(cwd, RUNS_DIR, entry));
			if (rec === null || rec.cwd !== cwd) continue;
			if (this.executors.has(rec.runId)) continue; // in-memory state is fresher
			if (rec.state === "running" || rec.state === "paused") {
				await this.sweepOrResurrect(rec);
			}
			if (rec.state === "running" || rec.state === "paused") {
				if (best === null || rec.updatedAt > best.updatedAt) best = rec as RunRecord;
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
	private async sweepOrResurrect(rec: RunRecord | LegacyRunRecord): Promise<void> {
		if (isV2Record(rec)) {
			if (rec.state === "running") {
				const now = new Date().toISOString();
				for (const firing of rec.firings) {
					if (firing.status === "running") { firing.status = "aborted"; firing.settledAt = now; }
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
			// through the cold-resumed coordinator even when it is not live.
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
			if (node === undefined) continue;
			if (node.status === "running") node.status = "aborted";
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
	private async persistSwept(rec: RunRecord | LegacyRunRecord): Promise<void> {
		try {
			await writeAtomic(recordPath(rec.cwd, rec.runId), `${JSON.stringify(rec, null, 2)}\n`);
		} catch (error) {
			this.services.logger.warn(`agent-pipeline: sweeping stale run "${rec.runId}" failed: ${String(error)}`);
		}
	}
}
