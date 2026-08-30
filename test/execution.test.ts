// Execution-contract smoke test — plain Node script (no framework). Run with:
//   tsx test/execution.test.ts
// Imports the canonical pure implementation from lib/execution.js (the built
// output of src/execution.ts; the Host and the runner import the same module).
// This exercises the runtime input/output shapes, NOT scheduling/invocation —
// those are out of scope. The selective-emission contract (evaluateBindings)
// and the projection's deterministic firing-id order (compareFiringIds) are
// pinned here too.
import { classifyGraph, agentInput, agentPrompt, pipelineResult, topoOrder, portGraph, evaluateBindings, INPUT_KEY } from "../lib/execution.js";
import { compareFiringIds } from "../lib/projection.js";
import { deepStrictEqual } from "node:assert";

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown) {
	try {
		deepStrictEqual(actual, expected);
		passed++;
		console.log(`ok    ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL  ${name}`);
		console.error(`  expected ${JSON.stringify(expected)}`);
		console.error(`  got      ${JSON.stringify(actual)}`);
	}
}

const agent = (id: string, name?: string) => ({ id, name: name ?? id, description: "", instructions: "", x: 0, y: 0, input: id + ":in", output: id + ":out" });
const conn = (id: string, source: string, target: string) => ({ id, source, target, sourcePort: source + ":out", targetPort: target + ":in" });
const graph = (agents: unknown[], connections: unknown[]) => ({ agents, connections });

// --- classifyGraph ------------------------------------------------------
{
	const g = graph([agent("a"), agent("b")], [conn("c1", "a", "b")]);
	const c = classifyGraph(g);
	eq("linear roots", c.roots, ["a"]);
	eq("linear terminals", c.terminals, ["b"]);
	eq("linear orphans", c.orphans, []);
	eq("linear upstream", c.upstream, { a: [], b: ["a"] });
	eq("linear downstream", c.downstream, { a: ["b"], b: [] });
}
{
	const g = graph([agent("a"), agent("b"), agent("c")], [conn("c1", "a", "c"), conn("c2", "b", "c")]);
	const c = classifyGraph(g);
	eq("fan-in roots", c.roots, ["a", "b"]);
	eq("fan-in terminals", c.terminals, ["c"]);
	eq("fan-in orphans", c.orphans, []);
	eq("fan-in upstream (sorted)", c.upstream.c, ["a", "b"]);
	eq("fan-in downstream", c.downstream, { a: ["c"], b: ["c"], c: [] });
}
{
	const g = graph([agent("o")], []);
	const c = classifyGraph(g);
	eq("orphan roots", c.roots, ["o"]);
	eq("orphan terminals", c.terminals, ["o"]);
	eq("orphan orphans", c.orphans, ["o"]);
	eq("orphan upstream", c.upstream, { o: [] });
	eq("orphan downstream", c.downstream, { o: [] });
}
{
	const c = classifyGraph(graph([], []));
	eq("empty agents", c.agents, []);
	eq("empty roots/terminals/orphans", [c.roots, c.terminals, c.orphans], [[], [], []]);
}

// --- agentInput ---------------------------------------------------------
{
	const inputs = agentInput("root", { upstream: [], upstreamOutputs: {}, pipelineInput: "hello" });
	eq("root input keys by INPUT_KEY", Object.keys(inputs), [INPUT_KEY]);
	eq("root input value", inputs[INPUT_KEY], "hello");
}
{
	const inputs = agentInput("b", { upstream: ["a"], upstreamOutputs: { a: "done" }, pipelineInput: "ignored" });
	eq("single-upstream input", inputs, { a: "done" });
}
{
	const inputs = agentInput("c", { upstream: ["a", "b"], upstreamOutputs: { a: "A-out", b: "B-out" } });
	eq("fan-in input keyed by upstream id", inputs, { a: "A-out", b: "B-out" });
}
{
	// Deterministic order follows the (sorted) upstream list, independent of
	// insertion order in the outputs map.
	const inputs = agentInput("c", { upstream: ["b", "a"], upstreamOutputs: { a: "A", b: "B" } });
	eq("fan-in key order follows upstream", Object.keys(inputs), ["b", "a"]);
}

