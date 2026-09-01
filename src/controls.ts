// dsh-agent-pipeline-canvas — control semantics (validation rules + lowering).
//
// The single authoritative home of the if control's behavior
// (docs/proposals/if-control.md). One pure module — no Node or browser APIs,
// no I/O, no React — so both the Host and the browser bundle consume it and
// its behaviour is exercised in a plain Node script (test/controls.test.ts).
// Future controls (a `switch`, a delay) extend the same record shape (`kind`)
// without reshaping the schema.
//
// Two halves:
//
//   - validateControls — the control-aware rules behind validateGraph
//     (delegated there): the control record's shape and id uniqueness, the
//     source/owner contract, the branch rules, and the non-fatal warnings
//     (side stacking, an unreachable emission surface). It returns the
//     analysis the shared connection rules and the cycle walk need to treat
//     controls as endpoints (./graph.ts applies it).
//   - lowerControls — the lowering: rewrites the honest graph (controls as
//     nodes) into the hand-authored ports+bindings graph the kernel already
//     runs, at the top of RunExecutor.run(). The kernel never learns controls
//     exist; the lowered graph is never persisted (the record's snapshot
//     carries the honest controls, and a resumed run re-lowers on re-entry).
//
// Lowering is TOTAL over malformed records — a hand-edited control normalizes
// or skips, never throws — because the resurrection path re-enters run()
// without passing validateGraph, so the lowering is the last line of defense
// (the portGraph discipline: this view stays total, validation reports).

import type { Connection, ControlNode, IfBranch, OutputBinding, PipelineGraph, PortSide, ValidationError } from "./types.ts";

/** Node edges a branch tick may render on (same vocabulary as graph.ts). */
const PORT_SIDES = ["left", "right", "top", "bottom"] as const;
const DEFAULT_BRANCH_SIDE = "right";

/** What the shared graph rules need to know about a graph's controls. */
export interface ControlAnalysis {
	/**
	 * The resolvable control ids: well-shaped entries with a non-empty id,
	 * first of any duplicates, none colliding with an agent id — exactly the
	 * ids a connection endpoint may resolve to unambiguously.
	 */
	ids: ReadonlySet<string>;
	/** control id -> the single feeding agent's id, when that agent exists. */
	sourceByControl: ReadonlyMap<string, string>;
	/** control id -> declared branch names (a control-sourced edge's sourcePort must name one). */
	branchNames: ReadonlyMap<string, readonly string[]>;
}

function argStr(value: unknown): string {
	return value == null ? "" : String(value);
}

/** True for a branch that tests a value (everything but the catch-all). */
function isValued(branch: IfBranch): boolean {
	return branch.value !== undefined && branch.value !== "";
}

/**
 * The control-aware validation rules, run by validateGraph after the agents
 * pass and before the connections pass (which consumes the returned
 * analysis). Control-specific failures report on the control
 * (`control-invalid` shape/ids, `if-source-invalid` feeding, `if-owner-conflict`
 * emission ownership, `if-branch-invalid` branch rules); non-fatal findings
 * ride `warnings` (`if-side-conflict` side stacking, plus the never-fire
 * warnings for a schema-less or breakpointed source). Only `kind: "if"`
 * controls carry the if rules — a future kind passes the shape checks and
 * owns its own.
 *
 * @param graph - the raw graph value (agents/connections/controls as unknown).
 * @param agentIds - the known agent ids (from validateGraph's agents pass).
 * @param errors - validateGraph's error sink.
 * @param warnings - validateGraph's warning sink.
 * @returns the analysis for graph.ts's endpoint/cycle handling.
 */
