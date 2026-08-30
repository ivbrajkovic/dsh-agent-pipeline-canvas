// dsh-agent-pipeline-canvas — the per-node projection over a run record.
//
// The run record (recordVersion 2) is a FIRING LOG: one append-style entry per
// firing with its own status, input, and output. Parallel bookkeeping is
// forbidden (design principle 5), so there is deliberately no persisted
// per-node view — the per-node status, the latest output, and the child
// session address that the node chips, the inspection modal, and the result
// modal show are all COMPUTED here from the log, never stored. The same pure
// function serves the client bundle (inlined by tsdown like graph.ts) and the
// tests.
//
// Projection rules (the log is the truth):
//   - status    — the node's LAST firing in log order wins (each new firing
//                 supersedes the previous one; Rerun appends, so the newest
//                 firing is the live one).
//   - input     — the first firing's composed input (identical across a
//                 node's firings by construction).
//   - output / childSessionId / stopReason / error — the latest DEFINED value
//                 across the node's firings: a re-firing that has not yet
//                 produced its own output must not blank the previous one
//                 (abort mid-rerun keeps the completed output visible).
//
// The projection also reads LEGACY v1 records (no recordVersion: `order` plus
// per-node status slots) so records written by the pre-firing-log executor
// still render. Those records are read-only everywhere — swept or finalized
// by the registry, never resurrected or run.

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
 * Deterministic FIRING-ID order, numeric on the id suffix ("f-999" < "f-1000"
 * — the P5 scrutiny note: lexicographic order flips past 999, and loops can
 * exceed that). Ids without a numeric tail (or with equal tails) fall back to
 * byte order, so the result stays total and stable over malformed ids.
 */
export function compareFiringIds(a: string, b: string): number {
	const ma = /(\d+)$/.exec(a);
	const mb = /(\d+)$/.exec(b);
	if (ma !== null && mb !== null) {
		const delta = parseInt(ma[1], 10) - parseInt(mb[1], 10);
		if (delta !== 0) return delta;
	}
	return a < b ? -1 : a > b ? 1 : 0;
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
export function unresolvedFirings(firings: readonly RunFiring[], status: RunFiringStatus): RunFiring[] {
	const all = firings.filter((f): f is RunFiring => f !== null && typeof f === "object");
	const superseded = (f: RunFiring) =>
		all.some((later) => later.nodeId === f.nodeId && typeof later.seq === "number" && typeof f.seq === "number" && later.seq > f.seq);
	return all
		.filter((f) => f.status === status && !superseded(f))
		.sort((a, b) => compareFiringIds(a.firingId, b.firingId));
}

/**
 * Project a run record onto the per-node view the UI and tests consume.
 * Total over both record versions and over malformed entries (a projection
 * must never be the thing that breaks a render).
 */
export function projectNodes(record: ProjectableRecord): NodeProjection {
	const nodes: Record<string, ProjectedNode> = {};
	const order: string[] = [];
	// The version test is SHAPE-based, not `recordVersion`-based, so a loose
	// client mirror works without carrying the field: a non-empty `firings`
	// array IS v2. An empty one falls to the v1 reader, which finds neither
	// `order` nor status slots in a v2 record and yields the same (empty)
	// projection — no firings, nothing to project.
	const firings = Array.isArray(record.firings) ? record.firings : [];

	if (firings.length > 0) {
		// v2: group the log by node, in log order.
		for (const firing of firings) {
			if (firing === null || typeof firing !== "object") continue;
			if (typeof firing.nodeId !== "string" || firing.nodeId.length === 0) continue;
			let node = nodes[firing.nodeId];
			if (node === undefined) {
				node = { nodeId: firing.nodeId, status: "pending", firings: [] };
				nodes[firing.nodeId] = node;
				order.push(firing.nodeId);
			}
			node.firings.push(firing);
			if (firing.status !== undefined) node.status = firing.status;
			if (typeof firing.input === "string" && node.input === undefined) node.input = firing.input;
			if (typeof firing.output === "string") node.output = firing.output;
			if (typeof firing.error === "string") node.error = firing.error;
			if (typeof firing.stopReason === "string") node.stopReason = firing.stopReason;
			if (typeof firing.childSessionId === "string") node.childSessionId = firing.childSessionId;
		}
	} else {
		// Legacy v1: the per-node slots ARE the projection.
		const slots = (record.nodes ?? {}) as Record<string, Partial<LegacyRunNodeState>>;
		for (const id of Array.isArray(record.order) ? record.order : []) {
			if (typeof id !== "string" || id.length === 0) continue;
			const slot = slots[id];
			if (slot === undefined) continue;
			nodes[id] = {
				nodeId: id,
				status: slot.status ?? "pending",
				...(typeof slot.input === "string" ? { input: slot.input } : {}),
				...(typeof slot.output === "string" ? { output: slot.output } : {}),
				...(typeof slot.error === "string" ? { error: slot.error } : {}),
				...(typeof slot.stopReason === "string" ? { stopReason: slot.stopReason } : {}),
				...(typeof slot.childSessionId === "string" ? { childSessionId: slot.childSessionId } : {}),
				firings: [],
			};
			order.push(id);
		}
	}

	// The pause pointer: a firing id on v2 (resolved through the log), a node
	// id on v1 (resolved against the projected nodes).
	const pausedAt = typeof record.pausedAt === "string" ? record.pausedAt : undefined;
	const pausedFiring = pausedAt !== undefined
		? firings.find((f) => f !== null && typeof f === "object" && f.firingId === pausedAt)
		: undefined;
	let pausedNodeId: string | undefined;
	if (pausedFiring !== undefined) pausedNodeId = pausedFiring.nodeId;
	else if (pausedAt !== undefined && firings.length === 0 && nodes[pausedAt] !== undefined) pausedNodeId = pausedAt;

	// The pending-pause queue (v2): the settled-but-unresolved breakpoint
	// firings with the record's pausedAt head first and the rest in firing-id
	// order (the live queue is settle-ordered; the depth is what the UI shows,
	// and the executor's crash-safe rebuild uses the same shared derivation).
	const parked = unresolvedFirings(firings, "paused");
	let pausedQueue: RunFiring[] = parked;
	if (pausedFiring !== undefined) {
		pausedQueue = [pausedFiring, ...parked.filter((f) => f !== pausedFiring)];
	}

	return {
		nodes,
		order,
		...(pausedNodeId !== undefined ? { pausedNodeId } : {}),
		...(pausedFiring !== undefined ? { pausedFiring } : {}),
		pausedQueue,
	};
}
