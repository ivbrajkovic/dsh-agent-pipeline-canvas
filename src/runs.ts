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
// Firings run CONCURRENTLY as separate Harness children, capped by the run's
// `maxInFlight` (default 4); ready firings start in deterministic node-id
// order. The run ends at quiescence — nothing in flight, nothing fireable —
// with never-fired nodes reported. The record is the firing log (recordVersion
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
// per-firing error attribution), the pause FIFO for the control plane, and a
// COMMIT WRITER — every record mutation flows through one chained
// transition() so concurrent firings cannot interleave atomic writes.
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
// turn is never cancelled to pause) — and the firing parks in the executor's
// pause FIFO, awaiting a control command on an event-driven mailbox (no
// timers). The queue head owns the record's `pausedAt` pointer:
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
// found in `paused` is resurrected as a fully controllable executor that
// re-enters the control wait without re-running anything (nodes the log marks
// done never re-fire). One run is active (running|paused) per workspace:
// enforced in-memory and re-checked on disk.

import { mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomic } from "./storage.ts";
import { validateGraph } from "./graph.ts";
import { agentInput, agentPrompt, cmp, portGraph, renderValue } from "./execution.ts";
import { projectNodes, type NodeProjection } from "./projection.ts";
import {
	Kernel,
	SOURCE_NODE_ID,
	normalizeMaxInFlight,
	type KernelDrop,
	type KernelMessage,
} from "./kernel.ts";
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
import type {
	Agent,
	AgentExecutionInput,
	LegacyRunRecord,
	PipelineGraph,
	PortGraph,
	RunFiring,
	RunRecord,
} from "./types.ts";

const RUNS_DIR = ".agent-pipeline/runs";

// ---- Minimal, structural views of the harness services the registry touches ----
// Same discipline as runner.ts: standalone zero-dep plugin, so only the fields
// actually called are named; the real services satisfy the shapes structurally.

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
	agents: AnchorAgentsService;
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
 * continuable child id, and the unmatched buffer is kept whole (eviction could
 * drop a settlement its firing still needs).
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
			// Not (yet) waited on — keep it for a later wait(). Uncapped on
			// purpose: entries are tiny and bounded by the run's settlement
			// count, and evicting the oldest could drop a settlement that its
			// firing is still about to wait on (a lost epoch would stall the
			// run — abort would be the only recovery).
			this.buffered.set(childId, info);
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

/**
 * One parked breakpoint: a settled-but-unresolved firing awaiting the user's
 * Resume / Rerun / Steer / Abort. Settled breakpoints queue FIFO; the queue
 * head owns the control mailbox and the record's `pausedAt` pointer.
 */
