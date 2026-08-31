// dsh-agent-pipeline-canvas — durable file storage (Host side).
//
// The atomic-write protocol shared by everything the Host half persists: the
// legacy workspace pipeline graph (`.agent-pipeline/pipeline.json`, see
// index.ts), the per-session pipeline graphs
// (`.agent-pipeline/pipelines/<sessionId>.json`), and the run records
// (`.agent-pipeline/runs/<runId>.json`, see runs.ts). Alongside `writeAtomic`
// this module owns the pure path seam for the per-session graphs
// (`isValidSessionKey`, `sessionPipelineFilePath`). One writer (this
// process) publishing whole files is safe because every replacement goes
// through a same-directory temp file + rename (atomic on POSIX and Windows),
// so a crash mid-write never leaves a truncated file behind.
import { open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
// The per-session graph layout, shared with index.ts's constants: a session
// that has forked owns `.agent-pipeline/pipelines/<sessionId>.json`.
const PIPELINE_DIR = ".agent-pipeline";
const PIPELINES_DIR = "pipelines";
const PIPELINE_FILE_SUFFIX = ".json";
/** Session keys longer than this are refused (keeps the file path sane). */
const MAX_SESSION_KEY_LENGTH = 128;
/** First char alphanumeric, then alphanumerics/underscores/dashes. */
const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/**
 * Whether `key` is an acceptable session key for the per-session pipeline
 * file. The REGEX is the guarantee: shape-agnostic (live harness ids are
 * `session-<uuid>` shaped and pass; caller-supplied ids pass too) and free of
 * path separators, so appending the literal `.json` suffix verbatim has no
 * traversal surface.
 */
export function isValidSessionKey(key) {
    return typeof key === "string" && key.length <= MAX_SESSION_KEY_LENGTH
        && SESSION_KEY_PATTERN.test(key);
}
/**
 * Resolve the per-session pipeline file path for a project root and session
 * key, or null when either is unusable (the same absolute-cwd rule as
 * index.ts's `pipelinePath`, plus `isValidSessionKey`). The literal
 * `<sessionId>.json` suffix is appended verbatim, so there is no
 * path-traversal surface here.
 * @param cwd - the project root (workspace directory) the browser supplied.
 * @param sessionId - the session key the request is scoped to.
 * @returns the absolute per-session pipeline file path, or null to reject.
 */
export function sessionPipelineFilePath(cwd, sessionId) {
    if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd))
        return null;
    if (!isValidSessionKey(sessionId))
        return null;
    return join(cwd, PIPELINE_DIR, PIPELINES_DIR, sessionId + PIPELINE_FILE_SUFFIX);
}
/**
 * On Windows the rename leg intermittently fails with EPERM/EACCES: a freshly
 * closed file can be momentarily held by the OS (Defender scans, the indexer,
 * search indexing) and `rename()` over it is rejected for a few milliseconds.
 * The write is retried with a small backoff — the temp file is already fsynced
 * and closed, so re-renaming it is safe; the write only needs the rename to
 * EVENTUALLY land.
 */
const RENAME_RETRIES = 8;
const RETRY_DELAY_MS = 25;
function isTransientRenameError(error) {
    const code = error?.code;
    return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}
async function renameWithRetry(from, to) {
    for (let attempt = 0;; attempt++) {
        try {
            await rename(from, to);
            return;
        }
        catch (error) {
            if (attempt >= RENAME_RETRIES || !isTransientRenameError(error))
                throw error;
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
}
/**
 * Durably replace `path` with `data`: write a same-directory temp file, fsync
 * it, then `rename()` over the target. A failed write cleans up the temp file.
 * Mirrors the product's JSON-storage backend write protocol.
 * @param path - absolute target file path.
 * @param data - full new file content.
 */
export async function writeAtomic(path, data) {
    const dir = dirname(path);
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    try {
        const handle = await open(tmp, "wx", 0o600);
        try {
            await handle.writeFile(data, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await renameWithRetry(tmp, path);
    }
    catch (error) {
        try {
            await rm(tmp, { force: true });
        }
        catch { /* best-effort cleanup */ }
        throw error;
    }
}
//# sourceMappingURL=storage.js.map