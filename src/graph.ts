// dsh-agent-pipeline-canvas — graph semantics (shared by the Host, the runner,
// and the browser half; the browser bundle inlines this module via tsdown).
//
// This module is the single authoritative definition of the pipeline's graph
// contract. It is intentionally PURE (no Node or browser APIs, no I/O, no React)
// so it can be imported by the Host (./index.ts), the executor (./runner.ts),
// and the browser client (./client.tsx, where tsdown bundles it in), and its
// behaviour can be exercised in a plain Node script (see test/validate.test.ts).
//
// ## The graph, treated as a port graph
//
// The pipeline is a directed graph over the two arrays a plugin already
// persists (see the graph-data-model contract in README.md):
//
//   {
//     "agents":      [ { "id", "name", "description", "instructions",
//                        "x", "y", "input": "<id>:in", "output": "<id>:out",
//                        "inputPorts"?: [...], "outputPorts"?: [...] }, ... ],
//     "connections": [ { "id", "source", "target",
//                        "sourcePort": "<source>:out", "targetPort": "<target>:in" }, ... ]
//   }
//
// Semantics (the contract execution will depend on):
//   - A->B means A's output becomes input to B (an edge from one of A's output
//     ports to one of B's input ports). Edges carry no weight/order.
//   - Each agent has named input and output ports. Undeclared, an agent has
//     exactly one of each — the legacy `input` / `output` strings, `<id>:in` /
//     `<id>:out` by convention (buildGraph always emits them). `inputPorts`
//     declares named input ports with a policy (all-of default, any-of) and an
//     optional delivery bound; `outputPorts` declares named output ports; a
//     present list replaces the single default. Wire port ids are
//     `<agentId>:<portName>`.
//   - A node's `bindings` list (conditional dispatch) makes its emission
//     selective: each rule maps a structured-output field to a port
//     (`field == value → port`, first match wins; `value` omitted = catch-all).
//     The executor compares the fields — no extra model call decides routing.
//   - Fan-out is allowed: an output port may feed many targets (a source id may
//     appear in many connections).
//   - Fan-in is allowed: an input port may receive from many sources (all edges
//     into the same port queue there).
//   - Cycles are LEGAL wiring — a loop ends when a port goes quiet (the stream
//     executor's quiescence) — but every cycle carries its guard
//     (docs/proposals/loops.md): validateGraph keeps the non-fatal
//     `cycle-present` warning (a loop exists; the legacy sequential runner
//     only runs an acyclic prefix) and REFUSES an unguarded cycle with the
//     `cycle-unguarded` error. The guard is a `bound` capping a hop of the
//     cycle or a `$count` branch escaping it — data, never a node kind.
//   - The graph must not contain a self-connection, duplicate edge, invalid
//     port declaration, or a reference to a missing agent/port; see
//     validateGraph.
//
// The format is backward-compatible: the port fields are additive, and a graph
// without them means one `in` port (all-of, unbounded) and one `out` port —
// exactly the historical shape. This module only ADDS the validation a runner
// will rely on; it does not alter the on-disk shape.
//
// Controls (docs/proposals/if-control.md) are additive too: `controls` names
// first-class control nodes that are connection endpoints but never run —
// validateGraph validates the HONEST graph (a control must be fed by exactly
// one agent that carries no emission config of its own), and the run path
// lowers controls onto the feeding agent's ports + bindings before the kernel
// sees the graph (lowerControls in ./controls.ts). The control-specific rules
// delegate to ./controls.ts; this module applies the shared ones (endpoints,
// duplicates, the cycle walk — which runs over the LOWERED graph, where the
// controls are already gone and every edge is what the kernel runs).

import type { InputPortSpec, OutputBinding, PipelineGraph, PortGraph, ValidationError, ValidationResult } from "./types.ts";
import { COUNT_KEY, isValuedRow, portGraph } from "./execution.ts";
import { lowerControls, validateControls, type ControlAnalysis } from "./controls.ts";

/** Input-port delivery policies a spec may declare. */
const PORT_POLICIES = ["all-of", "any-of"] as const;

/** Comparison ops a binding may declare; absent means "==" (same vocabulary as controls.ts). */
const BINDING_OPS = ["==", ">="] as const;

/** Node edges a port may render on (edge-routing iteration 2; geometry only). */
const PORT_SIDES = ["left", "right", "top", "bottom"] as const;
const DEFAULT_INPUT_SIDE = "left";
const DEFAULT_OUTPUT_SIDE = "right";

/**
 * Validate a pipeline graph against the port-graph contract above.
 *
 * @param graph - a value from ``{ agents, connections }``, or null/undefined
 *   (an absent pipeline is valid: there is simply nothing to run).
 * @returns `{ ok, errors, warnings? }` where `ok` is true only when `errors`
 *   is empty. Each error/warning is `{ code, message }`; `code` is a stable
 *   discriminator (link of the class of problem) and `message` is a
 *   human-readable, targeted string (e.g. which agent / connection / port is
 *   at fault). `warnings` carries non-fatal findings (`cycle-present`) and is
 *   present only when non-empty.
 */
