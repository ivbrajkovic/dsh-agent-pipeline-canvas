// controls.test.ts — the if control's validation rules and lowering. Plain
// Node script (no framework). Run with:
//   tsx test/controls.test.ts
// Imports the canonical pure implementations from lib/ (the built output of
// src/graph.ts + src/controls.ts; the Host and the browser bundle use the
// same implementations). Covers: every control validation rule fired by a
// targeted bad graph, the lowering equivalence (an if-authored graph lowers
// to exactly its hand-authored ports+bindings twin), the ""-value catch-all
// normalization, and lowering's totality over malformed records.
import { validateGraph } from "../lib/graph.js";
import { lowerControls } from "../lib/controls.js";
import { deepStrictEqual } from "node:assert";

let passed = 0;
let failed = 0;

function check(name: string, graph: unknown, expectOk: boolean, expectCodes: string[], expectWarnings: string[] = []) {
	let result: { ok: boolean; errors: Array<{ code: string }>; warnings?: Array<{ code: string }> };
	try {
		result = validateGraph(graph);
	} catch (error) {
		failed++;
		console.error(`FAIL  ${name} — threw: ${error && (error as Error).message}`);
		return;
	}
	const codes = result.errors.map((e) => e.code).filter((c) => expectCodes.includes(c));
	const all = (a: string[], b: string[]) => a.every((x) => b.includes(x));
	const warnCodes = (result.warnings ?? []).map((w) => w.code);
	if (result.ok !== expectOk || !all(expectCodes, codes) || !all(expectWarnings, warnCodes)) {
		failed++;
		console.error(`FAIL  ${name}`);
		console.error(`  expected ok=${expectOk} codes=${JSON.stringify(expectCodes)} warnings=${JSON.stringify(expectWarnings)}`);
		console.error(`  got      ok=${result.ok} codes=${JSON.stringify(result.errors.map((e) => e.code))} warnings=${JSON.stringify(warnCodes)}`);
		console.error(`  messages ${JSON.stringify(result.errors.map((e) => e.message))}`);
		return;
	}
	passed++;
	console.log(`ok    ${name}`);
}

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
	id, name: id, description: "", instructions: "", x: 0, y: 0, input: id + ":in", output: id + ":out", ...extra,
});
const conn = (id: string, source: string, target: string, sourcePort?: string, targetPort?: string) => ({
	id, source, target,
	...(sourcePort !== undefined ? { sourcePort } : {}),
	...(targetPort !== undefined ? { targetPort } : {}),
});
/** The canonical router sample in if form: Router → ⟨if⟩ → Billing / General. */
const routerControlGraph = () => ({
	agents: [agent("router", { settings: { outputSchema: { type: "object" } } }), agent("billing"), agent("general")],
	connections: [
		conn("c1", "router", "if-1", "router:out"), // the control's single unnamed input
		conn("c2", "if-1", "billing", "if-1:billing", "billing:in"),
		conn("c3", "if-1", "general", "if-1:other", "general:in"),
	],
	controls: [{
		id: "if-1", kind: "if", x: 50, y: 60,
		branches: [
			{ name: "billing", field: "action", value: "billing", side: "top" },
			{ name: "other", field: "action" }, // the catch-all
		],
	}],
});
/** The same pipeline hand-authored over ports+bindings (the lowering twin). */
const twinGraph = () => ({
	agents: [
		agent("router", {
			settings: { outputSchema: { type: "object" } },
			outputPorts: ["billing", "other"],
			bindings: [
				{ field: "action", value: "billing", port: "billing" },
				{ field: "action", port: "other" },
			],
			outputPortSides: { billing: "top" },
		}),
		agent("billing"),
		agent("general"),
	],
	connections: [
		conn("c2", "router", "billing", "router:billing", "billing:in"),
		conn("c3", "router", "general", "router:other", "general:in"),
	],
});

// --- the honest if-graph validates; the twin validates identically ----
check("a valid if-graph validates with no findings", routerControlGraph(), true, []);
check("the hand-authored twin validates with no findings", twinGraph(), true, []);
check("a control edge to a non-default target port is not the control's shape", (() => {
	const graph = routerControlGraph() as { connections: unknown[] };
	graph.connections[0] = conn("c1", "router", "if-1", "router:out", "if-1:in");
	return graph;
})(), false, ["if-edge-port-unknown"]);

