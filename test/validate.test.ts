// validateGraph smoke test — plain Node script (no framework). Run with:
//   tsx test/validate.test.ts
// Imports the canonical pure implementation from lib/graph.js (the built output
// of src/graph.ts; the Host and the browser bundle use the same implementation).
import { validateGraph, cycleClosingFlip } from "../lib/graph.js";
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

const agent = (id: string) => ({ id, name: id, description: "", instructions: "", x: 0, y: 0, input: id + ":in", output: id + ":out" });
const conn = (id: string, source: string, target: string) => ({ id, source, target, sourcePort: source + ":out", targetPort: target + ":in" });
/** An agent with declared port lists (no legacy input/output strings — a stream-model node). */
const portsAgent = (id: string, inputPorts?: unknown[], outputPorts?: string[]) => ({
	id, name: id, description: "", instructions: "", x: 0, y: 0,
	...(inputPorts !== undefined ? { inputPorts } : {}),
	...(outputPorts !== undefined ? { outputPorts } : {}),
});
const portConn = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort });
/** A control-edge connection: ports only where the control contract carries them. */
const controlConn = (id: string, source: string, target: string, sourcePort?: string) => ({
	id, source, target,
	...(sourcePort !== undefined ? { sourcePort } : {}),
});

// --- valid / degenerate ---------------------------------------------
check("null pipeline", null, true, []);
check("undefined pipeline", undefined, true, []);
check("empty graph", { agents: [], connections: [] }, true, []);
check("isolated single agent", { agents: [agent("a")], connections: [] }, true, []);
check("linear A->B", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b")] }, true, []);
check("fan-out A->B,A->C", { agents: [agent("a"), agent("b"), agent("c")], connections: [conn("c1", "a", "b"), conn("c2", "a", "c")] }, true, []);
check("fan-in A->C,B->C", { agents: [agent("a"), agent("b"), agent("c")], connections: [conn("c1", "a", "c"), conn("c2", "b", "c")] }, true, []);

// --- cycles: legal wiring, but every cycle carries its guard -------------
// An unguarded cycle is the `cycle-unguarded` ERROR (loops L2); the guard is
// a bound on a hop of the cycle or a valued $count row escaping it (the
// matrix lives in the cycle-guard section below).
check("unguarded cycle A->B->A is refused", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b"), conn("c2", "b", "a")] }, false, ["cycle-unguarded"], ["cycle-present"]);
check("unguarded named-port cycle is refused", { agents: [portsAgent("a", [{ name: "resp" }], ["request"]), portsAgent("b", [{ name: "req", policy: "any-of" }], ["feedback"])], connections: [portConn("c1", "a", "a:request", "b", "b:req"), portConn("c2", "b", "b:feedback", "a", "a:resp")] }, false, ["cycle-unguarded"], ["cycle-present"]);
check("self cycle A->->A", { agents: [agent("a")], connections: [conn("c1", "a", "a")] }, false, ["connection-self"]);

// --- missing / unknown agents --------------------------------------
check("missing source agent id", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", target: "b", sourcePort: "", targetPort: "b:in" }] }, false, ["connection-missing-source"]);
check("unknown source", { agents: [agent("a"), agent("b")], connections: [conn("c1", "zzz", "b")] }, false, ["connection-source-missing"]);
check("unknown target", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "zzz")] }, false, ["connection-target-missing"]);

