// validateGraph smoke test — plain Node script (no framework). Run with:
//   tsx test/validate.test.ts
// Imports the canonical pure implementation from lib/graph.js (the built output
// of src/graph.ts; the Host and the browser bundle use the same implementation).
import { validateGraph } from "../lib/graph.js";
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

// --- cycles: legal wiring, reported as a warning ---------------------
check("legal cycle A->B->A (warning, not error)", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b"), conn("c2", "b", "a")] }, true, [], ["cycle-present"]);
check("legal named-port cycle (warning, not error)", { agents: [portsAgent("a", [{ name: "resp" }], ["request"]), portsAgent("b", [{ name: "req", policy: "any-of" }], ["feedback"])], connections: [portConn("c1", "a", "a:request", "b", "b:req"), portConn("c2", "b", "b:feedback", "a", "a:resp")] }, true, [], ["cycle-present"]);
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
check("sided loop cycle still legal wiring", { agents: [{ id: "a", name: "a", description: "", instructions: "", x: 0, y: 0, inputPorts: [{ name: "resp" }], outputPorts: ["request"], outputPortSides: { request: "bottom" } }, { id: "b", name: "b", description: "", instructions: "", x: 0, y: 0, inputPorts: [{ name: "req", policy: "any-of" }, { name: "fix", policy: "any-of", bound: 3, side: "bottom" }], outputPorts: ["out"] }], connections: [portConn("c1", "a", "a:request", "b", "b:req"), portConn("c2", "b", "b:out", "a", "a:resp")] }, true, [], ["cycle-present"]);
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
	const result = validateGraph({ agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b"), conn("c2", "b", "a")] });
	deepStrictEqual(result.errors, [], "legal cycle has no errors");
	deepStrictEqual(result.warnings?.map((w) => w.code), ["cycle-present"], "legal cycle warns once");
	passed++;
	console.log("ok    legal cycle warns exactly once");
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