// --- control-invalid (record shape and id space) -----------------------
check("controls not an array", { agents: [agent("a")], connections: [], controls: "nope" }, false, ["control-invalid"]);
check("control entry not an object", { agents: [agent("a")], connections: [], controls: [7] }, false, ["control-invalid"]);
check("control missing an id", { agents: [agent("a")], connections: [], controls: [{ kind: "if", branches: [{ name: "x" }] }] }, false, ["control-invalid"]);
check("control missing a kind", { agents: [agent("a")], connections: [], controls: [{ id: "if-1", branches: [{ name: "x" }] }] }, false, ["control-invalid"]);
check("duplicate control id", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [
		{ id: "if-1", kind: "if", branches: [{ name: "x" }] },
		{ id: "if-1", kind: "if", branches: [{ name: "y" }] },
	],
}, false, ["control-invalid"]);
check("control id colliding with an agent id", {
	agents: [agent("a"), agent("if-1")],
	connections: [],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x" }] }],
}, false, ["control-invalid"]);

// --- if-source-invalid (exactly one agent feeds it) ---------------------
check("control with no incoming connection", {
	agents: [agent("a")],
	connections: [],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, false, ["if-source-invalid"]);
check("control with two incoming connections", {
	agents: [agent("a"), agent("b")],
	connections: [conn("c1", "a", "if-1", "a:out"), conn("c2", "b", "if-1", "b:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, false, ["if-source-invalid"]);
check("control fed by another control", {
	agents: [agent("a"), agent("b")],
	connections: [
		conn("c1", "a", "if-1", "a:out"),
		conn("c2", "if-1", "if-2", "if-1:x", ""),
		conn("c3", "if-2", "b", "if-2:y", "b:in"),
	],
	controls: [
		{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] },
		{ id: "if-2", kind: "if", branches: [{ name: "y", field: "f", value: "1" }, { name: "z" }] },
	],
}, false, ["if-source-invalid"]);

// --- if-owner-conflict (the if owns the source's emission surface) ------
check("source agent declares its own output ports", {
	agents: [agent("a", { outputPorts: ["x"] })],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, false, ["if-owner-conflict"]);
check("source agent declares its own bindings", {
	agents: [agent("a", { bindings: [{ field: "f", port: "out" }] })],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, false, ["if-owner-conflict"]);
check("source agent has another outgoing edge", {
	agents: [agent("a"), agent("b")],
	connections: [conn("c1", "a", "if-1", "a:out"), conn("c2", "a", "b", "a:out", "b:in")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, false, ["if-owner-conflict"]);
check("source agent feeds two controls", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out"), conn("c2", "a", "if-2", "a:out")],
	controls: [
		{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] },
		{ id: "if-2", kind: "if", branches: [{ name: "x", field: "f", value: "2" }, { name: "y" }] },
	],
}, false, ["if-owner-conflict"]);

// --- if-branch-invalid ---------------------------------------------------
check("control with no branches", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [] }],
}, false, ["if-branch-invalid"]);
check("duplicate branch names", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "x", field: "f", value: "2" }] }],
}, false, ["if-branch-invalid"]);
check("valued branch without a field", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", value: "1" }, { name: "y" }] }],
}, false, ["if-branch-invalid"]);
check("catch-all before the last branch", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f" }, { name: "y", field: "f", value: "1" }] }],
}, false, ["if-branch-invalid"]);
check("an empty-string value counts as the catch-all (and must be last)", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "" }, { name: "y", field: "f", value: "1" }] }],
}, false, ["if-branch-invalid"]);
check("unknown branch side", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1", side: "north" }, { name: "y" }] }],
}, false, ["if-branch-invalid"]);