export function validateControls(
	graph: { agents?: unknown; connections?: unknown; controls?: unknown },
	agentIds: ReadonlySet<string>,
	errors: ValidationError[],
	warnings: ValidationError[],
): ControlAnalysis {
	const ids = new Set<string>();
	const sourceByControl = new Map<string, string>();
	const branchNames = new Map<string, string[]>();
	const raw = graph.controls;
	if (raw == null) return { ids, sourceByControl, branchNames };
	if (!Array.isArray(raw)) {
		errors.push({ code: "control-invalid", message: "pipeline 'controls' must be an array" });
		return { ids, sourceByControl, branchNames };
	}

	// ---- Shape and ids (endpoint resolution must stay unambiguous) --------
	const controls: ControlNode[] = [];
	const seenIds = new Set<string>();
	for (const entry of raw) {
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
			errors.push({ code: "control-invalid", message: "a control entry is not an object" });
			continue;
		}
		const rec = entry as { id?: unknown; kind?: unknown };
		const id = rec.id == null ? "" : String(rec.id);
		if (id.length === 0) {
			errors.push({ code: "control-invalid", message: "a control is missing an id" });
			continue;
		}
		if (rec.kind == null || String(rec.kind).length === 0) {
			errors.push({ code: "control-invalid", message: `control "${id}" is missing a kind` });
			continue;
		}
		if (seenIds.has(id)) {
			errors.push({ code: "control-invalid", message: `duplicate control id "${id}"` });
			continue;
		}
		if (agentIds.has(id)) {
			errors.push({ code: "control-invalid", message: `control id "${id}" collides with an agent id — control ids live in their own space` });
			continue;
		}
		seenIds.add(id);
		ids.add(id);
		controls.push(entry as ControlNode);
	}

	// ---- Connection accounting for the feeding rules ----------------------
	// Per control: its incoming sources; per source id: its outgoing edges
	// (an if's owner feeds exactly one control and nothing else).
	const agents = Array.isArray(graph.agents) ? graph.agents : [];
	const connections = Array.isArray(graph.connections) ? graph.connections : [];
	const incoming = new Map<string, string[]>();
	const outgoing = new Map<string, number>();
	for (const conn of connections) {
		if (conn == null || typeof conn !== "object") continue;
		const rec = conn as { source?: unknown; target?: unknown };
		const source = argStr(rec.source);
		const target = argStr(rec.target);
		if (target.length > 0 && ids.has(target)) incoming.set(target, (incoming.get(target) ?? []).concat([source]));
		if (source.length > 0) outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
	}

	// ---- Per-control rules -------------------------------------------------
	for (const control of controls) {
		const id = control.id;
		if (control.kind !== "if") continue; // a future kind owns its rules
		branchNames.set(id, validateBranches(id, control.branches, errors));

		const sources = incoming.get(id) ?? [];
		if (sources.length !== 1) {
			errors.push({
				code: "if-source-invalid",
				message: sources.length === 0
					? `control "${id}" has no incoming connection — exactly one agent must feed it`
					: `control "${id}" has ${sources.length} incoming connections — exactly one agent must feed it`,
			});
			continue;
		}
		const source = sources[0];
		if (ids.has(source)) {
			errors.push({ code: "if-source-invalid", message: `control "${id}" is fed by another control ("${source}") — control-to-control chaining is not supported` });
			continue;
		}
		if (!agentIds.has(source)) continue; // unknown source: validateGraph's connection pass (which runs after this one) reports connection-source-missing
		sourceByControl.set(id, source);
		const owner = findAgent(agents, source);
		if (owner !== undefined) {
			validateOwner(id, source, owner, outgoing, errors);
			warnUnreachable(id, source, owner, warnings);
		}
		warnSideConflict(id, control.branches, warnings);
	}

	return { ids, sourceByControl, branchNames };
}

/**
 * One control's branch rules: at least one branch; unique non-empty names;
 * every valued branch carries a non-empty `field`; at most one catch-all and
 * only as the last branch; a known side. Returns the declared branch names —
 * reported even on a branch that failed another rule, so a connection naming
 * it is not double-reported.
 */
