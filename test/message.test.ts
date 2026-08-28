// Message-composition smoke test — plain Node script (no framework). Run with:
//   tsx test/message.test.ts
// Imports the canonical pure implementation from lib/message.js (the built
// output of src/message.ts). This exercises the runtime-only input/result
// framing the browser half performs — NOT the execution contract.
import { composePipelineInput, finalOutputText } from "../lib/message.js";
import { strictEqual } from "node:assert";

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown) {
	try {
		strictEqual(actual, expected);
		passed++;
		console.log(`ok    ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL  ${name}`);
		console.error(`  expected ${JSON.stringify(expected)}`);
		console.error(`  got      ${JSON.stringify(actual)}`);
	}
}

// --- composePipelineInput -------------------------------------------------

eq("text only passes through verbatim", composePipelineInput("hello\nworld", []), "hello\nworld");
eq("text + files appends the files block", composePipelineInput("summarize", ["/w/a.md", "/w/b.ts"]), "summarize\n\nAttached files (absolute paths — read them with your file tools; their contents are not inlined here):\n- /w/a.md\n- /w/b.ts");
eq("files only omits the text part", composePipelineInput("", ["/w/a.md"]), "Attached files (absolute paths — read them with your file tools; their contents are not inlined here):\n- /w/a.md");
eq("both empty compose to an empty input", composePipelineInput("", []), "");
eq("each attached file is one path bullet, nothing else", composePipelineInput("x", ["/w/a.md"]).split("\n").filter((l) => l.startsWith("- ")).join("|"), "- /w/a.md");

// --- finalOutputText ------------------------------------------------------

eq("no outputs compose to empty text", finalOutputText({}, (id) => id), "");
eq("single terminal output is verbatim", finalOutputText({ "agent-2": "the result" }, (id) => id), "the result");
eq("multiple terminals get labeled sections", finalOutputText({ "agent-2": "b-out", "agent-3": "c-out" }, (id) => (id === "agent-2" ? "Agent 2" : id)), "## Agent 2\nb-out\n\n## agent-3\nc-out");
eq("structured output renders as JSON like the prompt framing", finalOutputText({ t: { a: 1 } }, (id) => id), '{\n  "a": 1\n}');
eq("null/undefined outputs map is tolerated", finalOutputText(undefined as unknown as Record<string, unknown>, (id) => id), "");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