// --- non-fatal findings --------------------------------------------------
check("two default-side branches stack with a warning", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y", field: "f", value: "2" }] }],
}, true, [], ["if-side-conflict"]);
check("a schema-less source warns", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, true, [], ["if-source-no-schema"]);
check("a breakpointed source warns", {
	agents: [agent("a", { breakpoint: true, settings: { outputSchema: { type: "object" } } })],
	connections: [conn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, true, [], ["if-source-breakpointed"]);

// --- edges and cycles ----------------------------------------------------
check("control-sourced edge naming an unknown branch", (() => {
	const graph = routerControlGraph() as { connections: unknown[] };
	graph.connections[1] = conn("c2", "if-1", "billing", "if-1:zzz", "billing:in");
	return graph;
})(), false, ["if-edge-port-unknown"]);
check("two branches of one if may reach one target (the validator allows distinct ports)", (() => {
	const graph = routerControlGraph() as { connections: unknown[] };
	graph.connections[2] = conn("c3", "if-1", "billing", "if-1:other", "billing:in");
	return graph;
})(), true, []);
check("a cycle through the control warns on the agent path", (() => {
	const graph = routerControlGraph() as { connections: unknown[] };
	graph.connections.push(conn("c4", "billing", "router", "billing:out", "router:in"));
	return graph;
})(), true, [], ["cycle-present"]);
check("duplicate control edge is reported", (() => {
	const graph = routerControlGraph() as { connections: unknown[] };
	graph.connections.push(conn("c2b", "if-1", "billing", "if-1:billing", "billing:in"));
	return graph;
})(), false, ["connection-duplicate"]);
check("a future control kind validates as a plain endpoint", {
	agents: [agent("a")],
	connections: [conn("c1", "a", "if-9", "a:out")],
	controls: [{ id: "if-9", kind: "later", branches: [] }],
}, true, []);

// --- lowering ------------------------------------------------------------
{
	let ok = true;
	const attempt = (name: string, run: () => void) => {
		try {
			run();
			passed++;
			console.log(`ok    ${name}`);
		} catch (error) {
			ok = false;
			failed++;
			console.error(`FAIL  ${name} — ${error && (error as Error).message}`);
		}
	};

	attempt("the if-graph lowers to exactly its hand-authored twin", () => {
		deepStrictEqual(lowerControls(routerControlGraph() as never), twinGraph());
	});
	attempt("the twin itself validates", () => {
		deepStrictEqual(validateGraph(lowerControls(routerControlGraph() as never)).ok, true);
	});
	attempt("a legacy graph (no controls) lowers to itself", () => {
		const legacy = { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b", "a:out", "b:in")] };
		deepStrictEqual(lowerControls(legacy as never), legacy);
	});
	attempt("an empty controls list lowers to itself", () => {
		const legacy = { agents: [agent("a")], connections: [], controls: [] };
		const lowered = lowerControls(legacy as never) as { controls?: unknown };
		deepStrictEqual(lowered, legacy);
	});
	attempt("an empty-string branch value normalizes to a valueless binding", () => {
		const lowered = lowerControls({
			agents: [agent("a")],
			connections: [conn("c1", "a", "if-1", "a:out")],
			controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y", field: "f", value: "" }] }],
		} as never) as { agents: Array<{ outputPorts?: string[]; bindings?: Array<Record<string, unknown>>; outputPortSides?: Record<string, string> }> };
		deepStrictEqual(lowered.agents[0].outputPorts, ["x", "y"]);
		deepStrictEqual(lowered.agents[0].bindings, [{ field: "f", port: "x", value: "1" }, { field: "f", port: "y" }]);
		deepStrictEqual(lowered.agents[0].outputPortSides, undefined, "all-default sides keep the map off the clone");
	});
	attempt("total over malformed records: normalize or skip, never throw", () => {
		// A control with no feed is skipped whole; its edges vanish with it.
		const skipped = lowerControls({
			agents: [agent("a"), agent("b")],
			connections: [conn("c1", "a", "b", "a:out", "b:in"), conn("c9", "a", "if-1", "a:out")],
			controls: [7, { id: "if-1", kind: "later", branches: [] }],
		} as never);
		deepStrictEqual(skipped, { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b", "a:out", "b:in")] });
		// A branchless but fed control lowers faithfully onto its owner.
		const branchless = lowerControls({
			agents: [agent("a"), agent("b")],
			connections: [conn("c1", "a", "b", "a:out", "b:in"), conn("c9", "a", "if-1", "a:out")],
			controls: [7, { id: "if-1", kind: "if", branches: [{ name: "x" }] }],
		} as never) as { agents: Array<{ outputPorts?: string[]; bindings?: unknown }> };
		deepStrictEqual(branchless.agents[0].outputPorts, ["x"]);
		deepStrictEqual(branchless.agents[0].bindings, [{ port: "x" }]);
		deepStrictEqual((branchless as { connections: unknown[] }).connections.length, 1, "the control's feeding edge is gone");
	});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
