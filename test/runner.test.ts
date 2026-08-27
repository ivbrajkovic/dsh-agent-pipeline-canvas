// runPipeline orchestration smoke test — plain Node script (no framework). Run:
//   tsx test/runner.test.ts
// It exercises the runner's sequencing against a SCRIPTED subagent provider (the
// same idea as the harness's own ScriptedSubagentProvider): it records the order
// and prompt of every agent it starts and returns a deterministic output per
// agent, so we can assert fan-in waiting, prompt passing, orphan handling, and
// the terminal-output shape WITHOUT a live model. The real harness subagent
// service satisfies the same `start(name, { prompt, parent, label, signal })`
// contract.
import { runPipeline } from "../lib/runner.js";
import { deepStrictEqual, ok } from "node:assert";

let passed = 0;
let failed = 0;

function okCheck(name: string, cond: boolean) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.error(`FAIL  ${name}`); }
}

const agent = (id: string, name: string, instructions?: string) => ({
	id, name, description: "", instructions: instructions || "",
	x: 0, y: 0, input: id + ":in", output: id + ":out",
});
const conn = (id: string, source: string, target: string) => ({
	id, source, target, sourcePort: source + ":out", targetPort: target + ":in",
});
const graph = (agents: unknown[], connections: unknown[]) => ({ agents, connections });

function makeCtx(providerNames?: string[]) {
	const invocations: Array<{ name: string; label: string | undefined; prompt: string; parent: unknown; signal: unknown }> = [];
	const subagents = {
		list: () => providerNames ?? ["spawn"],
		start: (name: string, request: { label?: string; prompt: Array<{ text: string }>; parent: unknown; signal?: unknown }) => {
			invocations.push({ name, label: request.label, prompt: request.prompt[0].text, parent: request.parent, signal: request.signal });
			return {
				id: "child-" + invocations.length,
				result: Promise.resolve({ output: [{ type: "text", text: "<out:" + request.label + ">" }], stopReason: "completed" }),
				dispose: () => Promise.resolve(),
			};
		},
	};
	const agents = { get: (id: string) => (id === "sess" ? { id: "sess", ctx: {} } : undefined) };
	const logger = { warn: () => {} };
	return { ctx: { subagents, agents, logger }, invocations };
}

// --- linear A -> B ------------------------------------------------------
{
	const { ctx, invocations } = makeCtx();
	const result = await runPipeline(ctx, {
		graph: graph([agent("a", "Alpha", "Extract."), agent("b", "Beta", "Summarize.")], [conn("c1", "a", "b")]),
		input: "hello",
		sessionId: "sess",
	});
	okCheck("linear ok", result.ok === true);
	okCheck("linear order", invocations.map((i) => i.label).join(",") === "Alpha,Beta");
	// Root a receives the pipeline input.
	okCheck("root gets pipeline input", invocations[0].prompt.includes("## Input\nhello"));
	// Single-upstream b receives a's output, labelled by source name.
	okCheck("downstream gets upstream output", invocations[1].prompt.includes("## Alpha\n<out:Alpha>"));
	if (result.ok) {
		deepStrictEqual(result.outputs, { b: "<out:Beta>" });
		deepStrictEqual(result.runs.map((r) => r.status), ["completed", "completed"]);
	}
}

// --- fan-in A -> C, B -> C ---------------------------------------------
{
	const { ctx, invocations } = makeCtx();
	const result = await runPipeline(ctx, {
		graph: graph(
			[agent("a", "Alpha", "Facts."), agent("b", "Beta", "Views."), agent("c", "Gamma", "Combine.")],
			[conn("c1", "a", "c"), conn("c2", "b", "c")],
		),
		input: "",
		sessionId: "sess",
	});
	okCheck("fan-in ok", result.ok === true);
	okCheck("fan-in waits for all upstreams", invocations.map((i) => i.label).join(",") === "Alpha,Beta,Gamma");
	okCheck("fan-in prompt has both upstream outputs", invocations[2].prompt.includes("## Alpha\n<out:Alpha>") && invocations[2].prompt.includes("## Beta\n<out:Beta>"));
	if (result.ok) deepStrictEqual(result.outputs, { c: "<out:Gamma>" });
}

// --- orphan runs as root+terminal, included in outputs ------------------
{
	const { ctx, invocations } = makeCtx();
	const result = await runPipeline(ctx, {
		graph: graph([agent("d", "Delta", "Standalone.")], []),
		input: "solo",
		sessionId: "sess",
	});
	okCheck("orphan ok", result.ok === true);
	okCheck("orphan ran once", invocations.length === 1 && invocations[0].label === "Delta");
	okCheck("orphan received pipeline input", invocations[0].prompt.includes("## Input\nsolo"));
	if (result.ok) deepStrictEqual(result.outputs, { d: "<out:Delta>" });
}

// --- multiple terminals --------------------------------------------------
{
	const { ctx } = makeCtx();
	const result = await runPipeline(ctx, {
		graph: graph(
			[agent("a", "Alpha", "A."), agent("b", "Beta", "B."), agent("c", "Gamma", "C.")],
			[conn("c1", "a", "c")],
		),
		input: "x",
		sessionId: "sess",
	});
	okCheck("multi-terminal ok", result.ok === true);
	// a is a root+terminal (no upstream, no downstream? actually a has downstream c). Let's use a clear graph:
	if (result.ok) deepStrictEqual(Object.keys(result.outputs).sort(), ["b", "c"]);
}

// --- invalid graph (cycle) ----------------------------------------------
{
	const { ctx } = makeCtx();
	const result = await runPipeline(ctx, {
		graph: graph([agent("a", "A", ""), agent("b", "B", "")], [conn("c1", "a", "b"), conn("c2", "b", "a")]),
		input: "",
		sessionId: "sess",
	});
	okCheck("invalid graph rejected", result.ok === false && Array.isArray(result.validationErrors));
}

// --- missing / unavailable session agent --------------------------------
{
	const { ctx } = makeCtx();
	const result = await runPipeline(ctx, { graph: graph([], []), input: "", sessionId: "nope" });
	okCheck("parent unavailable rejected", result.ok === false && /no live agent/.test(result.error ?? ""));
}

// --- no registered provider --------------------------------------------
{
	const { ctx } = makeCtx([]);
	const result = await runPipeline(ctx, { graph: graph([agent("a", "A", "")], []), input: "", sessionId: "sess" });
	okCheck("no provider rejected", result.ok === false && /no subagent provider/.test(result.error ?? ""));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