// --- ports (legacy single-port graphs) -------------------------------
check("mismatched source port", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", source: "a", target: "b", sourcePort: "a:in", targetPort: "b:in" }] }, false, ["connection-source-port-mismatch"]);
check("mismatched target port", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", source: "a", target: "b", sourcePort: "a:out", targetPort: "b:out" }] }, false, ["connection-target-port-mismatch"]);
check("missing source port", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", source: "a", target: "b", targetPort: "b:in" }] }, false, ["connection-missing-source-port"]);
check("missing target port", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", source: "a", target: "b", sourcePort: "a:out" }] }, false, ["connection-missing-target-port"]);
check("invalid agent port (empty output)", { agents: [{ id: "a", name: "a", x: 0, y: 0, input: "a:in", output: "" }], connections: [] }, false, ["agent-port-invalid"]);
check("legacy custom port strings still wire (compat)", { agents: [{ ...agent("a"), output: "a:custom-out" }, { ...agent("b"), input: "b:custom-in" }], connections: [portConn("c1", "a", "a:custom-out", "b", "b:custom-in")] }, true, []);

// --- named ports (the stream node model) ------------------------------
check("named ports validate", { agents: [portsAgent("a", undefined, ["result"]), portsAgent("b", [{ name: "data", policy: "all-of", bound: 5 }])], connections: [portConn("c1", "a", "a:result", "b", "b:data")] }, true, []);
check("any-of policy + no bound validate", { agents: [portsAgent("a", [{ name: "x", policy: "any-of" }])], connections: [] }, true, []);
check("empty inputPorts list validates (never fires)", { agents: [portsAgent("a", [])], connections: [] }, true, []);
check("empty outputPorts list validates (emits nowhere)", { agents: [portsAgent("a", undefined, [])], connections: [] }, true, []);
check("unknown target port on named input", { agents: [portsAgent("a", undefined, ["result"]), portsAgent("b", [{ name: "data" }])], connections: [portConn("c1", "a", "a:result", "b", "b:in")] }, false, ["connection-target-port-mismatch"]);
check("unknown source port on named output", { agents: [portsAgent("a", undefined, ["result"]), portsAgent("b", [{ name: "data" }])], connections: [portConn("c1", "a", "a:out", "b", "b:data")] }, false, ["connection-source-port-mismatch"]);
check("input port name used as a source port", { agents: [portsAgent("a", [{ name: "data" }]), portsAgent("b", [{ name: "data" }])], connections: [portConn("c1", "a", "a:data", "b", "b:data")] }, false, ["connection-source-port-mismatch"]);
check("declared ports replace the default name", { agents: [portsAgent("a", undefined, ["alt"]), portsAgent("b", [{ name: "in" }])], connections: [portConn("c1", "a", "a:out", "b", "b:in")] }, false, ["connection-source-port-mismatch"]);

// --- named-port declaration errors -----------------------------------
check("unknown policy", { agents: [portsAgent("a", [{ name: "x", policy: "some-of" }])], connections: [] }, false, ["agent-port-policy-invalid"]);
check("bound zero invalid", { agents: [portsAgent("a", [{ name: "x", bound: 0 }])], connections: [] }, false, ["agent-port-bound-invalid"]);
check("bound non-integer invalid", { agents: [portsAgent("a", [{ name: "x", bound: 2.5 }])], connections: [] }, false, ["agent-port-bound-invalid"]);
check("duplicate input port names", { agents: [portsAgent("a", [{ name: "x" }, { name: "x" }])], connections: [] }, false, ["agent-port-duplicate"]);
check("duplicate output port names", { agents: [portsAgent("a", undefined, ["y", "y"])], connections: [] }, false, ["agent-port-duplicate"]);
check("inputPorts not an array", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, inputPorts: "nope" }], connections: [] }, false, ["agent-port-invalid"]);
check("input port spec missing name", { agents: [portsAgent("a", [{ policy: "any-of" }])], connections: [] }, false, ["agent-port-invalid"]);
check("outputPorts entry not a string", { agents: [portsAgent("a", undefined, [7])], connections: [] }, false, ["agent-port-invalid"]);

// --- port sides (edge-routing iteration 2) ------------------------------
// Sides are presentational; more than one port on a resolved node edge warns
// (agent-port-side-conflict) and renders stacked.
{
	const result = validateGraph({
		agents: [{
			id: "a", name: "a", description: "", instructions: "", x: 0, y: 0,
			inputPorts: [{ name: "in" }, { name: "feedback", policy: "any-of", bound: 3, side: "bottom" }],
			outputPorts: ["feedback", "result"],
			outputPortSides: { feedback: "top" },
		}],
		connections: [],
	});
	deepStrictEqual(result.ok, true, "one port per side validates");
	deepStrictEqual(result.warnings, undefined, "one port per side raises no side warning");
	passed++;
	console.log("ok    one port per side (all four edges) validates without warnings");
}
check("two default-left input ports stack with a warning", { agents: [portsAgent("a", [{ name: "x" }, { name: "y" }])], connections: [] }, true, [], ["agent-port-side-conflict"]);
check("input left vs output pulled to left warns", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, inputPorts: [{ name: "x" }], outputPorts: ["y"], outputPortSides: { y: "left" } }], connections: [] }, true, [], ["agent-port-side-conflict"]);
check("two outputs on the default right warn but stay valid", { agents: [portsAgent("a", undefined, ["mail", "slack"])], connections: [] }, true, [], ["agent-port-side-conflict"]);
check("sided loop cycle stays legal wiring (the bound caps the loop hop)", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, inputPorts: [{ name: "resp", bound: 3 }], outputPorts: ["request"], outputPortSides: { request: "bottom" } }, { id: "b", name: "b", description: "", instructions: "", x: 0, y: 0, inputPorts: [{ name: "req", policy: "any-of" }, { name: "fix", policy: "any-of", bound: 3, side: "bottom" }], outputPorts: ["out"] }], connections: [portConn("c1", "a", "a:request", "b", "b:req"), portConn("c2", "b", "b:out", "a", "a:resp")] }, true, [], ["cycle-present"]);
check("unknown input side value", { agents: [portsAgent("a", [{ name: "x", side: "north" }])], connections: [] }, false, ["agent-port-side-invalid"]);
check("unknown output side value", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, outputPorts: ["y"], outputPortSides: { y: "up" } }], connections: [] }, false, ["agent-port-side-invalid"]);
check("outputPortSides names an undeclared port", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, outputPorts: ["y"], outputPortSides: { z: "top" } }], connections: [] }, false, ["agent-port-side-invalid"]);
check("outputPortSides not an object", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, outputPorts: ["y"], outputPortSides: "top" }], connections: [] }, false, ["agent-port-side-invalid"]);

