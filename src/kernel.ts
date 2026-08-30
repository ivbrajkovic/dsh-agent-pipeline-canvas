// dsh-agent-pipeline-canvas — the firing kernel (pure stream mechanics).
//
// The kernel is the executor spec §6 "Kernel" piece: per-input-port FIFO
// queues, firing rules over port policies, bound enforcement, the halt gate,
// maxInFlight accounting, quiescence detection with the starving-node
// candidates, and promise-based readiness ("promise-per-node readiness is the
// idiom"). It is intentionally PURE — no I/O, no record access, no agent
// calls, no Node/browser APIs — so it is unit-testable with no harness. The
// durable executor (lib/runs.ts) owns every side effect: the kernel only says
// WHICH node may fire next; the executor runs it and feeds results back as
// messages.
//
// ## The stream model this implements (docs/reference/design-principles.md)
//
// A node fires when its input policy is satisfied: it consumes its input
// messages, runs once, and its output arrives downstream as new messages. A
// node may fire many times; a graph where every input arrives exactly once is
// the special case. Cycles are legal wiring — a loop ends when a port goes
// quiet. The run ends at quiescence: nothing in flight, nothing fireable.
//
// ## Firing rules (the P3 interpretation, pinned here)
//
// The docs pin two facts that together fix the semantics of a SHARED input
// port (the fan-in target A→B,C→D wires both edges into D's single default
// port, and D must fire ONCE AFTER BOTH with both sections composed):
//
//   - all-of: satisfied ⟺ every wired source of every all-of input port holds
//     at least one unconsumed message ON THAT PORT. Consumption takes the
//     oldest message per wired source — a firing composes exactly one message
//     per upstream, which is precisely the input contract's object shape
//     (one key per source, agentInput()). A bare "one message per port" rule
//     cannot express this: D would fire on B's message alone and again on C's.
//   - any-of: satisfied by the arrival of any message (the implementation
//     plan's P3 risk note: "an any-of firing consumes one message from every
//     non-empty input port"); an any-of port never blocks, and consumption
//     takes the port's single head message — one firing per arriving message.
//
// A node with NO incoming edges at all is SOURCE-FED: the run's synthetic
// source (executor-side) delivers the pipeline input to every one of its
// input ports, so a root fires once per run like the sequential executor's
// roots always did. A declared input port with no edges on a node that HAS
// other wired ports is inert: it receives nothing and does not block.

import { INPUT_KEY, cmp } from "./execution.ts";
import type { OutgoingEdge, PortGraph, ResolvedInputPort } from "./types.ts";

/** The synthetic source node's id — the key the run input composes under. */
export const SOURCE_NODE_ID = INPUT_KEY;

/** Default concurrent-firing cap (executor spec §1). */
export const DEFAULT_MAX_IN_FLIGHT = 4;

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

/** One input port's runtime queue: arrived, unconsumed messages (FIFO). */
interface PortQueue {
	/** Ports keep their declaration order from the resolved port graph. */
	spec: ResolvedInputPort;
	queue: KernelMessage[];
	/**
	 * The sources whose arrivals this port tracks. Wired ports track their
	 * distinct upstream ids; every port of a source-fed node tracks the
	 * synthetic source. An inert port (unwired, on a node with other wired
	 * ports) tracks nothing and neither blocks nor receives.
	 */
	sources: string[];
}

/**
 * The firing kernel over one immutable graph snapshot. The executor drives it:
 * deliver() on every emission, takeForFiring() when starting a node, and
 * beginFiring()/endFiring() around each run; waitChange() is the readiness
 * primitive the executor's main loop sleeps on — every state change resolves
 * it, and the loop re-evaluates gates, caps, and quiescence.
 */