export function validateGraph(graph: unknown): ValidationResult {
	const errors: ValidationError[] = [];
	const warnings: ValidationError[] = [];

	if (graph == null) return { ok: true, errors };
	if (typeof graph !== "object" || Array.isArray(graph)) {
		errors.push({ code: "graph-invalid", message: "pipeline must be an object with agents and connections" });
		return { ok: false, errors };
	}
	const asGraph = graph as { agents?: unknown; connections?: unknown };

	if (asGraph.agents != null && !Array.isArray(asGraph.agents)) {
		errors.push({ code: "agents-not-array", message: "pipeline 'agents' must be an array" });
	}
	if (asGraph.connections != null && !Array.isArray(asGraph.connections)) {
		errors.push({ code: "connections-not-array", message: "pipeline 'connections' must be an array" });
	}

	const agents = Array.isArray(asGraph.agents) ? asGraph.agents : [];
	const connections = Array.isArray(asGraph.connections) ? asGraph.connections : [];

	const agentIds = new Set<string>();

	// ---- Agents ------------------------------------------------------------
	for (const agent of agents) {
		if (agent == null || typeof agent !== "object") {
			errors.push({ code: "agent-invalid", message: "an agent entry is not an object" });
			continue;
		}
		const rec = agent as {
			id?: unknown; input?: unknown; output?: unknown; inputPorts?: unknown; outputPorts?: unknown; outputPortSides?: unknown;
		};
		const id = rec.id == null ? "" : String(rec.id);
		if (id.length === 0) {
			errors.push({ code: "agent-missing-id", message: "an agent is missing an id" });
			continue;
		}
		if (agentIds.has(id)) {
			errors.push({ code: "agent-duplicate-id", message: `duplicate agent id "${id}"` });
			continue;
		}
		agentIds.add(id);

		// Legacy port strings are optional on the wire (buildGraph always emits
		// them), but if present they must be non-empty strings.
		if (rec.input != null && (typeof rec.input !== "string" || rec.input.length === 0)) {
			errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an invalid input port` });
		}
		if (rec.output != null && (typeof rec.output !== "string" || rec.output.length === 0)) {
			errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an invalid output port` });
		}

		validatePortDeclarations(id, rec, errors, warnings);
	}

	// ---- Controls (the if control) ------------------------------------------
	// The control-specific rules delegate to ./controls.ts; the returned
	// analysis lets the connection pass below treat controls as endpoints and
	// the cycle walk alias a control onto its producer.
	const analysis: ControlAnalysis = validateControls(asGraph as { agents?: unknown; connections?: unknown; controls?: unknown }, agentIds, errors, warnings);

	// ---- Port resolution (declared lists, else the legacy defaults) --------
	// One shared derivation with the run kernel: which ports exist, their wire
	// ids, and which edges attach where.
	const ports = portGraph(graph);

	// ---- Output bindings (selective emission — conditional-dispatch §2) ----
	// A binding is data on the node: an array of { field, port, value?, op? }
	// rules the executor evaluates against the firing (content fields against
	// the structured result; the reserved `$count` against the firing's own
	// sequence). The declaration must be well-shaped and each binding's port
	// must name one of the agent's DECLARED (or default) output ports — the
	// same membership a connection's source port must satisfy. Whether a
	// binding will actually match a run's result is data, not shape: never
	// validated here.
	for (const agent of agents) {
		if (agent == null || typeof agent !== "object") continue;
		const rec = agent as { id?: unknown; bindings?: unknown };
		if (rec.bindings === undefined) continue;
		const id = rec.id == null ? "" : String(rec.id);
		const declared = ports.byId[id]?.outputs.map((p) => p.name) ?? [];
		if (!Array.isArray(rec.bindings)) {
			errors.push({ code: "agent-binding-invalid", message: `agent "${id}" has an invalid bindings declaration (must be an array)` });
			continue;
		}
		(rec.bindings as unknown[]).forEach((entry, index) => {
			const binding = entry as { field?: unknown; port?: unknown; value?: unknown; op?: unknown } | null | undefined;
			const field = binding != null && typeof binding === "object" && typeof binding.field === "string" ? binding.field : "";
			if (field.length === 0) {
				errors.push({ code: "agent-binding-invalid", message: `agent "${id}" has an output binding without a field (binding #${index + 1})` });
				return;
			}
			const port = binding != null && typeof binding === "object" && typeof binding.port === "string" ? binding.port : "";
			if (port.length === 0) {
				errors.push({ code: "agent-binding-invalid", message: `agent "${id}" binding "${field}" names no output port` });
				return;
			}
			// The op rules mirror the if control's branch rules (docs/proposals/loops.md):
			// "==" (or absent) is the default; ">=" must carry a value that
			// coerces to a finite number, since the comparison is numeric.
			const op = binding != null && typeof binding === "object" ? binding.op : undefined;
			if (op !== undefined && !(BINDING_OPS as readonly unknown[]).includes(op)) {
				errors.push({ code: "agent-binding-invalid", message: `agent "${id}" binding "${field}" has an unknown op "${argStr(op)}" (expected "==" or ">=")` });
				return;
			}
			if (op === ">=" && !Number.isFinite(Number(binding?.value))) {
				errors.push({ code: "agent-binding-invalid", message: `agent "${id}" binding "${field}" compares with ">=" but its value is not a finite number` });
				return;
			}
			if (!declared.includes(port)) {
				errors.push({ code: "agent-binding-port-mismatch", message: `agent "${id}" binding "${field}" targets port "${port}" but "${id}" declares output ports: ${declared.length > 0 ? declared.join(", ") : "none"}` });
			}
		});
	}

	// ---- Connections -------------------------------------------------------
	const seenEdges = new Set<string>();

	for (const conn of connections) {
		if (conn == null || typeof conn !== "object") {
			errors.push({ code: "connection-invalid", message: "a connection entry is not an object" });
			continue;
		}
		const rec = conn as { source?: unknown; target?: unknown; sourcePort?: unknown; targetPort?: unknown };

		const source = argStr(rec.source);
		const target = argStr(rec.target);
		const sourcePort = argStr(rec.sourcePort);
		const targetPort = argStr(rec.targetPort);

		if (source.length === 0) errors.push({ code: "connection-missing-source", message: "a connection is missing a source agent" });
		if (target.length === 0) errors.push({ code: "connection-missing-target", message: "a connection is missing a target agent" });

		// A control is a first-class endpoint: resolvable, but never a port
		// surface of its own — a control-sourced edge names a declared BRANCH,
		// a control-targeted edge is the control's single unnamed input.
		const sourceIsControl = !agentIds.has(source) && analysis.ids.has(source);
		const targetIsControl = !agentIds.has(target) && analysis.ids.has(target);
		const hasSource = source.length > 0 && (agentIds.has(source) || sourceIsControl);
		const hasTarget = target.length > 0 && (agentIds.has(target) || targetIsControl);

		if (source.length > 0 && !hasSource) {
			errors.push({ code: "connection-source-missing", message: `connection references unknown source agent "${source}"` });
		}
		if (target.length > 0 && !hasTarget) {
			errors.push({ code: "connection-target-missing", message: `connection references unknown target agent "${target}"` });
		}
		if (source.length > 0 && target.length > 0 && source === target) {
			errors.push({ code: "connection-self", message: `connection ${source} -> ${target} connects an agent to itself` });
		}

		// Port wiring: a connection must leave one of the source's DECLARED (or
		// default) output ports and enter one of the target's input ports — the
		// exact membership the stream kernel will resolve against (see portGraph).
		// Control endpoints are exempt from the agent-port rules and carry the
		// control rules instead (`if-edge-port-unknown`). Lowering rewrites a
		// valid control edge onto the feeding agent's ports, so these checks are
		// what keeps the lowered graph wiring-clean.
		const srcNode = hasSource && !sourceIsControl ? ports.byId[source] : undefined;
		const tgtNode = hasTarget && !targetIsControl ? ports.byId[target] : undefined;

		if (sourceIsControl) {
			const declared = analysis.branchNames.get(source) ?? [];
			const prefix = source + ":";
			const branch = sourcePort.startsWith(prefix) ? sourcePort.slice(prefix.length) : "";
			if (!declared.includes(branch)) {
				errors.push({ code: "if-edge-port-unknown", message: `connection from control "${source}" uses source port "${sourcePort}" but the control declares branches: ${declared.length > 0 ? declared.join(", ") : "none"}` });
			}
		} else if (hasSource) {
			if (sourcePort.length === 0) {
				errors.push({ code: "connection-missing-source-port", message: `connection from "${source}" is missing a source port` });
			} else if (srcNode === undefined || srcNode.outputById[sourcePort] === undefined) {
				const declared = srcNode ? srcNode.outputs.map((p) => p.portId).join(", ") : "";
				errors.push({ code: "connection-source-port-mismatch", message: `connection from "${source}" uses source port "${sourcePort}" but "${source}" declares output ports: ${declared.length > 0 ? declared : "none"}` });
			}
		}
		if (targetIsControl) {
			if (targetPort.length > 0) {
				errors.push({ code: "if-edge-port-unknown", message: `connection to control "${target}" names a target port ("${targetPort}") — a control takes a single unnamed input; drop the target port` });
			}
		} else if (hasTarget) {
			if (targetPort.length === 0) {
				errors.push({ code: "connection-missing-target-port", message: `connection to "${target}" is missing a target port` });
			} else if (tgtNode === undefined || tgtNode.inputById[targetPort] === undefined) {
				const declared = tgtNode ? tgtNode.inputs.map((p) => p.portId).join(", ") : "";
				errors.push({ code: "connection-target-port-mismatch", message: `connection to "${target}" uses target port "${targetPort}" but "${target}" declares input ports: ${declared.length > 0 ? declared : "none"}` });
			}
		}

		// Duplicate edge: same source -> target over the same ports. The canvas
		// already blocks a repeated edge in one session, but the file can gain
		// duplicates from concurrent writers or a manual edit, so they are
		// reported here.
		if (source.length > 0 && target.length > 0) {
			const key = `${source}\u0000${target}\u0000${sourcePort}\u0000${targetPort}`;
			if (seenEdges.has(key)) {
				errors.push({ code: "connection-duplicate", message: `duplicate connection ${source} -> ${target}` });
			}
			seenEdges.add(key);
		}
	}

	// ---- Cycles (legal wiring — every cycle carries its guard) -------------
	// The walk runs over the LOWERED graph (lowerControls), because that is
	// exactly what the kernel runs: every edge is agent -> agent — control
	// branches included, which portGraph would drop on the honest graph — and
	// portGraph answers the port-level guard questions directly. Lowering is
	// total, so the walk is too: malformed declarations are reported by the
	// passes above and simply never resolve here.
	//
	// `cycle-present` stays the awareness warning (a loop exists), reported
	// once for the first cycle found. `cycle-unguarded` is the error: a
	// directed cycle may run only when it carries a guard — a `bound` capping
	// one of its hops, or a valued `$count` row escaping off the cycle ahead
	// of every row that wires back into it. The walk repeats past each guarded
	// cycle (its guard hop is excluded from the adjacency) until no cycle
	// remains or an unguarded one is found — one guard does not cover a
	// second, disjoint cycle. `cycle-entry-all-of` warns on the seed-once
	// deadlock: an all-of entry port fed by the cycle plus an outside source
	// can never satisfy again. Honest self-connections stay under
	// `connection-self`; only the self-loops LOWERING introduces (a branch
	// wired back to its own feeder) join the walk.
	const lowered = lowerControls(asGraph as PipelineGraph);
	const walk = walkCycles(agentIds, lowered, connections);
	if (walk.firstCycle.length > 0) {
		warnings.push({ code: "cycle-present", message: `pipeline contains a cycle: ${walk.firstCycle.join(" -> ")} — legal wiring for the stream executor, but the sequential runner only runs its acyclic prefix` });
	}
	if (walk.unguarded !== undefined) {
		errors.push({ code: "cycle-unguarded", message: walk.unguarded });
	}
	for (const message of walk.entryWarnings) {
		warnings.push({ code: "cycle-entry-all-of", message });
	}

	return { ok: errors.length === 0, errors, ...(warnings.length > 0 ? { warnings } : {}) };
}

