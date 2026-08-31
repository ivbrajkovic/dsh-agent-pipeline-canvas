// Per-session storage path seam tests — plain Node script (no framework). Run:
//   tsx test/storage.test.ts
// Pins the pure seam the per-session pipeline files hang off (see
// src/storage.ts): the session-key rule and the per-session file path. The
// key rule is the only traversal guard — the literal `.json` suffix is
// appended verbatim, so the charset must exclude separators on its own.
import { isValidSessionKey, sessionPipelineFilePath } from "../lib/storage.js";
import { strictEqual } from "node:assert";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function okCheck(name: string, cond: boolean) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.error(`FAIL  ${name}`); }
}

const CWD = "/tmp/project";

// --- isValidSessionKey: accepted shapes -------------------------------
okCheck("key: plain alphanumeric accepted", isValidSessionKey("abc123") === true);
okCheck("key: UUID-shaped harness id accepted", isValidSessionKey("session-3f2b9c1e-8a4d-4e6f-9b0c-2d5e7f1a3b4c") === true);
okCheck("key: underscore and dash accepted after the first char", isValidSessionKey("a_b-c9") === true);
okCheck("key: single character accepted", isValidSessionKey("x") === true);
okCheck("key: 128 characters accepted", isValidSessionKey("a".repeat(128)) === true);

// --- isValidSessionKey: rejected shapes --------------------------------
okCheck("key: empty rejected", isValidSessionKey("") === false);
okCheck("key: leading dash rejected", isValidSessionKey("-abc") === false);
okCheck("key: leading underscore rejected", isValidSessionKey("_abc") === false);
okCheck("key: dot rejected", isValidSessionKey(".") === false);
okCheck("key: dot-dot rejected", isValidSessionKey("..") === false);
okCheck("key: ../x traversal rejected", isValidSessionKey("../x") === false);
okCheck("key: forward slash rejected", isValidSessionKey("a/b") === false);
okCheck("key: backslash rejected", isValidSessionKey("a\\b") === false);
okCheck("key: 129 characters rejected", isValidSessionKey("a".repeat(129)) === false);
okCheck("key: non-strings rejected (number)", isValidSessionKey(42) === false);
okCheck("key: non-strings rejected (null)", isValidSessionKey(null) === false);
okCheck("key: non-strings rejected (undefined)", isValidSessionKey(undefined) === false);
okCheck("key: non-strings rejected (object)", isValidSessionKey({}) === false);

// --- sessionPipelineFilePath: the resolved layout -----------------------
strictEqual(
	sessionPipelineFilePath(CWD, "session-abc123"),
	join(CWD, ".agent-pipeline", "pipelines", "session-abc123.json"),
);
console.log("ok    path: session file under <cwd>/.agent-pipeline/pipelines/");
passed++;

// --- sessionPipelineFilePath: rejections --------------------------------
okCheck("path: bad key rejected", sessionPipelineFilePath(CWD, "../x") === null);
okCheck("path: empty key rejected", sessionPipelineFilePath(CWD, "") === null);
okCheck("path: non-string key rejected", sessionPipelineFilePath(CWD, 42) === null);
okCheck("path: relative cwd rejected", sessionPipelineFilePath("relative/path", "a") === null);
okCheck("path: empty cwd rejected", sessionPipelineFilePath("", "a") === null);
okCheck("path: non-string cwd rejected", sessionPipelineFilePath(null, "a") === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