export class Kernel {
	/** Max concurrent firings (executor spec §1); the executor enforces it. */
	readonly maxInFlight: number;
	private readonly ports = new Map<string, PortQueue[]>();
	private readonly outEdges = new Map<string, OutgoingEdge[][]>();
	private inFlightCount = 0;
	private haltedFlag = false;
	private readonly firedNodes = new Set<string>();
	private readonly changeWaiters = new Set<() => void>();

	constructor(graph: PortGraph, options: KernelOptions = {}) {
		this.maxInFlight = normalizeMaxInFlight(options.maxInFlight);
		for (const id of graph.ids) {
			const node = graph.byId[id];
			// Source-fed: no incoming edge anywhere — the run input feeds every
			// port of this node (the sequential root rule, restated as messages).
			const sourceFed = !node.inputs.some((port) => port.edges.length > 0);
			this.ports.set(
				id,
				node.inputs.map((spec) => ({
					spec,
					queue: [],
					sources: sourceFed
						? [SOURCE_NODE_ID]
						: [...new Set(spec.edges.map((edge) => edge.source))].sort(cmp),
				})),
			);
			this.outEdges.set(id, node.outputs.map((port) => port.edges));
		}
	}

	// ---- Accounting and gates ----------------------------------------------

	/** How many firings currently hold a kernel slot (started, not finished). */
	get inFlight(): number {
		return this.inFlightCount;
	}

	/** Whether the halt gate is closed (grouped pause: no new firing starts). */
	get halted(): boolean {
		return this.haltedFlag;
	}

	setHalted(halted: boolean): void {
		if (this.haltedFlag === halted) return;
		this.haltedFlag = halted;
		this.wake();
	}

	/** Take an in-flight slot for one firing of `nodeId`. */
	beginFiring(nodeId: string): void {
		this.firedNodes.add(nodeId);
		this.inFlightCount += 1;
		this.wake();
	}

	/** Release the slot when the firing's runner task is done. */
	endFiring(nodeId: string): void {
		this.firedNodes.add(nodeId);
		this.inFlightCount = Math.max(0, this.inFlightCount - 1);
		this.wake();
	}

	/** Wake waiters when executor-side state changed (abort, control ops). */
	notify(): void {
		this.wake();
	}

	// ---- Messages ------------------------------------------------------------

	/**
	 * Deliver one message to a node's input port (wire port id). Enforces the
	 * port's delivery bound: when the port already queues its bound, the
	 * ARRIVING message is dropped (design principle 4 — "further messages are
	 * dropped") and returned as a record entry; nothing fires for it.
	 */
	deliver(targetId: string, targetPortId: string, message: KernelMessage): KernelDrop | null {
		const port = this.ports.get(targetId)?.find((candidate) => candidate.spec.portId === targetPortId);
		if (port === undefined) return null;
		if (port.spec.bound !== undefined && port.queue.length >= port.spec.bound) {
			return { nodeId: targetId, port: port.spec.name, from: message.from };
		}
		port.queue.push(message);
		this.wake();
		return null;
	}

	/**
	 * Nodes whose input policy is currently satisfied, in deterministic (node
	 * id) order — the ready order every batch of new firings starts in. The
	 * executor additionally applies its own gates on top (halt gate,
	 * maxInFlight, restart guards).
	 */
	fireableNodes(): string[] {
		const ready: string[] = [];
		for (const [id, ports] of this.ports) {
			if (this.satisfied(ports)) ready.push(id);
		}
		return ready.sort(cmp);
	}

	/**
	 * Consume the messages one firing of `nodeId` runs with, in deterministic
	 * (port declaration) order: from every non-empty all-of port the oldest
	 * message per wired source; from every non-empty any-of port the single
	 * head message. Call only for a node fireableNodes() just reported —
	 * otherwise the queues would consume partially, which is a caller bug.
	 */
	takeForFiring(nodeId: string): KernelMessage[] {
		const ports = this.ports.get(nodeId);
		if (ports === undefined) return [];
		const consumed: KernelMessage[] = [];
		for (const port of ports) {
			if (port.queue.length === 0) continue;
			if (port.spec.policy === "any-of") {
				consumed.push(port.queue.shift() as KernelMessage);
				continue;
			}
			for (const source of port.sources) {
				const index = port.queue.findIndex((message) => message.from === source);
				if (index !== -1) consumed.push(...port.queue.splice(index, 1));
			}
		}
		return consumed;
	}