// --- agentPrompt --------------------------------------------------------
{
	const agentById = new Map([["a", agent("a", "Alpha")]]);
	const prompt = agentPrompt({ id: "b", instructions: "Summarize." }, { a: "the data" }, agentById);
	eq("prompt frames single source by name", prompt, "Summarize.\n\n## Alpha\nthe data");
}
{
	const prompt = agentPrompt({ id: "c", instructions: "Join these." }, { a: "X", b: "Y" }, { a: agent("a", "Alpha"), b: agent("b", "Beta") });
	eq("prompt frames fan-in as labelled sections", prompt, "Join these.\n\n## Alpha\nX\n\n## Beta\nY");
}
{
	const prompt = agentPrompt({ id: "root", instructions: "" }, { [INPUT_KEY]: "the ask" }, {});
	eq("prompt labels the reserved input key as Input", prompt, "## Input\nthe ask");
}
{
	// No name -> fall back to the id as the label.
	const prompt = agentPrompt({ id: "z", instructions: "" }, { q: "v" }, { q: { id: "q", name: "" } });
	eq("prompt falls back to id when no name", prompt, "## q\nv");
}
{
	// Structured (non-string) inputs are rendered as JSON.
	const prompt = agentPrompt({ id: "b", instructions: "" }, { a: { k: 1 } }, {});
	eq("prompt renders structured value as JSON", prompt, "## a\n{\n  \"k\": 1\n}");
}

// --- pipelineResult -----------------------------------------------------
{
	const result = pipelineResult(["b", "c"], { a: "ignored", b: "B-out", c: "C-out" });
	eq("result keyed by terminal id", result, { outputs: { b: "B-out", c: "C-out" } });
}
{
	const result = pipelineResult(["b", "c"], { b: "B-out" });
	eq("result omits terminals with no output", result, { outputs: { b: "B-out" } });
}
{
	const result = pipelineResult([], { a: "x" });
	eq("result empty when no terminals", result, { outputs: {} });
}

// --- topoOrder ---------------------------------------------------------
{
	const g = graph([agent("a"), agent("b"), agent("c")], [conn("c1", "a", "b")]);
	eq("topo linear", topoOrder(g), ["a", "b", "c"]);
}
{
	// Fan-in: c depends on a AND b, so it comes only after both upstreams. The
	// two roots order deterministically by id.
	const g = graph([agent("a"), agent("b"), agent("c")], [conn("c1", "a", "c"), conn("c2", "b", "c")]);
	eq("topo fan-in waits for all upstreams", topoOrder(g), ["a", "b", "c"]);
}
{
	// Fan-out: a feeds b and c; b/c may run after a in id order.
	const g = graph([agent("a"), agent("b"), agent("c")], [conn("c1", "a", "b"), conn("c2", "a", "c")]);
	eq("topo fan-out", topoOrder(g), ["a", "b", "c"]);
}
{
	// Multiple roots + multiple terminals + an orphan (d): deterministic.
	const g = graph(
		[agent("a"), agent("b"), agent("c"), agent("d")],
		[conn("c1", "a", "c"), conn("c2", "b", "c")],
	);
	eq("topo multi-root + orphan", topoOrder(g), ["a", "b", "c", "d"]);
}
{
	const g = graph([], []);
	eq("topo empty", topoOrder(g), []);
}

