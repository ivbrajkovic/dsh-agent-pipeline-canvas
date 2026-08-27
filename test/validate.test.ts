// validateGraph smoke test — plain Node script (no framework). Run with:
//   tsx test/validate.test.ts
// Imports the canonical pure implementation from lib/graph.js (the built output
// of src/graph.ts; the Host and the browser bundle use the same implementation).
import { validateGraph } from "../lib/graph.js";
import { deepStrictEqual } from "node:assert";

let passed = 0;
let failed = 0;

function check(name: string, graph: unknown, expectOk: boolean, expectCodes: string[]) {
	let result: { ok: boolean; errors: Array<{ code: string }> };
	try {
		result = validateGraph(graph);
	} catch (error) {
		failed++;
		console.error(`FAIL  ${name} — threw: ${error && (error as Error).message}`);
		return;
	}
	const codes = result.errors.map((e) => e.code).filter((c) => expectCodes.includes(c));
	const all = (a: string[], b: string[]) => a.every((x) => b.includes(x));
	if (result.ok !== expectOk || !all(expectCodes, result.errors.map((e) => e.code))) {
		failed++;
		console.error(`FAIL  ${name}`);
		console.error(`  expected ok=${expectOk} codes=${JSON.stringify(expectCodes)}`);
		console.error(`  got      ok=${result.ok} codes=${JSON.stringify(result.errors.map((e) => e.code))}`);
		console.error(`  messages ${JSON.stringify(result.errors.map((e) => e.message))}`);
		return;
	}
	passed++;
	console.log(`ok    ${name}`);
}

const agent = (id: string) => ({ id, name: id, description: "", instructions: "", x: 0, y: 0, input: id + ":in", output: id + ":out" });
const conn = (id: string, source: string, target: string) => ({ id, source, target, sourcePort: source + ":out", targetPort: target + ":in" });

// --- valid / degenerate ---------------------------------------------
check("null pipeline", null, true, []);
check("undefined pipeline", undefined, true, []);
check("empty graph", { agents: [], connections: [] }, true, []);
check("isolated single agent", { agents: [agent("a")], connections: [] }, true, []);
check("linear A->B", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b")] }, true, []);
check("fan-out A->B,A->C", { agents: [agent("a"), agent("b"), agent("c")], connections: [conn("c1", "a", "b"), conn("c2", "a", "c")] }, true, []);
check("fan-in A->C,B->C", { agents: [agent("a"), agent("b"), agent("c")], connections: [conn("c1", "a", "c"), conn("c2", "b", "c")] }, true, []);

// --- cycles ---------------------------------------------------------
check("direct cycle A->B->A", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b"), conn("c2", "b", "a")] }, false, ["cycle"]);
check("self cycle A->->A", { agents: [agent("a")], connections: [conn("c1", "a", "a")] }, false, ["connection-self"]);

// --- missing / unknown agents --------------------------------------
check("missing source agent id", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", target: "b", sourcePort: "", targetPort: "b:in" }] }, false, ["connection-missing-source"]);
check("unknown source", { agents: [agent("a"), agent("b")], connections: [conn("c1", "zzz", "b")] }, false, ["connection-source-missing"]);
check("unknown target", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "zzz")] }, false, ["connection-target-missing"]);

// --- ports ----------------------------------------------------------
check("mismatched source port", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", source: "a", target: "b", sourcePort: "a:in", targetPort: "b:in" }] }, false, ["connection-source-port-mismatch"]);
check("mismatched target port", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", source: "a", target: "b", sourcePort: "a:out", targetPort: "b:out" }] }, false, ["connection-target-port-mismatch"]);
check("missing source port", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", source: "a", target: "b", targetPort: "b:in" }] }, false, ["connection-missing-source-port"]);
check("missing target port", { agents: [agent("a"), agent("b")], connections: [{ id: "c1", source: "a", target: "b", sourcePort: "a:out" }] }, false, ["connection-missing-target-port"]);
check("invalid agent port (empty output)", { agents: [{ id: "a", name: "a", x: 0, y: 0, input: "a:in", output: "" }], connections: [] }, false, ["agent-port-invalid"]);

// --- duplicate ids / connections -----------------------------------
check("duplicate agent id", { agents: [agent("a"), agent("a")], connections: [] }, false, ["agent-duplicate-id"]);
check("duplicate connection", { agents: [agent("a"), agent("b")], connections: [conn("c1", "a", "b"), conn("c2", "a", "b")] }, false, ["connection-duplicate"]);

// --- shape ----------------------------------------------------------
check("connections not array", { agents: [agent("a")], connections: "nope" }, false, ["connections-not-array"]);
check("graph not object", "nope", false, ["graph-invalid"]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