function validateBranches(controlId: string, branches: unknown, errors: ValidationError[]): string[] {
	if (!Array.isArray(branches) || branches.length === 0) {
		errors.push({ code: "if-branch-invalid", message: `control "${controlId}" has no branches — add at least one` });
		return [];
	}
	const names: string[] = [];
	const seen = new Set<string>();
	branches.forEach((entry, index) => {
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
			errors.push({ code: "if-branch-invalid", message: `control "${controlId}" branch #${index + 1} is not an object` });
			return;
		}
		const branch = entry as IfBranch;
		const name = argStr(branch.name);
		const label = name.length > 0 ? `"${name}"` : `#${index + 1}`;
		if (name.length === 0) {
			errors.push({ code: "if-branch-invalid", message: `control "${controlId}" branch #${index + 1} has no name` });
		} else if (seen.has(name)) {
			errors.push({ code: "if-branch-invalid", message: `control "${controlId}" declares branch "${name}" more than once` });
		} else {
			seen.add(name);
			names.push(name);
		}
		if (isValued(branch) && (typeof branch.field !== "string" || branch.field.length === 0)) {
			errors.push({ code: "if-branch-invalid", message: `control "${controlId}" branch ${label} compares a value but names no field` });
		}
		if (!isValued(branch) && index < branches.length - 1) {
			errors.push({ code: "if-branch-invalid", message: `control "${controlId}" branch ${label} is a catch-all but not last — the catch-all must be the final branch` });
		}
		if (branch.side !== undefined && !(PORT_SIDES as readonly unknown[]).includes(branch.side)) {
			errors.push({ code: "if-branch-invalid", message: `control "${controlId}" branch ${label} has an unknown side "${argStr(branch.side)}" (expected "left", "right", "top" or "bottom")` });
		}
	});
	return names;
}

/**
 * The if OWNS its source agent's entire emission surface: the source declares
 * no `outputPorts`/`bindings` of its own and feeds exactly this one control
 * with no other outgoing edges.
 */
function validateOwner(controlId: string, sourceId: string, owner: Record<string, unknown>, outgoing: ReadonlyMap<string, number>, errors: ValidationError[]): void {
	if (owner.outputPorts !== undefined) {
		errors.push({ code: "if-owner-conflict", message: `agent "${sourceId}" declares its own output ports but feeds control "${controlId}" — the if owns the agent's whole emission surface; clear the agent's output ports` });
	}
	if (owner.bindings !== undefined) {
		errors.push({ code: "if-owner-conflict", message: `agent "${sourceId}" declares its own output bindings but feeds control "${controlId}" — the if owns the agent's whole emission surface; clear the agent's bindings` });
	}
	const count = outgoing.get(sourceId) ?? 0;
	if (count > 1) {
		errors.push({ code: "if-owner-conflict", message: `agent "${sourceId}" feeds control "${controlId}" but has ${count} outgoing connections — an if's source feeds exactly that one control and nothing else` });
	}
}

/**
 * Non-fatal: the branches can never fire when the source lacks
 * `settings.outputSchema` (bindings evaluate only against a structured
 * result) or is breakpointed (a continuable child produces none).
 */
function warnUnreachable(controlId: string, sourceId: string, owner: Record<string, unknown>, warnings: ValidationError[]): void {
	if (owner.breakpoint === true) {
		warnings.push({ code: "if-source-breakpointed", message: `control "${controlId}" feeds from breakpointed agent "${sourceId}" — a continuable child cannot produce structured output, so its branches can never fire` });
	}
	const settings = owner.settings;
	const schema = settings != null && typeof settings === "object" ? (settings as { outputSchema?: unknown }).outputSchema : undefined;
	if (schema === undefined || schema === null) {
		warnings.push({ code: "if-source-no-schema", message: `control "${controlId}" feeds from agent "${sourceId}" which has no settings.outputSchema — its branches compare a structured result, so they can never fire` });
	}
}

/**
 * Non-fatal (mirrors `agent-port-side-conflict`): two or more branches of one
 * control resolve to the same node edge; the control renders the stack.
 */