function argStr(value: unknown): string {
	return value == null ? "" : String(value);
}

/**
 * Validate one agent's `inputPorts` / `outputPorts` declarations: lists when
 * present; each input port a spec with a non-empty string name, a known policy
 * ("all-of" | "any-of") and — when present — a positive-integer bound and a
 * known side; each output port a non-empty string name; names unique within
 * their list; `outputPortSides` (when present) a name→side map over the
 * declared output ports. Malformed side data is an error. The side cap
 * (edge-routing iteration 2 — at most one port of a node per resolved side)
 * is a WARNING, `cycle-present`-style: default sides stack multi-port nodes
 * that predate explicit sides, the canvas renders the stack, and the warning
 * tells the author how to spread the ports.
 */
function validatePortDeclarations(id: string, rec: { inputPorts?: unknown; outputPorts?: unknown; outputPortSides?: unknown }, errors: ValidationError[], warnings: ValidationError[]): void {
	if (rec.inputPorts !== undefined) {
		if (!Array.isArray(rec.inputPorts)) {
			errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an invalid inputPorts declaration (must be an array)` });
		} else {
			const seen = new Set<string>();
			for (const spec of rec.inputPorts) {
				const s = spec as { name?: unknown; policy?: unknown; bound?: unknown; side?: unknown } | null | undefined;
				if (s == null || typeof s !== "object" || Array.isArray(s) || typeof s.name !== "string" || s.name.length === 0) {
					errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an input port without a name` });
					continue;
				}
				if (seen.has(s.name)) {
					errors.push({ code: "agent-port-duplicate", message: `agent "${id}" declares input port "${s.name}" more than once` });
					continue;
				}
				seen.add(s.name);
				if (s.policy !== undefined && !(PORT_POLICIES as readonly unknown[]).includes(s.policy)) {
					errors.push({ code: "agent-port-policy-invalid", message: `agent "${id}" input port "${s.name}" has an unknown policy "${argStr(s.policy)}" (expected "all-of" or "any-of")` });
				}
				if (s.bound !== undefined && (typeof s.bound !== "number" || !Number.isInteger(s.bound) || s.bound < 1)) {
					const shown = typeof s.bound === "number" ? String(s.bound) : JSON.stringify(s.bound);
					errors.push({ code: "agent-port-bound-invalid", message: `agent "${id}" input port "${s.name}" has an invalid bound ${shown} (must be a positive integer)` });
				}
				if (s.side !== undefined && !(PORT_SIDES as readonly unknown[]).includes(s.side)) {
					errors.push({ code: "agent-port-side-invalid", message: `agent "${id}" input port "${s.name}" has an unknown side "${argStr(s.side)}" (expected "left", "right", "top" or "bottom")` });
				}
			}
		}
	}
	if (rec.outputPorts !== undefined) {
		if (!Array.isArray(rec.outputPorts)) {
			errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an invalid outputPorts declaration (must be an array)` });
		} else {
			const seen = new Set<string>();
			for (const name of rec.outputPorts) {
				if (typeof name !== "string" || name.length === 0) {
					errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an output port without a name` });
					continue;
				}
				if (seen.has(name)) {
					errors.push({ code: "agent-port-duplicate", message: `agent "${id}" declares output port "${name}" more than once` });
					continue;
				}
				seen.add(name);
			}
		}
	}
	// Output-port side map: a plain object of declared-output-port name → side.
	if (rec.outputPortSides !== undefined) {
		if (rec.outputPortSides == null || typeof rec.outputPortSides !== "object" || Array.isArray(rec.outputPortSides)) {
			errors.push({ code: "agent-port-side-invalid", message: `agent "${id}" has an invalid outputPortSides declaration (must be an object of port name → side)` });
		} else {
			const declared = Array.isArray(rec.outputPorts)
				? new Set(rec.outputPorts.filter((n): n is string => typeof n === "string" && n.length > 0))
				: new Set<string>();
			for (const [name, side] of Object.entries(rec.outputPortSides as Record<string, unknown>)) {
				if (!(PORT_SIDES as readonly unknown[]).includes(side)) {
					errors.push({ code: "agent-port-side-invalid", message: `agent "${id}" output port "${name}" has an unknown side "${argStr(side)}" (expected "left", "right", "top" or "bottom")` });
				}
				if (!declared.has(name)) {
					errors.push({ code: "agent-port-side-invalid", message: `agent "${id}" outputPortSides names "${name}" but its declared output ports are: ${declared.size > 0 ? [...declared].join(", ") : "none"}` });
				}
			}
		}
	}
	// The side cap: resolve every port's side (declared, else the side default;
	// an absent port list still contributes its one implicit default port) and
	// flag a side two or more ports land on.
	const bySide = new Map<string, string[]>();
	const take = (side: string, port: string): void => {
		bySide.set(side, (bySide.get(side) ?? []).concat([port]));
	};
	if (Array.isArray(rec.inputPorts)) {
		for (const spec of rec.inputPorts) {
			const s = spec as { name?: unknown; side?: unknown } | null | undefined;
			if (s != null && typeof s === "object" && typeof s.name === "string" && s.name.length > 0) {
				take(s.side === undefined ? DEFAULT_INPUT_SIDE : String(s.side), "in:" + s.name);
			}
		}
	} else {
		take(DEFAULT_INPUT_SIDE, "in");
	}
	if (Array.isArray(rec.outputPorts)) {
		const sides = (rec.outputPortSides != null && typeof rec.outputPortSides === "object" && !Array.isArray(rec.outputPortSides))
			? (rec.outputPortSides as Record<string, unknown>)
			: {};
		for (const name of rec.outputPorts) {
			if (typeof name !== "string" || name.length === 0) continue;
			const side = sides[name] === undefined ? DEFAULT_OUTPUT_SIDE : String(sides[name]);
			take(side, "out:" + name);
		}
	} else {
		take(DEFAULT_OUTPUT_SIDE, "out");
	}
	for (const [side, ports] of bySide) {
		if (ports.length > 1) {
			warnings.push({ code: "agent-port-side-conflict", message: `agent "${id}" puts more than one port on the ${side} edge: ${ports.join(", ")} — they render stacked; assign distinct sides to spread them` });
		}
	}
}