	/**
	 * Emit one firing's output from `nodeId`: P3 emission is non-selective —
	 * the message is copied to every edge of every output port (selective
	 * emission and bindings are P7). Returns the bound overflows to record.
	 */
	emit(nodeId: string, output: string): KernelDrop[] {
		const message: KernelMessage = { from: nodeId, output };
		const drops: KernelDrop[] = [];
		const ports = this.outEdges.get(nodeId);
		if (ports === undefined) return drops;
		for (const edges of ports) {
			for (const edge of edges) {
				const drop = this.deliver(edge.target, edge.targetPort, message);
				if (drop !== null) drops.push(drop);
			}
		}
		return drops;
	}

	// ---- Quiescence ------------------------------------------------------------

	/**
	 * The run's end predicate: nothing in flight and nothing fireable outside
	 * `exclude` (the executor's restart guard — nodes the log already
	 * satisfied never re-fire). When this holds, no future message can arrive
	 * (messages come only from firings), so the run is over — the executor
	 * reports starving nodes.
	 */
	quiescent(exclude?: ReadonlySet<string>): boolean {
		if (this.inFlightCount !== 0) return false;
		for (const [id, ports] of this.ports) {
			if (exclude?.has(id)) continue;
			if (this.satisfied(ports)) return false;
		}
		return true;
	}

	/**
	 * Nodes the run went quiet while waiting for: they never fired and can
	 * never fire again at quiescence — either they track wired sources whose
	 * messages never (all) arrived, or they declare no input ports at all
	 * (a port-less node can never fire — surfaced as starvation, not an error).
	 * Sorted; the executor subtracts nodes already satisfied by the log before
	 * reporting. Known limitation (fine until P7's cycles): a node that DID
	 * fire but now waits on an unsatisfied re-firing round is not reported —
	 * extend this to unsatisfied all-of ports generally when re-firing lands.
	 */
	starvingCandidates(): string[] {
		const waiting: string[] = [];
		for (const [id, ports] of this.ports) {
			if (this.firedNodes.has(id)) continue;
			if (ports.length === 0 || ports.some((port) => port.sources.length > 0)) waiting.push(id);
		}
		return waiting.sort(cmp);
	}

	// ---- Readiness -------------------------------------------------------------

	/**
	 * Promise-per-node readiness, executor-shaped: resolve on the next kernel
	 * state change so the main loop can re-evaluate gates, caps, and
	 * quiescence. A spurious wake is harmless — the loop re-checks everything.
	 */
	waitChange(): Promise<void> {
		return new Promise((resolve) => { this.changeWaiters.add(resolve); });
	}

	// ---- Internals -------------------------------------------------------------

	/** The firing rule (see the module comment for the pinned interpretation). */
	private satisfied(ports: PortQueue[]): boolean {
		let anyMessage = false;
		let anyPort = false;
		for (const port of ports) {
			anyPort = true;
			if (port.queue.length > 0) anyMessage = true;
			if (port.spec.policy === "any-of") continue; // never blocks
			for (const source of port.sources) {
				if (!port.queue.some((message) => message.from === source)) return false;
			}
		}
		return anyPort && anyMessage;
	}

	private wake(): void {
		const waiters = [...this.changeWaiters];
		this.changeWaiters.clear();
		for (const resolve of waiters) resolve();
	}
}

/** Resolve the run's max-in-flight: a positive integer, else the default (4). */
export function normalizeMaxInFlight(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? value
		: DEFAULT_MAX_IN_FLIGHT;
}