function warnSideConflict(controlId: string, branches: unknown, warnings: ValidationError[]): void {
	if (!Array.isArray(branches)) return;
	const bySide = new Map<string, string[]>();
	for (const entry of branches) {
		if (entry == null || typeof entry !== "object") continue;
		const branch = entry as IfBranch;
		const name = argStr(branch.name);
		if (name.length === 0) continue;
		const side = branch.side === undefined ? DEFAULT_BRANCH_SIDE : String(branch.side);
		bySide.set(side, (bySide.get(side) ?? []).concat([name]));
	}
	for (const [side, names] of bySide) {
		if (names.length > 1) {
			warnings.push({ code: "if-side-conflict", message: `control "${controlId}" puts more than one branch on the ${side} edge: ${names.join(", ")} — they render stacked; assign distinct sides to spread them` });
		}
	}
}

/** Read one agent record out of the raw agents array by id (first match). */
function findAgent(agents: readonly unknown[], id: string): Record<string, unknown> | undefined {
	for (const agent of agents) {
		if (agent == null || typeof agent !== "object") continue;
		if (argStr((agent as { id?: unknown }).id) === id) return agent as Record<string, unknown>;
	}
	return undefined;
}

/** Structural minimum of an agent record the lowering clones (keeps the module total over hand-edited files). */
type AgentLike = Record<string, unknown>;

/**
 * Lower an honest graph (controls as nodes) onto the port/binding mechanics
 * the kernel already runs: for control `K` with source agent `A`, `A` gains
 * `K.branches[].name` as its `outputPorts` and the branch rules as its
 * `bindings`, every connection `K:<branch> → T:<port>` becomes
 * `A:<branch> → T:<port>` (the sourcePort wire id re-prefixed), and `K` —
 * with its feeding edge — is dropped. The result is exactly the graph a
 * hand-authored ports+bindings twin would be:
 *
 *   - a branch authored `value: ""` lowers to a binding with NO `value` key
 *     (the executor's catch-all test is `value === undefined`, so a literal
 *     empty string would compare against "" and never catch);
 *   - non-default branch sides forward into `A`'s `outputPortSides`, the map
 *     omitted when it would be empty (the house convention);
 *   - the `controls` key is absent from the result (it is never persisted).
 *
 * TOTAL over malformed records: a hand-edited control normalizes or skips,
 * never throws — the resurrection path re-enters run() without validation.
 * A graph without controls lowers to itself.
 */