/** The cycle findings behind validateGraph's cycle block (see walkCycles). */
export interface CycleWalk {
	/** The first cycle found on the unmodified lowered graph — a closed path (last == first); [] when acyclic. */
	firstCycle: string[];
	/** The first unguarded cycle's `cycle-unguarded` message, when the walk found one. */
	unguarded?: string;
	/** One `cycle-entry-all-of` message per starved entry port, in discovery order. */
	entryWarnings: string[];
}

/**
 * The guard walk over a LOWERED graph (lowerControls output): find a cycle;
 * if it carries a guard, exclude its guard hop and repeat until no cycle
 * remains or an unguarded one is found — every directed cycle must carry its
 * own guard, and one guard does not cover a second, disjoint cycle. All
 * discovered cycles feed the `cycle-entry-all-of` scan. Total over malformed
 * declarations: unresolvable edges and missing ports never resolve to a
 * guard, and are otherwise invisible (the passes above report them).
 *
 * @param agentIds - the known agent ids (the walk's node universe).
 * @param lowered - the lowered graph (agents and connections only; controls
 *   are gone).
 * @param honestConnections - the HONEST graph's raw connections array, used
 *   to keep honest self-connections out of the walk (they are reported as
 *   `connection-self` once); only the self-loops LOWERING introduces — a
 *   branch wired back to its own feeder — join the walk, matched by
 *   connection id.
 * @returns the walk findings; never throws.
 */