// --- portGraph ----------------------------------------------------------
{
	const g = graph([agent("a"), agent("b")], [conn("c1", "a", "b")]);
	const pg = portGraph(g);
	eq("portGraph ids in agent order", pg.ids, ["a", "b"]);
	eq("default input port derives in/all-of/unbounded", pg.byId.a.inputs.map((p) => [p.name, p.portId, p.policy, p.bound]), [["in", "a:in", "all-of", undefined]]);
	eq("default output port derives out", pg.byId.a.outputs.map((p) => [p.name, p.portId]), [["out", "a:out"]]);
	eq("edge attaches to the target's input port", pg.byId.b.inputs[0].edges.map((e) => [e.connectionId, e.source, e.sourcePort]), [["c1", "a", "a:out"]]);
	eq("input port sources sorted+unique", pg.byId.b.inputs[0].sources, ["a"]);
	eq("edge attaches to the source's output port", pg.byId.a.outputs[0].edges.map((e) => [e.connectionId, e.target, e.targetPort]), [["c1", "b", "b:in"]]);
	eq("output port targets sorted+unique", pg.byId.a.outputs[0].targets, ["b"]);
}
{
	// Declared named ports: edges attach by wire id ("<id>:<name>"); fan-in
	// queues both messages into the one all-of port.
	const a = { ...agent("a"), outputPorts: ["mail", "slack"] };
	const b = { ...agent("b"), inputPorts: [{ name: "data", policy: "any-of", bound: 3 }] };
	const g = {
		agents: [a, b],
		connections: [
			{ id: "c1", source: "a", target: "b", sourcePort: "a:mail", targetPort: "b:data" },
			{ id: "c2", source: "a", target: "b", sourcePort: "a:slack", targetPort: "b:data" },
		],
	};
	const pg = portGraph(g);
	eq("declared output ports in declaration order", pg.byId.a.outputs.map((p) => p.portId), ["a:mail", "a:slack"]);
	eq("declared input spec carries policy+bound", pg.byId.b.inputs.map((p) => [p.name, p.policy, p.bound]), [["data", "any-of", 3]]);
	eq("both edges queue into the named port", pg.byId.b.inputs[0].edges.map((e) => e.sourcePort), ["a:mail", "a:slack"]);
	eq("per-port source sets stay separate", pg.byId.a.outputs.map((p) => p.targets), [["b"], ["b"]]);
}
{
	// Fan-in from two distinct upstreams into one port, sorted sources.
	const g = graph([agent("a"), agent("b"), agent("c")], [conn("c1", "b", "c"), conn("c2", "a", "c")]);
	const pg = portGraph(g);
	eq("fan-in port sources sorted by id", pg.byId.c.inputs[0].sources, ["a", "b"]);
	eq("fan-in port edges in connection order", pg.byId.c.inputs[0].edges.map((e) => e.source), ["b", "a"]);
}
{
	// Edges whose port strings name no declared/default port drop silently
	// (validateGraph reports them; the wiring view stays exact).
	const g = graph([agent("a"), agent("b")], [{ id: "c1", source: "a", target: "b", sourcePort: "a:zzz", targetPort: "b:in" }]);
	const pg = portGraph(g);
	eq("unmatched edge drops from the output port", pg.byId.a.outputs[0].edges, []);
	eq("matched edge still attaches on the input side", pg.byId.b.inputs[0].edges.map((e) => e.source), ["a"]);
}
{
	// Invalid declared values normalize to the defaults (validateGraph reports
	// them); duplicate names keep the first occurrence only.
	const a = { ...agent("a"), inputPorts: [{ name: "x", policy: "bogus", bound: 0 }, { name: "x" }] };
	const pg = portGraph({ agents: [a], connections: [] });
	eq("invalid policy falls back to all-of", pg.byId.a.inputs[0].policy, "all-of");
	eq("invalid bound falls back to unbounded", pg.byId.a.inputs[0].bound, undefined);
	eq("duplicate declared name kept once", pg.byId.a.inputs.map((p) => p.name), ["x"]);
	eq("one entry per unique name", pg.byId.a.inputs.length, 1);
}
{
	// Legacy custom `input`/`output` strings ARE the port ids when no lists
	// are declared — old files keep wiring exactly as before.
	const a = { ...agent("a"), input: "a:custom-in", output: "a:custom-out" };
	const pg = portGraph({ agents: [a], connections: [] });
	eq("legacy input string is the port id", pg.byId.a.inputs[0].portId, "a:custom-in");
	eq("legacy output string is the port id", pg.byId.a.outputs[0].portId, "a:custom-out");
}