export function lowerControls(graph: PipelineGraph | null | undefined): PipelineGraph {
	if (graph == null || typeof graph !== "object" || Array.isArray(graph)) {
		return { agents: [], connections: [] };
	}
	const raw = (graph as { controls?: unknown }).controls;
	if (!Array.isArray(raw) || raw.length === 0) return graph;

	const agentsRaw: unknown[] = Array.isArray((graph as { agents?: unknown }).agents) ? (graph as { agents: unknown[] }).agents : [];
	const connectionsRaw: unknown[] = Array.isArray((graph as { connections?: unknown }).connections) ? (graph as { connections: unknown[] }).connections : [];

	const agentIds = new Set<string>();
	for (const agent of agentsRaw) {
		const id = agent != null && typeof agent === "object" ? argStr((agent as { id?: unknown }).id) : "";
		if (id.length > 0 && !agentIds.has(id)) agentIds.add(id);
	}

	// Every control id on record — its edges vanish from the lowered graph,
	// whether or not the control itself lowers.
	const controlIds = new Set<string>();
	for (const entry of raw) {
		const id = entry != null && typeof entry === "object" ? argStr((entry as { id?: unknown }).id) : "";
		if (id.length > 0) controlIds.add(id);
	}

	// A control lowers onto the source agent of its first incoming connection
	// that names an existing agent (the valid shape is exactly one).
	const firstAgentSource = (controlId: string): string | null => {
		for (const conn of connectionsRaw) {
			if (conn == null || typeof conn !== "object") continue;
			const rec = conn as { source?: unknown; target?: unknown };
			if (argStr(rec.target) !== controlId) continue;
			const source = argStr(rec.source);
			if (source.length > 0 && agentIds.has(source)) return source;
		}
		return null;
	};

	interface Lowering {
		owner: string;
		outputPorts: string[];
		bindings: OutputBinding[];
		sides: Record<string, PortSide>;
	}
	const lowerings = new Map<string, Lowering>();
	for (const entry of raw) {
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const control = entry as ControlNode;
		const id = argStr(control.id);
		if (id.length === 0 || control.kind !== "if") continue;
		const owner = firstAgentSource(id);
		if (owner === null) continue;
		const outputPorts: string[] = [];
		const bindings: OutputBinding[] = [];
		const sides: Record<string, PortSide> = {};
		for (const branch of Array.isArray(control.branches) ? control.branches : []) {
			if (branch == null || typeof branch !== "object") continue;
			const spec = branch as IfBranch;
			const name = argStr(spec.name);
			if (name.length === 0) continue;
			outputPorts.push(name);
			// A valueless branch (absent or "") lowers to the CATCH-ALL: no
			// `value` key — the executor's test is `value === undefined`. The
			// field carries when the branch authored one; only a hand-edited
			// fieldless branch lowers without it (the cast covers that case —
			// OutputBinding types the authoring shape, which always has one).
			const branchValue = spec.value;
			const valued = branchValue !== undefined && branchValue !== "";
			const field = typeof spec.field === "string" && spec.field.length > 0 ? spec.field : null;
			const binding = field !== null
				? (valued ? { field, port: name, value: branchValue } : { field, port: name })
				: (valued ? { port: name, value: branchValue } : { port: name });
			bindings.push(binding as OutputBinding);
			if (spec.side !== undefined && (PORT_SIDES as readonly unknown[]).includes(spec.side) && spec.side !== DEFAULT_BRANCH_SIDE) {
				sides[name] = spec.side;
			}
		}
		lowerings.set(id, { owner, outputPorts, bindings, sides });
	}

	// The owners, with the first lowering winning if two controls share one
	// (invalid wiring — if-owner-conflict reports it; lowering stays total).
	const owners = new Map<string, Lowering>();
	for (const lowering of lowerings.values()) {
		if (!owners.has(lowering.owner)) owners.set(lowering.owner, lowering);
	}

	const agents = agentsRaw.map((agent): unknown => {
		const id = agent != null && typeof agent === "object" ? argStr((agent as { id?: unknown }).id) : "";
		const lowering = owners.get(id);
		if (lowering === undefined || agent == null || typeof agent !== "object") return agent;
		const clone: AgentLike = { ...(agent as AgentLike), outputPorts: [...lowering.outputPorts], bindings: lowering.bindings.map((b) => ({ ...b })) };
		if (Object.keys(lowering.sides).length > 0) clone.outputPortSides = { ...lowering.sides };
		else delete clone.outputPortSides;
		return clone;
	});

	const connections: Connection[] = [];
	for (const conn of connectionsRaw) {
		if (conn == null || typeof conn !== "object") continue;
		const rec = conn as { source?: unknown; target?: unknown; sourcePort?: unknown };
		const source = argStr(rec.source);
		const target = argStr(rec.target);
		if (controlIds.has(target)) continue; // the control's single input — gone with the control
		const lowering = lowerings.get(source);
		if (lowering !== undefined) {
			// K:<branch> → T:<port> becomes A:<branch> → T:<port>: re-prefix
			// the wire id when it carries the control prefix (leave anything
			// else untouched — validation reports it).
			const prefix = source + ":";
			const branchPart = typeof rec.sourcePort === "string" && rec.sourcePort.startsWith(prefix) ? rec.sourcePort.slice(prefix.length) : null;
			connections.push({
				...(conn as Connection),
				source: lowering.owner,
				...(branchPart !== null ? { sourcePort: lowering.owner + ":" + branchPart } : {}),
			});
			continue;
		}
		if (controlIds.has(source)) continue; // a skipped control's edges vanish with it
		connections.push(conn as Connection);
	}

	return { agents: agents as PipelineGraph["agents"], connections };
}