export function walkCycles(agentIds: ReadonlySet<string>, lowered: PipelineGraph, honestConnections: readonly unknown[]): CycleWalk {
	const ports = portGraph(lowered);
	const bindingsByAgent = new Map<string, OutputBinding[]>();
	for (const agent of Array.isArray(lowered.agents) ? lowered.agents : []) {
		if (agent == null || typeof agent !== "object") continue;
		const id = argStr((agent as { id?: unknown }).id);
		const bindings = (agent as { bindings?: unknown }).bindings;
		if (id.length > 0 && Array.isArray(bindings) && !bindingsByAgent.has(id)) {
			bindingsByAgent.set(id, bindings as OutputBinding[]);
		}
	}

	// An honest self-connection keeps its dedicated report; a lowered self-loop
	// (source == target, introduced by a branch wired back to its own feeder)
	// is a real one-node cycle the kernel runs, so it stays.
	const honestSelfIds = new Set<string>();
	for (const conn of honestConnections) {
		if (conn == null || typeof conn !== "object") continue;
		const rec = conn as { id?: unknown; source?: unknown; target?: unknown };
		const source = argStr(rec.source);
		if (source.length > 0 && source === argStr(rec.target)) honestSelfIds.add(argStr(rec.id));
	}

	const adjacency = new Map<string, string[]>();
	for (const id of agentIds) adjacency.set(id, []);
	for (const conn of Array.isArray(lowered.connections) ? lowered.connections : []) {
		if (conn == null || typeof conn !== "object") continue;
		const rec = conn as { id?: unknown; source?: unknown; target?: unknown };
		const source = argStr(rec.source);
		const target = argStr(rec.target);
		if (!agentIds.has(source) || !agentIds.has(target)) continue;
		if (source === target && honestSelfIds.has(argStr(rec.id))) continue;
		adjacency.get(source)?.push(target);
	}

	const seenEntries = new Set<string>();
	const entryWarnings: string[] = [];
	let firstCycle: string[] = [];
	let unguarded: string | undefined;

	for (;;) {
		const cycle = findCycleIn(agentIds, adjacency);
		if (cycle.length === 0) break;
		if (firstCycle.length === 0) firstCycle = cycle;
		collectEntryWarnings(cycle, ports, seenEntries, entryWarnings);
		const guard = cycleGuard(cycle, ports, bindingsByAgent);
		if (!guard.guarded) {
			unguarded = `pipeline contains an unguarded cycle: ${cycle.join(" -> ")} — every loop needs a budget: add a bound to the input port one of its hops enters, or put a valued $count row ahead of every row that wires back into the loop${guard.finding !== undefined ? ` — ${guard.finding}` : ""}`;
			break;
		}
		const [u, v] = guard.hop;
		adjacency.set(u, (adjacency.get(u) ?? []).filter((t) => t !== v));
	}

	return { firstCycle, ...(unguarded !== undefined ? { unguarded } : {}), entryWarnings };
}

/**
 * Detect a directed cycle over a ready-built adjacency and return it as a
 * closed path `[a, b, c, a]` (last == first), or [] when none remains. The
 * DFS is the original findCycle's (WHITE/GRAY/BLACK stack walk); the
 * adjacency construction was lifted out so the guard walk can repeat past
 * guarded cycles and so the lowered graph's one-node cycles (a branch wired
 * back to its own feeder — a self-edge on the lowered graph) are visible.
 */
