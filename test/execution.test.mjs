// Execution-contract smoke test — plain Node script (no framework). Run with:
//   node test/execution.test.mjs
// Imports the canonical pure implementation from lib/execution.js (the Host /
// future runner imports the same module). This exercises the runtime
// input/output shapes, NOT scheduling/invocation — those are out of scope.

import { classifyGraph, agentInput, agentPrompt, pipelineResult, topoOrder, INPUT_KEY } from "../lib/execution.js";
import { deepStrictEqual } from "node:assert";

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
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

const agent = (id, name) => ({ id, name: name ?? id, description: "", instructions: "", x: 0, y: 0, input: id + ":in", output: id + ":out" });
const conn = (id, source, target) => ({ id, source, target, sourcePort: source + ":out", targetPort: target + ":in" });
const graph = (agents, connections) => ({ agents, connections });

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