interface PauseEntry {
	/** The live firing this entry parks on (Rerun swaps in the fresh one). */
	firing: RunFiring;
	agent: Agent;
	agentById: Map<string, Agent>;
	/** The firing's composed input, keyed — the degraded Rerun reframes it. */
	inputs: AgentExecutionInput;
	/** Resolves when the entry becomes the queue head. */
	turn: Promise<void>;
	openTurn: () => void;
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
 * One run's executor fiber: drives the firing kernel (kernel.ts), mutates the
 * record through the chained commit writer, persists every transition, and
 * awaits control commands while parked at a breakpoint. The fiber finishes
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
	/** Live parent-anchor handles by node id — each held ONLY inside its own
	 * node's admission (the withAnchor bracket), disposed after. */
	private readonly anchorHandles = new Map<string, AgentHandleLike>();
	/**
	 * Per-node admission serialization: admissions of the SAME node queue on
	 * this chain so each holds the anchor alone (created → admitted → disposed
	 * before the next begins), while different nodes admit fully concurrently —
	 * branches never touch each other's anchors, so there is no shared handle
	 * to race. Unreachable today (a parked breakpoint closes the halt gate
	 * before its node could re-fire), but a cyclic graph could re-feed a node
	 * while its firing is in flight, so same-node admissions stay safe anyway.
	 */
	private readonly anchorChain = new Map<string, Promise<void>>();
	/** The continuable children that may have a turn in flight, keyed to their
	 * node (the abort interrupt authorizes against the NODE's anchor id). */
	private readonly inFlightChildren = new Map<string, string>();
	/** The kernel — created at the top of run(); notify() wakes its main loop. */
	private kernel: Kernel | null = null;
	/**
	 * The commit writer's chain: every record mutation queues through
	 * transition(), so concurrent firings can never interleave their atomic
	 * writes (two free-running commits could race a stale snapshot into the
	 * file). Mutators are synchronous by contract.
	 */
	private writeChain: Promise<void> = Promise.resolve();
	/** The parked-breakpoint FIFO (settle order); the head owns the mailbox. */
	private readonly pauseQueue: PauseEntry[] = [];
	/** Live NodeRunner tasks; finalization drains them before its own writes. */
	private readonly runners = new Set<Promise<void>>();

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
					} catch (error) {
						this.services.logger.warn(`agent-pipeline: interrupting child "${childId}" failed: ${String(error)}`);
					}
				}
			}
			this.postControl({ action: "abort" });
			this.kernel?.notify();
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

	// ---- The commit writer ---------------------------------------------------

	/**
	 * Every record mutation flows through one chained transition (executor
	 * spec §6): the synchronous mutation runs inside the chain and the
	 * persist+notify rides the SAME chain — concurrent firings queue behind
	 * each other instead of interleaving atomic renames. Mutators must be
	 * synchronous so no other mutation can run between their read and write.
	 */
	private transition<R>(mutate: () => R): Promise<R> {
		const applied = this.writeChain.then(mutate);
		this.writeChain = applied.then(
			() => this.commit(),
			() => this.commit(),
		);
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
	private transitionQuiet<R>(mutate: () => R): Promise<R> {
		const applied = this.writeChain.then(mutate);
		this.writeChain = applied.then(
			() => undefined,
			() => undefined,
		);
		return applied;
	}

	/** Persist the record and notify subscribers. Call only inside the chain. */
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

	/** Append bound-overflow records (design principle 4) through the writer. */
	private async recordDrops(drops: readonly KernelDrop[]): Promise<void> {
		if (drops.length === 0) return;
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
	private resolveSessionAgent(): LiveAgentLike | undefined {
		const live = this.services.agents.get(this.record.sessionId);
		if (live !== undefined && live !== null && typeof (live as LiveAgentLike).id === "string") {
			this.sessionAgent = live as LiveAgentLike;
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
	private anchorOptions(): Record<string, unknown> | undefined {
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
	private async withAnchor<T>(nodeId: string, admit: (anchor: LiveAgentLike) => Promise<T>): Promise<T> {
		const prior = this.anchorChain.get(nodeId) ?? Promise.resolve();
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => { open = resolve; });
		this.anchorChain.set(nodeId, prior.then(() => gate));
		await prior;
		try {
			const anchor = await this.ensureAnchor(nodeId);
			try {
				return await admit(anchor);
			} finally {
				await this.releaseAnchor(nodeId);
			}
		} finally {
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
	private async ensureAnchor(nodeId: string): Promise<LiveAgentLike> {
		// Adopt-or-create runs INSIDE the write chain, so two nodes can never
		// both claim a pre-P4 record's one shared coordinator id: the first
		// adoption deletes the field atomically with its seed; the second sees
		// neither and creates a fresh anchor of its own.
		const persisted = await this.transition(() => {
			const existing = this.record.nodes[nodeId]?.parentAnchorSessionId;
			if (existing !== undefined) return existing;
			// A record written before per-node anchors carried ONE shared
			// coordinator id for all continuable nodes. Adopt it as this node's
			// anchor — it is the durable address the node's already-parented
			// children authorize against — and retire the shared field.
			const legacy = (this.record as { coordinatorSessionId?: string }).coordinatorSessionId;
			if (typeof legacy === "string" && legacy.length > 0) {
				this.record.nodes[nodeId] = { parentAnchorSessionId: legacy };
				delete (this.record as { coordinatorSessionId?: string }).coordinatorSessionId;
				return legacy;
			}
			return undefined;
		});
		if (persisted !== undefined) return this.liveOrResumedAnchor(nodeId, persisted);
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
	private async liveOrResumedAnchor(nodeId: string, anchorId: string): Promise<LiveAgentLike> {
		const live = this.services.agents.get(anchorId);
		if (live !== undefined && live !== null && typeof (live as LiveAgentLike).id === "string") {
			return live as LiveAgentLike;
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
	private async releaseAnchor(nodeId: string): Promise<void> {
		const handle = this.anchorHandles.get(nodeId);
		if (handle === undefined) return;
		this.anchorHandles.delete(nodeId);
		try { await handle.dispose(); } catch (error) {
			this.services.logger.warn(`agent-pipeline: disposing node "${nodeId}"'s parent anchor failed: ${String(error)}`);
		}
	}

	/** Dispose every retained anchor handle (finalization's last touch). */
	private async releaseAllAnchors(): Promise<void> {
		for (const nodeId of [...this.anchorHandles.keys()]) {
			await this.releaseAnchor(nodeId);
		}
	}

	// ---- Per-firing primitives -------------------------------------------------

	/** The next stable firing id: start-ordered, zero-padded ("f-001"…). */
	private nextFiringId(): string {
		return "f-" + String(this.record.firings.length + 1).padStart(3, "0");
	}

	/**
	 * Open a firing for `nodeId` and append it to the log: the node's first
	 * firing (`previous === null`, seq 1) or a re-firing superseding
	 * `previous` (Rerun — one past its seq, same verbatim input). Call inside
	 * a transition so concurrent starts cannot interleave id assignment.
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

	/**
	 * Run one continuable epoch for `firing`: admit it under the NODE's parent
	 * anchor (held live only for the admission), start a FRESH child with the
	 * firing's verbatim prompt, and await the child's first settlement.
	 * Returns the end info, or null when the run was aborted mid-flight.
	 */
	private async runContinuableEpoch(firing: RunFiring, agent: Agent, agentById: Map<string, Agent>, prompt: string): Promise<SubagentRunEndInfoLike | null> {
		let childId = "";
		try {
			({ childId } = await this.withAnchor(firing.nodeId, (anchor) =>
				startContinuableAgent(this.services, {
					agent,
					agentById,
					prompt,
					parent: anchor,
					signal: this.signal,
				})));
		} catch (error) {
			if (this.signal.aborted) return null;
			throw error;
		}
		this.inFlightChildren.set(childId, firing.nodeId);
		try {
			await this.transition(() => { firing.childSessionId = childId; });
			const end = await this.endWaiter.wait(childId, this.signal);
			return this.signal.aborted ? null : end;
		} finally {
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
	private async steerNode(firing: RunFiring, feedback: string): Promise<void> {
		const childId = firing.childSessionId as string;
		await this.withAnchor(firing.nodeId, (anchor) =>
			steerContinuableAgent(this.services, {
				parent: anchor,
				childId,
				feedback,
				signal: this.signal,
			}));
		this.inFlightChildren.set(childId, firing.nodeId);
		try {
			const end = await this.endWaiter.wait(childId, this.signal);
			if (this.signal.aborted) return;
			if (end !== null) {
				await this.transitionQuiet(() => {
					firing.output = toText(end.lastAssistantMessage);
					firing.stopReason = end.stopReason;
				});
			}
		} finally {
			this.inFlightChildren.delete(childId);
		}
	}

	// ---- The pause FIFO (the control plane's parked side) ----------------------

	/**
	 * Park a settled breakpointed firing and drive its control loop until the
	 * run moves past it (returns the released firing — Rerun may have replaced
	 * it) or the run aborts (returns null). Grouped pause: the halt gate closes
	 * when the first breakpoint parks and opens when the last one releases, so
	 * in-flight firings finish while nothing new starts anywhere. Concurrent
	 * settlements queue; the head owns the mailbox and `pausedAt`; releasing it
	 * surfaces the next (the full crash-safe queue rebuild is P5).
	 */
	private async pauseAt(initial: RunFiring, agent: Agent, agentById: Map<string, Agent>, inputs: AgentExecutionInput): Promise<RunFiring | null> {
		let openTurn: () => void = () => {};
		const turn = new Promise<void>((resolve) => { openTurn = resolve; });
		const entry: PauseEntry = { firing: initial, agent, agentById, inputs, turn, openTurn };
		this.pauseQueue.push(entry);
		this.kernel?.setHalted(true);
		// Park the firing in the LOG as soon as it parks — not only when it
		// becomes the queue head — so a queued-but-unresolved breakpoint is
		// never mistaken for work in flight and a crash leaves an expressive
		// log for P5's queue rebuild. This commits while `state` is still
		// "running", so the park invariant (observing paused ⇒ armed mailbox)
		// is untouched.
		await this.transition(() => { initial.status = "paused"; });
		try {
			while (true) {
				if (this.pauseQueue[0] !== entry) {
					await entry.turn;
					continue;
				}
				if (this.signal.aborted) {
					this.retireEntry(entry);
					return null;
				}
				const current = entry.firing;
				// Arm the mailbox BEFORE the paused state becomes visible (the
				// transition persists + publishes it): a client that observes the
				// record as paused can never hit a window where its command is
				// rejected.
				const cmdPromise = new Promise<ControlCommand>((resolve) => { this.controlWaiter = resolve; });
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
						} else {
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
		} catch (error) {
			// The park itself failed: retire the entry so the halt gate can
			// never stay closed on its account, then rethrow — the NodeRunner
			// attributes the failure to the firing.
			this.retireEntry(entry);
			throw error;
		}
	}

	/**
	 * Remove a parked entry from the queue. Returns the entry that becomes the
	 * head next (whose turn this resolves); when none remains, the halt gate
	 * opens. The caller moves `pausedAt`/`state` in its own transition.
	 */
	private retireEntry(entry: PauseEntry): PauseEntry | undefined {
		const index = this.pauseQueue.indexOf(entry);
		if (index !== -1) this.pauseQueue.splice(index, 1);
		const next = this.pauseQueue[0];
		if (next !== undefined) next.openTurn();
		else this.kernel?.setHalted(false);
		return next;
	}

	/**
	 * Rerun the head firing: a FRESH child (new child id; the superseded
	 * firing stays in the log with its parked output preserved) started with
	 * the verbatim original input — never steering content. After the fresh
	 * epoch settles (or fails), the entry parks again on the new firing.
	 */
	private async rerunPaused(entry: PauseEntry): Promise<void> {
		const current = entry.firing;
		const nodeId = current.nodeId;
		let rerunFiring: RunFiring | null = null;
		try {
			if (this.canContinuable) {
				// state flips to "running" while the fresh epoch is in flight —
				// the record must not read paused while the mailbox is disarmed
				// (the park invariant), and P2 did exactly this.
				rerunFiring = await this.transition(() => {
					const firing = this.openFiring(nodeId, current, current.input as string);
					this.record.state = "running";
					return firing;
				});
				entry.firing = rerunFiring;
				this.kernel?.beginFiring(nodeId);
				try {
					const end = await this.runContinuableEpoch(rerunFiring, entry.agent, entry.agentById, rerunFiring.input as string);
					if (end === null) return; // aborted; finalization owns the record
					await this.transitionQuiet(() => { this.adoptEpoch(rerunFiring as RunFiring, end); });
				} finally {
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
				const firing = this.openFiring(nodeId, current, current.input as string);
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
				if (this.signal.aborted) return;
				await this.transitionQuiet(() => {
					const firing = rerunFiring as RunFiring;
					firing.settledAt = new Date().toISOString();
					if (outcome.error) {
						firing.error = outcome.error;
						firing.stopReason = outcome.stopReason;
					} else {
						delete firing.error;
						firing.output = outcome.output;
						firing.stopReason = outcome.stopReason;
						if (outcome.childSessionId !== undefined) firing.childSessionId = outcome.childSessionId;
					}
				});
			} finally {
				this.kernel?.endFiring(nodeId);
			}
		} catch (error) {
			if (this.signal.aborted) return;
			if (rerunFiring !== null) {
				await this.transitionQuiet(() => {
					const firing = rerunFiring as RunFiring;
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
	private async steerPaused(entry: PauseEntry, feedback: string): Promise<void> {
		const current = entry.firing;
		try {
			await this.steerNode(current, feedback);
			await this.transitionQuiet(() => { delete current.error; });
		} catch (error) {
			if (this.signal.aborted) return;
			await this.transitionQuiet(() => { current.error = String(error); });
			this.services.logger.warn(`agent-pipeline: steering agent "${current.nodeId}" failed: ${String(error)}`);
		}
	}

	// ---- The NodeRunner and the kernel driver ----------------------------------

	/**
	 * Emit a terminal firing's output into the kernel (P3 emission is
	 * non-selective — every output port), recording any bound overflows.
	 * A firing without an output emits nothing — downstream starves and is
	 * reported at quiescence (P3 records failures without gating; fail-fast
	 * arrives in P6).
	 */
	private async emitOutput(nodeId: string, firing: RunFiring): Promise<void> {
		if (typeof firing.output !== "string") return;
		const drops = this.kernel?.emit(nodeId, firing.output) ?? [];
		await this.recordDrops(drops);
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
	private async runFiring(nodeId: string, messages: readonly KernelMessage[], agentById: Map<string, Agent>): Promise<void> {
		const agent = agentById.get(nodeId);
		if (agent === undefined) return; // unreachable: the kernel only knows graph agents
		const upstream = [...new Set(messages.map((message) => message.from))].sort(cmp);
		const upstreamOutputs: Record<string, unknown> = {};
		for (const message of messages) upstreamOutputs[message.from] = message.output;
		const inputs = agentInput(nodeId, { upstream, upstreamOutputs, pipelineInput: this.record.input });
		const prompt = agentPrompt(agent, inputs, agentById);
		let firing: RunFiring;
		try {
			firing = await this.transition(() => {
				// seq is per-node: a node that re-fires from the stream (a
				// cycle, or any-of fed twice) continues its firing number the
				// same way a Rerun does.
				const log = this.record.firings;
				let previous: RunFiring | null = null;
				for (let i = log.length - 1; i >= 0; i--) {
					if (log[i].nodeId === nodeId) { previous = log[i]; break; }
				}
				return this.openFiring(nodeId, previous, prompt);
			});
		} catch (error) {
			this.services.logger.warn(`agent-pipeline: opening a firing for "${nodeId}" failed: ${String(error)}`);
			return;
		}
		try {
			const useContinuable = this.canContinuable && agent.breakpoint === true;
			if (useContinuable) {
				const end = await this.runContinuableEpoch(firing, agent, agentById, prompt);
				if (end === null) return; // aborted mid-flight; finalization marks the firing
				await this.transition(() => { this.adoptEpoch(firing, end); });
			} else {
				const parent = this.resolveSessionAgent();
				if (parent === undefined) {
					// Typed failure instead of a harness TypeError: the session
					// agent is not (yet) live. Recorded on the firing; it emits
					// nothing.
					await this.transition(() => {
						firing.status = "error";
						firing.error = "the session agent is not live — reopen the conversation and start a new run";
						firing.settledAt = new Date().toISOString();
					});
					return;
				}
				const outcome = await runOneAgent(this.services, { agent, agentById, inputs, parent, signal: this.signal });
				if (this.signal.aborted) return; // finalization marks the firing aborted
				await this.transition(() => {
					firing.settledAt = new Date().toISOString();
					if (outcome.error) {
						firing.status = "error";
						firing.error = outcome.error;
						firing.stopReason = outcome.stopReason;
					} else {
						firing.status = "done";
						delete firing.error;
						firing.output = outcome.output;
						firing.stopReason = outcome.stopReason;
						if (outcome.childSessionId !== undefined) firing.childSessionId = outcome.childSessionId;
					}
				});
				// Degraded breakpoints still park (steering unavailable; the
				// park's rerun works, its steer is rejected upstream) — even on
				// an errored outcome, exactly as the sequential executor did.
				if (outcome.error && agent.breakpoint !== true) return; // P3: recorded, not gating (fail-fast is P6)
			}
			if (agent.breakpoint === true) {
				const released = await this.pauseAt(firing, agent, agentById, inputs);
				if (released === null) return;
				firing = released; // Rerun replaced the firing; the release emits ITS output
			}
			await this.emitOutput(nodeId, firing);
		} catch (error) {
			if (this.signal.aborted) return;
			await this.transition(() => {
				firing.status = "error";
				firing.error = String(error);
				if (firing.settledAt === undefined) firing.settledAt = new Date().toISOString();
			});
			this.services.logger.warn(`agent-pipeline: firing of agent "${nodeId}" failed: ${String(error)}`);
		}
	}

	/**
	 * The keyed inputs for a RESURRECTED firing's degraded Rerun, recomposed
	 * from the log (the sequential executor's restart parity): the wired
	 * upstream sources with their projected outputs. Every source of a fired
	 * all-of firing produced an output, so this reframes to the firing's
	 * recorded input verbatim.
	 */
	private resurrectedInputs(nodeId: string, graph: PortGraph, projected: NodeProjection): AgentExecutionInput {
		const upstream = [...new Set(graph.byId[nodeId]?.inputs.flatMap((port) => port.sources) ?? [])].sort(cmp);
		const upstreamOutputs: Record<string, unknown> = {};
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
	 * runner drained, no park queued — only a crash mid-control-op can leave
	 * one) and are marked aborted in EVERY terminal kind, EXCEPT the superseded
	 * parked firings a Rerun left behind: those keep `paused` as the honest
	 * decision history the P2 record pins. Aborted and parked outputs are
	 * preserved.
	 */
	private async finalize(kind: "completed" | "aborted" | "error"): Promise<void> {
		await Promise.allSettled([...this.runners]);
		await this.writeChain;
		await this.transition(() => {
			const now = new Date().toISOString();
			for (const firing of this.record.firings) {
				if (firing.status === "running" || firing.status === "paused") {
					const superseded = this.record.firings.some((later) => later.nodeId === firing.nodeId && later.seq > firing.seq);
					if (!superseded) firing.status = "aborted";
				}
				if (firing.status === "aborted" && firing.settledAt === undefined) firing.settledAt = now;
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

	private async finalizeCompleted(projected: NodeProjection, noRefire: ReadonlySet<string>): Promise<void> {
		// Quiescence with starving nodes is a surfaced outcome, never a silent
		// skip (design principle 3): the report names every node that never
		// fired and can no longer fire — minus nodes the log already satisfied
		// before a restart.
		const waiting = (this.kernel?.starvingCandidates() ?? []).filter((id) => {
			if (noRefire.has(id)) return false;
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
	private async run(resumeFromPause: boolean): Promise<void> {
		try {
			const record = this.record;
			const graph = portGraph(record.graph);
			const kernel = new Kernel(graph, { maxInFlight: record.maxInFlight });
			this.kernel = kernel;
			const agentById = new Map<string, Agent>();
			for (const agent of record.graph?.agents ?? []) {
				if (agent != null && agent.id != null) agentById.set(String(agent.id), agent);
			}
			const projected = projectNodes(record);
			// Restart guards: nodes whose projected status is done/paused never
			// re-fire from kernel messages — the log is the truth. (P5's
			// pending-pause queue owns crash-safe reconstruction of the kernel
			// queues; until then a resumed run flows only post-resume messages.)
			const noRefire = new Set<string>();
			if (resumeFromPause) {
				for (const id of projected.order) {
					const status = projected.nodes[id]?.status;
					if (status === "done" || status === "paused") noRefire.add(id);
				}
			}

			if (resumeFromPause && projected.pausedFiring !== undefined) {
				// Resurrected at the pause point: re-enter the control wait on
				// the paused firing, running nothing. Nothing is in flight in a
				// fresh process, so this park is the whole pause queue.
				const pausedFiring = projected.pausedFiring;
				const agent = agentById.get(pausedFiring.nodeId);
				if (agent !== undefined) {
					const inputs = this.resurrectedInputs(pausedFiring.nodeId, graph, projected);
					const released = await this.pauseAt(pausedFiring, agent, agentById, inputs);
					if (released !== null) await this.emitOutput(pausedFiring.nodeId, released);
				}
			} else if (!resumeFromPause && !this.signal.aborted) {
				// The SOURCE (stream model): the run input emits once to every
				// wired root — a node with no incoming edges is source-fed on
				// all of its ports.
				const sourceMessage: KernelMessage = { from: SOURCE_NODE_ID, output: renderValue(record.input) };
				const drops: KernelDrop[] = [];
				for (const id of graph.ids) {
					const node = graph.byId[id];
					if (node.inputs.some((port) => port.edges.length > 0)) continue;
					for (const port of node.inputs) {
						const drop = kernel.deliver(id, port.portId, sourceMessage);
						if (drop !== null) drops.push(drop);
					}
				}
				await this.recordDrops(drops);
			}

			while (!this.signal.aborted) {
				// Start ready firings — gate open, under the cap, in node-id
				// order. The stretch from fireableNodes() to waitChange() must
				// not await, so no kernel change can slip between the checks
				// and the sleep. A parked breakpoint firing keeps its kernel
				// slot until its runner task ends — harmless while parked (the
				// halt gate is closed, so the cap never binds), and P5's
				// control plane reworks the accounting anyway.
				for (const nodeId of kernel.fireableNodes()) {
					if (this.signal.aborted || kernel.halted || kernel.inFlight >= kernel.maxInFlight) break;
					if (noRefire.has(nodeId)) continue;
					const messages = kernel.takeForFiring(nodeId);
					kernel.beginFiring(nodeId);
					const task = this.runFiring(nodeId, messages, agentById).finally(() => kernel.endFiring(nodeId));
					this.runners.add(task);
					void task.catch(() => { /* runFiring finalizes internally */ }).finally(() => { this.runners.delete(task); });
				}
				if (this.signal.aborted) break;
				if (this.pauseQueue.length === 0 && kernel.quiescent(noRefire)) break;
				await kernel.waitChange();
			}

			if (this.signal.aborted) await this.finalize("aborted");
			else await this.finalizeCompleted(projected, noRefire);
		} catch (error) {
			// Unforeseen executor failure: drain the runners (no commit lands
			// after finalization) and finalize as an errored run.
			this.services.logger.warn(`agent-pipeline: run "${this.record.runId}" executor failed: ${String(error)}`);
			try {
				await this.finalize("error");
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
	async startRun(request: { sessionId: string; cwd: string; graph?: PipelineGraph | null; input?: unknown; maxInFlight?: unknown }): Promise<{ ok: true; runId: string } | { ok: false; error: string; activeRunId?: string }> {
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
		// The kernel derives its streams from the immutable snapshot; the
		// firing log fills as nodes fire. Each continuable node's parent anchor
		// id appears in `nodes` when the node first admits a child.
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