function findCycleIn(agentIds: ReadonlySet<string>, adjacency: ReadonlyMap<string, readonly string[]>): string[] {
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map<string, number>();
	for (const id of agentIds) color.set(id, WHITE);
	const stackPath: string[] = [];

	function visit(node: string): string[] {
		color.set(node, GRAY);
		stackPath.push(node);
		for (const next of adjacency.get(node) ?? []) {
			if (color.get(next) === GRAY) {
				// Back edge to an ancestor on the current DFS stack -> cycle.
				const start = stackPath.indexOf(next);
				return stackPath.slice(start).concat([next]);
			}
			if (color.get(next) === WHITE) {
				const found = visit(next);
				if (found.length > 0) return found;
			}
		}
		stackPath.pop();
		color.set(node, BLACK);
		return [];
	}

	for (const id of agentIds) {
		if (color.get(id) === WHITE) {
			const found = visit(id);
			if (found.length > 0) return found;
		}
	}
	return [];
}

/** One cycle's guard verdict: guarded cycles carry the hop the walk excludes to move past them. */
type GuardVerdict =
	| { guarded: true; hop: [string, string] }
	| { guarded: false; /** The row-specific diagnosis for the error message, when a misplaced `$count` row exists. */ finding?: string };

/**
 * The guard test for one cycle path `[a…k, a]`, per docs/proposals/loops.md:
 * (a) some hop (u → v) of the path where every connection u → v lands on an
 * input port of v declaring a `bound` — the delivery-cap mechanics, sound by
 * construction; or (b) a valued `$count` row on a path node whose port wires
 * nowhere on the cycle, positioned before every row that does. First guard
 * wins; the message names rows only when (b) found misplaced candidates.
 */
function cycleGuard(cycle: readonly string[], ports: PortGraph, bindingsByAgent: ReadonlyMap<string, OutputBinding[]>): GuardVerdict {
	for (let i = 0; i < cycle.length - 1; i++) {
		const u = cycle[i];
		const v = cycle[i + 1];
		if (hopBound(u, v, ports)) return { guarded: true, hop: [u, v] };
	}
	return countEscapeGuard(cycle, ports, bindingsByAgent);
}

/**
 * True when the hop u → v is bound-guarded: every connection u → v that
 * resolves lands on an input port of v declaring a `bound`. "Every" is
 * load-bearing — the kernel delivers over each connection independently, so a
 * bound port sharing its hop with an unbounded parallel edge caps nothing.
 * Connections whose ports do not resolve are invisible here (they never
 * deliver; the connections pass reports them).
 */
function hopBound(u: string, v: string, ports: PortGraph): boolean {
	const node = ports.byId[v];
	if (node === undefined) return false;
	let edges = 0;
	for (const port of node.inputs) {
		for (const edge of port.edges) {
			if (edge.source !== u) continue;
			edges += 1;
			if (port.bound === undefined) return false;
		}
	}
	return edges > 0;
}

/**
 * The `$count` escape (guard test (b)): a VALUED `$count` row on a path node
 * whose port wires nowhere on the cycle, positioned before every row that
 * does. Both clauses are load-bearing: a count row shadowed by a row above it
 * that wires back into the cycle never fires (`verdict == fix` above
 * `$count >= 3`), and a count row aimed back INTO the cycle re-matches every
 * firing from the threshold on — neither guards; the finding names the rows.
 * A row whose port wires nowhere guards: from the threshold on the count row
 * matches FIRST (first-match-wins), so the rows below it that loop go quiet —
 * the escape needs to stop the loop-back rows, not to go anywhere. The walk
 * excludes the producer's outgoing hop on the path (that edge is what goes
 * quiet at the threshold).
 */
function countEscapeGuard(cycle: readonly string[], ports: PortGraph, bindingsByAgent: ReadonlyMap<string, OutputBinding[]>): GuardVerdict {
	const pathNodes = new Set(cycle);
	const wiresInto = (nodeId: string, portName: string): boolean => {
		const port = ports.byId[nodeId]?.outputs.find((p) => p.name === portName);
		return port !== undefined && port.edges.some((edge) => pathNodes.has(edge.target));
	};
	let finding: string | undefined;
	for (const nodeId of cycle.slice(0, -1)) {
		const rows = bindingsByAgent.get(nodeId) ?? [];
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (row == null || typeof row !== "object" || row.field !== COUNT_KEY) continue;
			// A valueless $count row is the catch-all — it needs a structured
			// result (the honest quiet), so it is no budget.
			if (!isValuedRow(row)) continue;
			const label = `the $count row "${argStr(row.port)}" on "${nodeId}"`;
			if (wiresInto(nodeId, argStr(row.port))) {
				finding ??= `${label} wires back into the loop — it re-matches every iteration instead of escaping it`;
				continue;
			}
			let shadower = -1;
			for (let j = 0; j < i; j++) {
				const above = rows[j];
				if (above == null || typeof above !== "object") continue;
				if (wiresInto(nodeId, argStr(above.port))) {
					shadower = j;
					break;
				}
			}
			if (shadower >= 0) {
				finding ??= `${label} sits below row "${argStr(rows[shadower].port)}", which wires back into the loop and shadows it`;
				continue;
			}
			const at = cycle.indexOf(nodeId);
			return { guarded: true, hop: [nodeId, cycle[at + 1]] };
		}
	}
	return { guarded: false, ...(finding !== undefined ? { finding } : {}) };
}

