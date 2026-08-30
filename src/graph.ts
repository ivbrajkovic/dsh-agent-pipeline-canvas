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
//     executor's quiescence), so validateGraph reports a cycle as a non-fatal
//     `cycle-present` WARNING, never an error. (The legacy sequential runner
//     only runs an acyclic prefix; the warning tells the author that.)
//   - The graph must not contain a self-connection, duplicate edge, invalid
//     port declaration, or a reference to a missing agent/port; see
//     validateGraph.
//
// The format is backward-compatible: the port fields are additive, and a graph
// without them means one `in` port (all-of, unbounded) and one `out` port —
// exactly the historical shape. This module only ADDS the validation a runner
// will rely on; it does not alter the on-disk shape.

import type { ValidationError, ValidationResult } from "./types.ts";
import { portGraph } from "./execution.ts";

/** Input-port delivery policies a spec may declare. */
const PORT_POLICIES = ["all-of", "any-of"] as const;

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
			id?: unknown; input?: unknown; output?: unknown; inputPorts?: unknown; outputPorts?: unknown;
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

		validatePortDeclarations(id, rec, errors);
	}

	// ---- Port resolution (declared lists, else the legacy defaults) --------
	// One shared derivation with the run kernel: which ports exist, their wire
	// ids, and which edges attach where.
	const ports = portGraph(graph);

	// ---- Output bindings (selective emission — conditional-dispatch §2) ----
	// A binding is data on the node: an array of { field, port, value? } rules
	// the executor evaluates against the firing's structured result. The
	// declaration must be well-shaped and each binding's port must name one of
	// the agent's DECLARED (or default) output ports — the same membership a
	// connection's source port must satisfy. Whether a binding will actually
	// match a run's result is data, not shape: never validated here.
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
			const binding = entry as { field?: unknown; port?: unknown; value?: unknown } | null | undefined;
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

		const hasSource = source.length > 0 && agentIds.has(source);
		const hasTarget = target.length > 0 && agentIds.has(target);

		if (source.length > 0 && !agentIds.has(source)) {
			errors.push({ code: "connection-source-missing", message: `connection references unknown source agent "${source}"` });
		}
		if (target.length > 0 && !agentIds.has(target)) {
			errors.push({ code: "connection-target-missing", message: `connection references unknown target agent "${target}"` });
		}
		if (source.length > 0 && target.length > 0 && source === target) {
			errors.push({ code: "connection-self", message: `connection ${source} -> ${target} connects an agent to itself` });
		}

		// Port wiring: a connection must leave one of the source's DECLARED (or
		// default) output ports and enter one of the target's input ports — the
		// exact membership the stream kernel will resolve against (see portGraph).
		// Until that kernel lands, both executors still wire by source/target
		// only and treat declared ports as the single default pair.
		const srcNode = hasSource ? ports.byId[source] : undefined;
		const tgtNode = hasTarget ? ports.byId[target] : undefined;

		if (hasSource) {
			if (sourcePort.length === 0) {
				errors.push({ code: "connection-missing-source-port", message: `connection from "${source}" is missing a source port` });
			} else if (srcNode === undefined || srcNode.outputById[sourcePort] === undefined) {
				const declared = srcNode ? srcNode.outputs.map((p) => p.portId).join(", ") : "";
				errors.push({ code: "connection-source-port-mismatch", message: `connection from "${source}" uses source port "${sourcePort}" but "${source}" declares output ports: ${declared.length > 0 ? declared : "none"}` });
			}
		}
		if (hasTarget) {
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

	// ---- Cycle warning (cycles are legal wiring) ---------------------------
	const cycle = findCycle(agentIds, connections);
	if (cycle.length > 0) {
		warnings.push({ code: "cycle-present", message: `pipeline contains a cycle: ${cycle.join(" -> ")} — legal wiring for the stream executor, but the sequential runner only runs its acyclic prefix` });
	}

	return { ok: errors.length === 0, errors, ...(warnings.length > 0 ? { warnings } : {}) };
}

function argStr(value: unknown): string {
	return value == null ? "" : String(value);
}

/**
 * Validate one agent's `inputPorts` / `outputPorts` declarations: lists when
 * present; each input port a spec with a non-empty string name, a known policy
 * ("all-of" | "any-of") and — when present — a positive-integer bound; each
 * output port a non-empty string name; names unique within their list.
 */
function validatePortDeclarations(id: string, rec: { inputPorts?: unknown; outputPorts?: unknown }, errors: ValidationError[]): void {
	if (rec.inputPorts !== undefined) {
		if (!Array.isArray(rec.inputPorts)) {
			errors.push({ code: "agent-port-invalid", message: `agent "${id}" has an invalid inputPorts declaration (must be an array)` });
		} else {
			const seen = new Set<string>();
			for (const spec of rec.inputPorts) {
				const s = spec as { name?: unknown; policy?: unknown; bound?: unknown } | null | undefined;
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
}

/**
 * Detect a directed cycle among the given agents/edges and, when found, return
 * the cycle as a closed path `[a, b, c, a]` (last == first). Self-connections
 * are excluded here because they are reported as `connection-self` separately;
 * they are still cycles, but reporting them once with a targeted message is
 * clearer than folding them into a generic warning. The result feeds the
 * non-fatal `cycle-present` warning — a cycle is legal wiring (the stream
 * executor loops), it is only a hazard for the legacy sequential runner.
 *
 * @param agentIds - the set of known agent ids (the graph's node universe).
 * @param connections - the raw connections array.
 * @returns an empty array when the graph is acyclic, else the cycle path.
 */
function findCycle(agentIds: ReadonlySet<string>, connections: readonly unknown[]): string[] {
	const adj = new Map<string, string[]>();
	for (const id of agentIds) adj.set(id, []);

	for (const conn of connections) {
		if (conn == null || typeof conn !== "object") continue;
		const rec = conn as { source?: unknown; target?: unknown };
		const source = rec.source == null ? "" : String(rec.source);
		const target = rec.target == null ? "" : String(rec.target);
		if (source.length === 0 || target.length === 0) continue;
		if (!agentIds.has(source) || !agentIds.has(target)) continue;
		if (source === target) continue;
		adj.get(source)?.push(target);
	}

	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map<string, number>();
	for (const id of agentIds) color.set(id, WHITE);
	const stackPath: string[] = [];

	function visit(node: string): string[] {
		color.set(node, GRAY);
		stackPath.push(node);
		for (const next of adj.get(node) ?? []) {
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
