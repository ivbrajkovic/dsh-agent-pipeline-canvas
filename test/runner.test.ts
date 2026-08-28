// runPipeline orchestration smoke test — plain Node script (no framework). Run:
//   tsx test/runner.test.ts
// It exercises the runner's sequencing against a SCRIPTED subagent provider (the
// same idea as the harness's own ScriptedSubagentProvider): it records the full
// start request of every agent it starts and returns a deterministic output per
// agent, so we can assert fan-in waiting, prompt passing, orphan handling,
// per-agent override passthrough, child-session capture, and the
// terminal-output shape WITHOUT a live model. The real harness subagent
// service satisfies the same
// `start(name, { prompt, parent, label, signal, ...settings })` contract.
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

type RecordedRequest = {
	label?: string;
	prompt: Array<{ text: string }>;
	parent: unknown;
	signal?: unknown;
	agentOptions?: unknown;
	outputSchema?: unknown;
	maxDepth?: number;
	toolFilter?: unknown;
	persona?: string;
};

function makeCtx(providerNames?: string[]) {
	const invocations: Array<{ name: string; label: string | undefined; prompt: string; parent: unknown; signal: unknown; request: RecordedRequest }> = [];
	const subagents = {
		list: () => providerNames ?? ["spawn"],
		start: (name: string, request: RecordedRequest) => {
			invocations.push({ name, label: request.label, prompt: request.prompt[0].text, parent: request.parent, signal: request.signal, request });
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

// --- abort mid-run: in-flight agent stops, later agents never start ------
{
	const { ctx, invocations } = makeCtx();
	const controller = new AbortController();
	// Script the FIRST agent to hold its result until the test releases it,
	// mimicking an agent in flight when the user presses Stop.
	let release!: (value: { output: Array<{ type: string; text: string }>; stopReason: string }) => void;
	const held = new Promise<{ output: Array<{ type: string; text: string }>; stopReason: string }>((resolve) => { release = resolve; });
	ctx.subagents.start = (name: string, request: { label?: string; prompt: Array<{ text: string }>; parent: unknown; signal?: unknown }) => {
		invocations.push({ name, label: request.label, prompt: request.prompt[0].text, parent: request.parent, signal: request.signal });
		return {
			id: "child-" + invocations.length,
			result: invocations.length === 1 ? held : Promise.resolve({ output: [], stopReason: "completed" }),
			dispose: () => Promise.resolve(),
		};
	};
	const pending = runPipeline(ctx, {
		graph: graph([agent("a", "Alpha", "Extract."), agent("b", "Beta", "Summarize.")], [conn("c1", "a", "b")]),
		input: "hello",
		sessionId: "sess",
		signal: controller.signal,
	});
	// runPipeline starts synchronously through the first start() call.
	okCheck("abort: first agent started", invocations.length === 1 && invocations[0].label === "Alpha");
	controller.abort();
	release({ output: [{ type: "text", text: "partial" }], stopReason: "aborted" });
	const result = await pending;
	okCheck("abort: reported aborted", result.ok === true && result.aborted === true);
	if (result.ok) {
		okCheck("abort: in-flight agent recorded as aborted", result.runs.length === 1 && result.runs[0].status === "aborted");
		okCheck("abort: no further agent started", invocations.length === 1);
		okCheck("abort: no downstream outputs", Object.keys(result.outputs).length === 0);
	}
}

// --- already-aborted signal: nothing runs at all -------------------------
{
	const { ctx, invocations } = makeCtx();
	const result = await runPipeline(ctx, {
		graph: graph([agent("a", "Alpha", "A.")], []),
		input: "",
		sessionId: "sess",
		signal: AbortSignal.abort(),
	});
	okCheck("pre-aborted: ok with aborted flag", result.ok === true && result.aborted === true);
	if (result.ok) {
		okCheck("pre-aborted: no agent started", invocations.length === 0);
		okCheck("pre-aborted: no runs recorded", result.runs.length === 0);
	}
}

// --- per-agent settings pass through; child session id is captured --------
{
	const { ctx, invocations } = makeCtx();
	const withSettings = {
		...agent("a", "Alpha", "Extract."),
		systemPrompt: "Terse auditor.",
		settings: {
			maxDepth: 2,
			agentOptions: { provider: "ds", model: "m-1", reasoningEffort: "high", maxTokens: 512 },
			toolFilter: { deny: ["write", "edit"] },
			outputSchema: { type: "object", properties: { summary: { type: "string" } } },
		},
	};
	const result = await runPipeline(ctx, {
		graph: graph([withSettings, agent("b", "Beta", "Sum.")], [conn("c1", "a", "b")]),
		input: "hello",
		sessionId: "sess",
	});
	okCheck("settings run ok", result.ok === true);
	const req = invocations[0].request;
	okCheck("system prompt forwarded as request persona", req.persona === "Terse auditor.");
	okCheck("maxDepth forwarded", req.maxDepth === 2);
	deepStrictEqual(req.agentOptions, { provider: "ds", model: "m-1", reasoningEffort: "high", maxTokens: 512 });
	deepStrictEqual(req.toolFilter, { deny: ["write", "edit"] });
	deepStrictEqual(req.outputSchema, { type: "object", properties: { summary: { type: "string" } } });
	// The plain agent gets none of the optional setting fields.
	const plain = invocations[1].request;
	okCheck("no settings on plain agent", plain.persona === undefined && plain.agentOptions === undefined
		&& plain.toolFilter === undefined && plain.outputSchema === undefined && plain.maxDepth === undefined);
	if (result.ok) {
		okCheck("child session id captured", result.runs[0].childSessionId === "child-1" && result.runs[1].childSessionId === "child-2");
	}
}

// --- structured result preferred over raw text ----------------------------
{
	const invocations: Array<{ label: string | undefined }> = [];
	const subagents = {
		list: () => ["spawn"],
		start: (_name: string, request: { label?: string }) => {
			invocations.push({ label: request.label });
			return {
				id: "child-structured",
				result: Promise.resolve({
					output: [{ type: "text", text: "raw prose" }],
					structured: { summary: "clean" },
					stopReason: "completed",
				}),
				dispose: () => Promise.resolve(),
			};
		},
	};
	const ctx = { subagents, agents: { get: (id: string) => (id === "sess" ? { id: "sess" } : undefined) }, logger: { warn: () => {} } };
	const result = await runPipeline(ctx, {
		graph: graph([agent("a", "Alpha", "A.")], []),
		input: "x",
		sessionId: "sess",
	});
	okCheck("structured run ok", result.ok === true);
	if (result.ok) {
		deepStrictEqual(result.runs[0].output, JSON.stringify({ summary: "clean" }, null, 2));
		deepStrictEqual(result.outputs, { a: JSON.stringify({ summary: "clean" }, null, 2) });
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