/**
 * The seed-once deadlock, one `cycle-entry-all-of` warning per starved entry
 * port: a cycle node's input port under the default all-of policy that
 * receives an edge from the cycle AND wires at least one more source. all-of
 * is per-SOURCE (the P3 firing rule): a source beyond the loop-back delivers
 * once and is consumed, so from then on the port can never hold a message
 * from every source again — the loop body never fires. When BOTH sources lie
 * on cycles the warning can over-fire (both deliver per iteration); the
 * `any-of` advice stays safe either way. `any-of` is the fix, and the
 * message says so. Deduplicated per port across the walk's cycles.
 */
function collectEntryWarnings(cycle: readonly string[], ports: PortGraph, seen: Set<string>, out: string[]): void {
	const pathNodes = new Set(cycle);
	for (const nodeId of new Set(cycle)) {
		const node = ports.byId[nodeId];
		if (node === undefined) continue;
		for (const port of node.inputs) {
			if (port.policy !== "all-of") continue;
			if (port.sources.length < 2) continue;
			if (!port.sources.some((source) => pathNodes.has(source))) continue;
			const key = `${nodeId}\u0000${port.portId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(`agent "${nodeId}" input port "${port.portId}" sits on a cycle (${cycle.join(" -> ")}) and receives from ${port.sources.length} sources (${port.sources.join(", ")}) under the default all-of policy — all-of waits for every wired source, and a source beyond the loop-back delivers once and is consumed, so the loop body can never fire; set the port's policy to "any-of"`);
		}
	}
}

// ---- The canvas authoring assist (docs/proposals/loops.md, L3) -------------
// Pure decisions for the browser half: whether a drop closes a cycle, and the
// entry-port flip that preempts the seed-once deadlock. Both answers come from
// the LOWERED graph — lowerControls contracts each control onto its producer,
// so a branch edge drawn back to an earlier agent is seen exactly as the
// kernel will run it — never from a second, hand-rolled control adjacency.

/** The canvas assist's verdict for one prospective connection (see cycleClosingFlip). */
export interface CycleClosingVerdict {
	/** True when adding the connection closes a directed cycle. */
	closesCycle: boolean;
	/**
	 * The target agent's rewritten `inputPorts` declaration — the entered port
	 * flipped to "any-of", or the default entry declared as any-of — present
	 * only when a cycle-closing drop can safely make the flip (the assist that
	 * preempts `cycle-entry-all-of`). Absent when: the drop closes no cycle,
	 * the target is a control (it owns no input port), the entered port is
	 * already any-of, the ports do not resolve, or the flip would orphan
	 * legacy wiring. The declaration is a real graph edit the canvas writes
	 * verbatim — visible in the agent panel and View JSON.
	 */
	inputPorts?: InputPortSpec[];
}

/**
 * The backward-edge assist's decision (loops L3): does adding this connection
 * close a directed cycle, and which target input port must flip to "any-of"?
 *
 * Cycle detection runs on the lowered form of the honest graph PLUS the
 * prospective connection (lowerControls — the same contraction the run path
 * applies), so a control's branch edge is judged as the owner-agent edge it
 * becomes. The drop closes a cycle exactly when its target can reach its
 * source WITHOUT it — walkCycles reports the first cycle of a graph, not
 * whether a given hop joins one, so the after-graph alone cannot tell a
 * loop-closing back edge from an unrelated wire dropped into an
 * already-cyclic graph (the multi-loop canvases this feature enables); the
 * reachability probe below is the minimal exact consumer of the same lowered
 * machinery.
 *
 * The flip follows the pinned policy: the default entry is declared as
 * `inputPorts: [{ name: "in", policy: "any-of" }]` only when the entered wire
 * id IS the agent's default in-port — a hand-edited legacy `input` string
 * resolves to a different port id, and declaring `inputPorts` there would
 * orphan the existing wiring (skip the flip; the warning speaks) — else the
 * entered declared port's policy set to "any-of" in place (bound and side
 * preserved). A port already at "any-of" needs no flip.
 *
 * Total over malformed input: anything unresolved returns
 * `{ closesCycle: false }`, never throws.
 *
 * @param graph - the HONEST graph in its persisted shape (wire-id ports,
 *   controls allowed) WITHOUT the prospective connection.
 * @param connection - the prospective connection in the same persisted shape
 *   (a control-targeted edge carries no targetPort, a control-sourced one
 *   names its branch as sourcePort).
 */