// --- bindings (selective emission, P7) ---------------------------------
check("binding to a declared output port validates", { agents: [portsAgent("a", undefined, ["mail", "slack"])], connections: [] }, true, []);
// portsAgent has no settings slot; the raw agent spread carries bindings.
{
	const result = validateGraph({
		agents: [{
			id: "a", name: "a", description: "", instructions: "", x: 0, y: 0,
			outputPorts: ["mail", "slack"],
			bindings: [{ field: "action", value: "mail", port: "mail" }, { field: "action", port: "slack" }],
		}],
		connections: [],
	});
	deepStrictEqual(result.ok, true, "named bindings (incl. catch-all) validate");
	passed++;
	console.log("ok    named bindings (incl. catch-all) validate");
}
check("binding to the default out port validates", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, bindings: [{ field: "ok", value: true, port: "out" }] }], connections: [] }, true, []);
check("binding to an undeclared port", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, outputPorts: ["mail"], bindings: [{ field: "action", value: "mail", port: "slack" }] }], connections: [] }, false, ["agent-binding-port-mismatch"]);
{
	const result = validateGraph({
		agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, outputPorts: [], bindings: [{ field: "action", value: "x", port: "out" }] }],
		connections: [],
	});
	deepStrictEqual(result.errors.map((e) => e.code), ["agent-binding-port-mismatch"], "binding on an emits-nowhere node mismatches");
	passed++;
	console.log("ok    binding on an emits-nowhere node mismatches");
}
check("bindings not an array", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, bindings: "nope" }], connections: [] }, false, ["agent-binding-invalid"]);
check("binding without a field", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, outputPorts: ["out"], bindings: [{ port: "out" }] }], connections: [] }, false, ["agent-binding-invalid"]);
check("binding without a port", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, bindings: [{ field: "action" }] }], connections: [] }, false, ["agent-binding-invalid"]);