// --- evaluateBindings (selective emission, P7) ---------------------------
{
	// First match wins: the structured field routes to its port.
	const bindings = [
		{ field: "action", value: "mail", port: "mail" },
		{ field: "action", value: "slack", port: "slack" },
	];
	eq("bindings: first match selects the port", evaluateBindings(bindings, { action: "mail" }), "mail");
	eq("bindings: second rule matches when the first does not", evaluateBindings(bindings, { action: "slack" }), "slack");
	eq("bindings: no match emits on no port", evaluateBindings(bindings, { action: "archive" }), null);
	eq("bindings: a missing field matches nothing", evaluateBindings(bindings, {}), null);
}
{
	// The catch-all (no value) matches any structured result, wherever the
	// field is present or absent — the author orders it last.
	const bindings = [{ field: "action", value: "mail", port: "mail" }, { field: "action", port: "other" }];
	eq("bindings: the catch-all catches the no-match case", evaluateBindings(bindings, { action: "archive" }), "other");
	eq("bindings: the catch-all matches a field-less result too", evaluateBindings(bindings, { other: 1 }), "other");
	eq("bindings: the match before the catch-all wins", evaluateBindings(bindings, { action: "mail" }), "mail");
	eq("bindings: a lone catch-all is the everything-goes-to rule", evaluateBindings([{ port: "out" }], { x: 1 }), "out");
}
{
	// Bindings evaluate ONLY against a structured result.
	eq("bindings: no structured result — null even with a catch-all", evaluateBindings([{ port: "out" }], undefined), null);
	eq("bindings: null structured — null", evaluateBindings([{ port: "out" }], null), null);
	eq("bindings: no bindings — null (non-selective emission is the kernel's default)", evaluateBindings(undefined, { action: "mail" }), null);
	eq("bindings: empty list — null", evaluateBindings([], { a: 1 }), null);
}
{
	// Field equality is strict with a String-coerced fallback (schema numbers
	// match "1"-typed bindings).
	const bindings = [{ field: "code", value: "200", port: "ok" }];
	eq("bindings: string equals string", evaluateBindings(bindings, { code: "200" }), "ok");
	eq("bindings: a schema number matches a string-typed value", evaluateBindings(bindings, { code: 200 }), "ok");
	eq("bindings: distinct values stay distinct", evaluateBindings(bindings, { code: 404 }), null);
	eq("bindings: strict-only for objects (String fallback is [object Object])", evaluateBindings([{ field: "a", value: "x", port: "p" }], { a: { x: 1 } }), null);
}
{
	// Malformed entries are skipped, never thrown; the first WELL-SHAPED match
	// wins. A value-less entry is the catch-all whatever its field (validation
	// reports the shape; the evaluation stays total).
	const malformed = [null, "junk", { field: "action", value: "mail", port: "mail" }] as unknown as Array<{ field: string; port: string; value?: unknown }>;
	eq("bindings: malformed entries skipped", evaluateBindings(malformed, { action: "mail" }), "mail");
	eq("bindings: binding to an empty port is skipped", evaluateBindings([{ field: "action", value: "mail", port: "" }], { action: "mail" }), null);
	eq("bindings: a value-less entry is the catch-all whatever its field", evaluateBindings([{ field: "", port: "p" }], { action: "mail" }), "p");
}

// --- compareFiringIds (the projection's deterministic firing order) -------
{
	eq("firing ids: numeric order beyond 999 (the P5 scrutiny note)",
		["f-1000", "f-999", "f-1001", "f-998"].sort(compareFiringIds),
		["f-998", "f-999", "f-1000", "f-1001"]);
	eq("firing ids: lexicographic would flip past 999",
		["f-1000", "f-999"].sort(compareFiringIds).join(), "f-999,f-1000");
	eq("firing ids: single vs multi digit", ["f-10", "f-9"].sort(compareFiringIds).join(), "f-9,f-10");
	eq("firing ids: equal tails fall back to byte order", compareFiringIds("f-007", "f-7"), -1);
	eq("firing ids: non-numeric ids sort by bytes", ["g", "f"].sort(compareFiringIds).join(), "f,g");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