export function cycleClosingFlip(graph: unknown, connection: unknown): CycleClosingVerdict {
	if (graph == null || typeof graph !== "object" || Array.isArray(graph)) return { closesCycle: false };
	if (connection == null || typeof connection !== "object") return { closesCycle: false };
	const honest = graph as { agents?: unknown; connections?: unknown };
	const conn = connection as { id?: unknown; source?: unknown; target?: unknown };
	const connId = argStr(conn.id);
	const target = argStr(conn.target);
	if (connId.length === 0 || argStr(conn.source).length === 0 || target.length === 0) return { closesCycle: false };

	const agentIds = new Set<string>();
	for (const agent of Array.isArray(honest.agents) ? honest.agents : []) {
		if (agent == null || typeof agent !== "object") continue;
		const id = argStr((agent as { id?: unknown }).id);
		if (id.length > 0) agentIds.add(id);
	}

	// The prospective hop in lowered form — a control-sourced edge re-sources
	// onto its owner there (found by connection id; lowering preserves ids).
	const after = lowerControls({
		...honest,
		connections: [...(Array.isArray(honest.connections) ? honest.connections : []), connection],
	} as PipelineGraph);
	let hopSource = "";
	let hopTarget = "";
	for (const c of Array.isArray(after.connections) ? after.connections : []) {
		if (c == null || typeof c !== "object") continue;
		const rec = c as { id?: unknown; source?: unknown; target?: unknown };
		if (argStr(rec.id) !== connId) continue;
		hopSource = argStr(rec.source);
		hopTarget = argStr(rec.target);
		break;
	}
	// A control-targeted edge lowers away entirely (the control's single
	// unnamed input is not agent wiring): the helper reports no close for it —
	// its target is a control, which owns no input port to flip, and the
	// entry-port warning speaks for the honest cycle such a drop completes.
	if (hopSource.length === 0 || hopTarget.length === 0 || !agentIds.has(hopSource) || !agentIds.has(hopTarget)) {
		return { closesCycle: false };
	}
	// The drop closes a cycle iff its target reaches its source without it —
	// trivially true for a self-hop (a branch wired back to its own feeder
	// lowers to a one-node cycle the new edge itself closes).
	const closes = hopSource === hopTarget || reaches(lowerControls(honest as PipelineGraph), hopTarget, hopSource);
	if (!closes) return { closesCycle: false };

	// Port resolution on the HONEST graph — the flip edits the authoring
	// declaration, not the lowered twin.
	const targetNode = portGraph(graph).byId[target];
	if (targetNode === undefined) return { closesCycle: true };
	const wireId = argStr((connection as { targetPort?: unknown }).targetPort) || target + ":in";
	const port = targetNode.inputById[wireId];
	if (port === undefined || port.policy === "any-of") return { closesCycle: true };
	const rec = agentRecord(honest, target);
	if (rec === undefined) return { closesCycle: true };
	if (Array.isArray(rec.inputPorts)) {
		const prefix = target + ":";
		const name = wireId.startsWith(prefix) ? wireId.slice(prefix.length) : null;
		if (name === null) return { closesCycle: true };
		let hit = false;
		const inputPorts = (rec.inputPorts as InputPortSpec[]).map((spec) => {
			if (spec == null || typeof spec !== "object" || argStr(spec.name) !== name) return spec;
			hit = true;
			return { ...spec, policy: "any-of" } as InputPortSpec;
		});
		return hit ? { closesCycle: true, inputPorts } : { closesCycle: true };
	}
	// The default single port: declaring `inputPorts` re-ids it to "<id>:in",
	// so the flip is safe only when the wire already carries that id.
	const legacy = typeof rec.input === "string" && rec.input.length > 0 ? rec.input : target + ":in";
	if (wireId !== target + ":in" || legacy !== target + ":in") return { closesCycle: true };
	return { closesCycle: true, inputPorts: [{ name: port.name, policy: "any-of" }] };
}

/** Adjacency (source -> targets) over a connections array; with `ids`, only edges whose both endpoints are known. */
function adjacencyOver(connections: unknown, ids: ReadonlySet<string> | null): Map<string, string[]> {
	const adjacency = new Map<string, string[]>();
	for (const conn of Array.isArray(connections) ? connections : []) {
		if (conn == null || typeof conn !== "object") continue;
		const rec = conn as { source?: unknown; target?: unknown };
		const source = argStr(rec.source);
		const next = argStr(rec.target);
		if (source.length === 0 || next.length === 0) continue;
		if (ids !== null && (!ids.has(source) || !ids.has(next))) continue;
		adjacency.set(source, (adjacency.get(source) ?? []).concat([next]));
	}
	return adjacency;
}

/** The nodes reachable from `start` in one or more hops (start included only via a cycle back to it). */
function reachableFrom(adjacency: ReadonlyMap<string, readonly string[]>, start: string): Set<string> {
	const seen = new Set<string>();
	const queue = [...(adjacency.get(start) ?? [])];
	while (queue.length > 0) {
		const node = queue.shift() as string;
		if (seen.has(node)) continue;
		seen.add(node);
		queue.push(...(adjacency.get(node) ?? []));
	}
	return seen;
}

/** True when `to` is reachable from `from` over the lowered graph's connections. */
function reaches(lowered: { connections?: unknown }, from: string, to: string): boolean {
	return reachableFrom(adjacencyOver(lowered.connections, null), from).has(to);
}

/** Read one agent record out of the graph's agents array by id (first match). */
function agentRecord(graph: { agents?: unknown }, id: string): Record<string, unknown> | undefined {
	for (const agent of Array.isArray(graph.agents) ? graph.agents : []) {
		if (agent == null || typeof agent !== "object") continue;
		if (argStr((agent as { id?: unknown }).id) === id) return agent as Record<string, unknown>;
	}
	return undefined;
}

/**
 * The agent ids lying on at least one directed cycle of the LOWERED graph —
 * the canvas's membership test for the branch editor's shadowing diagnosis
 * (which branches wire back into a loop). Lowered self-loops count (a branch
 * wired back to its own feeder is a real one-node cycle the kernel runs), and
 * so would an honest self-connection, which validateGraph refuses separately.
 * Total over malformed declarations; never throws.
 */
export function cycleNodeIds(graph: unknown): ReadonlySet<string> {
	const lowered = lowerControls(graph as PipelineGraph);
	const ids = new Set<string>();
	for (const agent of Array.isArray(lowered.agents) ? lowered.agents : []) {
		if (agent == null || typeof agent !== "object") continue;
		const id = argStr((agent as { id?: unknown }).id);
		if (id.length > 0) ids.add(id);
	}
	const adjacency = adjacencyOver(lowered.connections, ids);
	const onCycle = new Set<string>();
	for (const id of ids) {
		// Self-reachability: id lies on a cycle iff id reaches id.
		if (reachableFrom(adjacency, id).has(id)) onCycle.add(id);
	}
	return onCycle;
}