// --- binding ops (docs/proposals/loops.md L1 — the hand-authored loop) ----
check("a >= binding over the reserved $count validates", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, outputPorts: ["retry", "done"], bindings: [{ field: "$count", value: "1", op: ">=", port: "retry" }, { field: "$count", value: "3", op: ">=", port: "done" }] }], connections: [] }, true, []);
check("an explicit == binding validates like the absent default", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, bindings: [{ field: "action", value: "mail", op: "==", port: "out" }] }], connections: [] }, true, []);
check("binding with an unknown op", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, bindings: [{ field: "f", value: "1", op: "<", port: "out" }] }], connections: [] }, false, ["agent-binding-invalid"]);
check("a >= binding whose value is not a finite number", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, bindings: [{ field: "f", value: "soon", op: ">=", port: "out" }] }], connections: [] }, false, ["agent-binding-invalid"]);

// --- duplicate ids / connections -----------------------------------
check("duplicate agent id", { agents: [agent("a"), agent("a")], connections: [] }, false, ["agent-duplicate-id"]);
check("duplicate connection", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b"), conn("c2", "a", "b")] }, false, ["connection-duplicate"]);

// --- shape ----------------------------------------------------------
check("connections not array", { agents: [agent("a")], connections: "nope" }, false, ["connections-not-array"]);
check("graph not object", "nope", false, ["graph-invalid"]);

// --- warnings do not affect ok, errors empty on valid graphs --------
{
	const result = validateGraph({ agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b")] });
	deepStrictEqual(result.errors, [], "acyclic graph has no errors");
	deepStrictEqual(result.warnings, undefined, "acyclic graph carries no warnings field");
	passed++;
	console.log("ok    acyclic graph carries no warnings field");
}
{
	const result = validateGraph({ agents: [agent("a"), { ...agent("b"), inputPorts: [{ name: "in", bound: 2 }] }], connections: [conn("c1", "a", "b"), conn("c2", "b", "a")] });
	deepStrictEqual(result.errors, [], "guarded cycle has no errors");
	deepStrictEqual(result.warnings?.map((w) => w.code), ["cycle-present"], "guarded cycle warns exactly once");
	passed++;
	console.log("ok    guarded cycle warns exactly once");
}

// --- controls as connection endpoints (the if control — shared rules) ---
// A control id resolves as an endpoint, but the agent-port rules exempt it:
// a control-targeted edge carries no targetPort and a control-sourced edge
// names a declared branch (validated in depth by test/controls.test.ts).
check("control-targeted edge without a target port stays valid", {
	agents: [agent("a")],
	connections: [controlConn("c1", "a", "if-1", "a:out")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, true, []);
{
	// Exact codes: an unknown feeder is the connection rule's finding — a
	// regression adding if-source-invalid here must fail, not hide in the
	// subset matcher the check() helper uses.
	const result = validateGraph({
		agents: [agent("a")],
		connections: [controlConn("c1", "zzz", "if-1", "zzz:out")],
		controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
	});
	deepStrictEqual(result.errors.map((e) => e.code), ["connection-source-missing"], "unknown control source reports only the missing source");
	passed++;
	console.log("ok    unknown control source reports only connection-source-missing");
}
check("control-sourced unknown branch skips the agent-port rule", {
	agents: [agent("a"), agent("b")],
	connections: [controlConn("c1", "a", "if-1", "a:out"), controlConn("c2", "if-1", "b", "if-1:zzz")],
	controls: [{ id: "if-1", kind: "if", branches: [{ name: "x", field: "f", value: "1" }, { name: "y" }] }],
}, false, ["if-edge-port-unknown"]);

// --- the cycle guard (loops L2): every cycle carries its guard -----------
// The walk runs over the LOWERED graph, so the if-authored loop and its
// hand-authored twin are guarded identically. The guard is a `bound` capping
// a hop of the cycle, or a valued `$count` row escaping off the cycle ahead
// of every row that wires back into it. `check` matches codes as a subset;
// rows that pin exact findings read the result directly.
const cagent = (id: string, extra: Record<string, unknown> = {}) => ({ ...agent(id), ...extra });
/**
 * The if-authored one-node loop: r -> <if> -> { <branches>, retry -> r },
 * optionally seeded. The escape branch rides side "top" so the two branch
 * ticks never share the default right edge (if-side-conflict would warn).
 */
const ifLoop = (branches: unknown[], opts: { seed?: boolean; entryPolicy?: string } = {}) => ({
	agents: [
		...(opts.seed ? [agent("k")] : []),
		cagent("r", {
			settings: { outputSchema: { type: "object" } },
			...(opts.entryPolicy !== undefined ? { inputPorts: [{ name: "in", policy: opts.entryPolicy }] } : {}),
		}),
		agent("t"),
	],
	connections: [
		...(opts.seed ? [conn("c0", "k", "r")] : []),
		controlConn("c1", "r", "if-1", "r:out"),
		portConn("c2", "if-1", "if-1:done", "t", "t:in"),
		portConn("c3", "if-1", "if-1:retry", "r", "r:in"), // the back edge
	],
	controls: [{ id: "if-1", kind: "if", x: 0, y: 0, branches }],
});
const countFirst = [{ name: "done", field: "$count", value: "3", op: ">=", side: "top" }, { name: "retry" }];

check("a bound on the loop hop guards a raw cycle (cycle-present only)", {
	agents: [agent("a"), cagent("b", { inputPorts: [{ name: "in", bound: 2 }] })],
	connections: [conn("c1", "a", "b"), conn("c2", "b", "a")],
}, true, [], ["cycle-present"]);
check("a control loop with the count row first is valid", ifLoop(countFirst), true, [], ["cycle-present"]);
check("a $count == 2 escape guards too", ifLoop([{ name: "done", field: "$count", value: "2", side: "top" }, { name: "retry" }]), true, [], ["cycle-present"]);
check("a count row above off-cycle branches only is valid", ifLoop([
	{ name: "done", field: "$count", value: "3", op: ">=", side: "top" },
	{ name: "other", field: "kind", value: "x", side: "left" },
	{ name: "retry" },
]), true, [], ["cycle-present"]);
check("the hand-authored two-node twin is guarded by its count row", {
	agents: [
		cagent("c", {
			outputPorts: ["done", "retry"],
			outputPortSides: { done: "top" },
			bindings: [{ field: "$count", value: "3", op: ">=", port: "done" }, { field: "verdict", port: "retry" }],
			settings: { outputSchema: { type: "object" } },
		}),
		agent("m"),
		agent("t"),
	],
	connections: [portConn("c1", "c", "c:done", "t", "t:in"), portConn("c2", "c", "c:retry", "m", "m:in"), portConn("c3", "m", "m:out", "c", "c:in")],
}, true, [], ["cycle-present"]);
check("the shadowed arrangement is refused", ifLoop([
	{ name: "retry", field: "verdict", value: "fix", side: "top" },
	{ name: "done", field: "$count", value: "3", op: ">=" },
]), false, ["cycle-unguarded"], ["cycle-present"]);
{
	// The error names BOTH rows: the count row and the loop row that shadows it.
	const result = validateGraph(ifLoop([
		{ name: "retry", field: "verdict", value: "fix", side: "top" },
		{ name: "done", field: "$count", value: "3", op: ">=" },
	]));
	const message = result.errors.find((e) => e.code === "cycle-unguarded")?.message ?? "";
	if (message.includes('"done"') && message.includes('"retry"')) {
		passed++;
		console.log("ok    the shadowed error names the count row and its shadower");
	} else {
		failed++;
		console.error(`FAIL  the shadowed error names the count row and its shadower — got: ${message}`);
	}
}
check("a count row aimed back into the loop is no guard (row named)", ifLoop([
	{ name: "retry", field: "$count", value: "3", op: ">=", side: "top" },
	{ name: "done" },
]), false, ["cycle-unguarded"], ["cycle-present"]);
{
	const result = validateGraph(ifLoop([
		{ name: "retry", field: "$count", value: "3", op: ">=", side: "top" },
		{ name: "done" },
	]));
	const message = result.errors.find((e) => e.code === "cycle-unguarded")?.message ?? "";
	if (message.includes('"retry"') && message.includes("re-matches")) {
		passed++;
		console.log("ok    the aims-in error names the count row aiming back into the loop");
	} else {
		failed++;
		console.error(`FAIL  the aims-in error names the count row aiming back into the loop — got: ${message}`);
	}
}
check("a valueless $count row is the catch-all, so it guards nothing", {
	agents: [
		cagent("c", {
			outputPorts: ["done", "retry"],
			outputPortSides: { done: "top" },
			bindings: [{ field: "$count", port: "done" }, { field: "verdict", port: "retry" }],
		}),
		agent("m"),
		agent("t"),
	],
	connections: [portConn("c1", "c", "c:done", "t", "t:in"), portConn("c2", "c", "c:retry", "m", "m:in"), portConn("c3", "m", "m:out", "c", "c:in")],
}, false, ["cycle-unguarded"], ["cycle-present"]);
check("an unwired count row still guards (the marbles' dead exhausted row)", {
	agents: [
		cagent("c", {
			outputPorts: ["late", "retry"],
			outputPortSides: { late: "top" },
			bindings: [{ field: "$count", value: "3", op: ">=", port: "late" }, { field: "verdict", port: "retry" }],
			settings: { outputSchema: { type: "object" } },
		}),
		agent("m"),
	],
	connections: [portConn("c2", "c", "c:retry", "m", "m:in"), portConn("c3", "m", "m:out", "c", "c:in")],
}, true, [], ["cycle-present"]);
check("a bound on an unwired chord does not guard (the loop hop is unbounded)", {
	agents: [
		cagent("a", { inputPorts: [{ name: "resp" }], outputPorts: ["request"] }),
		cagent("b", { inputPorts: [{ name: "req" }, { name: "fix", bound: 3 }], outputPorts: ["out"] }),
	],
	connections: [portConn("c1", "a", "a:request", "b", "b:req"), portConn("c2", "b", "b:out", "a", "a:resp")],
}, false, ["cycle-unguarded"], ["cycle-present"]);
check("a bound port sharing its hop with an unbounded parallel edge does not guard", {
	agents: [
		cagent("a", { outputPorts: ["out"] }),
		cagent("b", { inputPorts: [{ name: "capped", bound: 2 }, { name: "in" }] }),
	],
	connections: [portConn("c1", "a", "a:out", "b", "b:capped"), portConn("c2", "a", "a:out", "b", "b:in"), portConn("c3", "b", "b:out", "a", "a:in")],
}, false, ["cycle-unguarded"], ["cycle-present"]);
check("two disjoint cycles, one unguarded, are refused", {
	agents: [agent("a"), cagent("b", { inputPorts: [{ name: "in", bound: 2 }] }), agent("x"), agent("y")],
	connections: [conn("c1", "a", "b"), conn("c2", "b", "a"), conn("c3", "x", "y"), conn("c4", "y", "x")],
}, false, ["cycle-unguarded"], ["cycle-present"]);
check("an all-of entry port fed by the loop and a seed warns (the seed-once deadlock)", ifLoop(countFirst, { seed: true }), true, [], ["cycle-present", "cycle-entry-all-of"]);
check("an any-of entry port stays quiet under the same shape", ifLoop(countFirst, { seed: true, entryPolicy: "any-of" }), true, [], ["cycle-present"]);
check("a single-source entry port stays quiet", ifLoop(countFirst), true, [], ["cycle-present"]);
{
	// The canvas assist (loops L3) end to end on the pinned loop: the cycle-
	// closing verdict for the back edge names r's entry, applying the flip
	// clears the seed-once warning, and the guard story is unchanged.
	const seeded = ifLoop(countFirst, { seed: true });
	const verdict = cycleClosingFlip(seeded, portConn("c3x", "if-1", "if-1:retry", "r", "r:in"));
	deepStrictEqual(verdict.closesCycle, true, "the back edge closes the loop");
	deepStrictEqual(verdict.inputPorts, [{ name: "in", policy: "any-of" }], "the verdict flips r's default entry");
	const flipped = {
		...seeded,
		agents: seeded.agents.map((a) => ((a as { id: unknown }).id === "r" ? { ...a, inputPorts: verdict.inputPorts } : a)),
	};
	const result = validateGraph(flipped);
	deepStrictEqual(result.ok, true, "the flipped loop validates");
	deepStrictEqual(result.warnings?.map((w) => w.code), ["cycle-present"], "the flip clears cycle-entry-all-of, keeps the awareness warning");
	passed++;
	console.log("ok    the assist verdict flips the seeded loop's entry and clears the seed-once warning");
}
{
	// The shipped Coder→Reviewer sample (docs/guide/pipeline-samples.md): the
	// bound on the coder's feedback port is the loop budget — regression anchor.
	const result = validateGraph({
		agents: [
			{ "id": "agent-1", "name": "Task", "description": "", "instructions": "Restate the run input as a one-sentence coding task.",
				"x": 40, "y": 80, "input": "agent-1:in", "output": "agent-1:out" },
			{ "id": "agent-2", "name": "Coder", "description": "", "instructions": "Write the requested function. Address any review feedback you receive, then output the final code.",
				"inputPorts": [{ "name": "in", "policy": "any-of" }, { "name": "feedback", "policy": "any-of", "side": "bottom", "bound": 3 }],
				"x": 260, "y": 80, "input": "agent-2:in", "output": "agent-2:out" },
			{ "id": "agent-3", "name": "Reviewer", "description": "", "instructions": "Review the code you receive. If it needs changes, report {\"verdict\": \"fix\"}; if it is good, report {\"verdict\": \"approve\"}.",
				"outputPorts": ["feedback", "result"],
				"outputPortSides": { "feedback": "bottom" },
				"bindings": [
					{ "field": "verdict", "port": "feedback", "value": "fix" },
					{ "field": "verdict", "port": "result", "value": "approve" }
				],
				"settings": { "outputSchema": { "type": "object", "properties": { "verdict": { "type": "string", "enum": ["fix", "approve"] } }, "required": ["verdict"] } },
				"x": 500, "y": 80, "input": "agent-3:in", "output": "agent-3:out" }
		],
		connections: [
			{ "id": "c1", "source": "agent-1", "target": "agent-2", "sourcePort": "agent-1:out", "targetPort": "agent-2:in" },
			{ "id": "c2", "source": "agent-2", "target": "agent-3", "sourcePort": "agent-2:out", "targetPort": "agent-3:in" },
			{ "id": "c3", "source": "agent-3", "target": "agent-2", "sourcePort": "agent-3:feedback", "targetPort": "agent-2:feedback" }
		],
	});
	deepStrictEqual(result.ok, true, "the shipped sample stays valid");
	deepStrictEqual(result.warnings?.map((w) => w.code), ["cycle-present"], "the shipped sample warns cycle-present only");
	passed++;
	console.log("ok    the shipped Coder->Reviewer sample stays valid (bound 3 is the guard)");
}
{
	// Exact codes on the refusal: the error plus the awareness warning, and
	// nothing else — an unguarded cycle is one diagnosis, not a cascade.
	const result = validateGraph({ agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b"), conn("c2", "b", "a")] });
	deepStrictEqual(result.errors.map((e) => e.code), ["cycle-unguarded"], "unguarded cycle errors exactly once");
	deepStrictEqual(result.warnings?.map((w) => w.code), ["cycle-present"], "unguarded cycle keeps the awareness warning");
	passed++;
	console.log("ok    an unguarded cycle reports cycle-unguarded once, cycle-present once");
}
{
	// The lowered self-loop (a branch wired back to its own feeder) is a real
	// one-node cycle the kernel runs — guarded, it runs; unguarded, refused.
	// An HONEST self-connection is still only `connection-self` (pinned above).
	const result = validateGraph(ifLoop(countFirst));
	deepStrictEqual(result.ok, true, "the one-node lowered loop is a cycle the walk sees");
	deepStrictEqual(result.warnings?.map((w) => w.code), ["cycle-present"], "the one-node lowered loop warns cycle-present");
	passed++;
	console.log("ok    a branch wired back to its own feeder joins the walk as a one-node cycle");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
