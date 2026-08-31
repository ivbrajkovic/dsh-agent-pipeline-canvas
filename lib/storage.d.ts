/**
 * Whether `key` is an acceptable session key for the per-session pipeline
 * file. The REGEX is the guarantee: shape-agnostic (live harness ids are
 * `session-<uuid>` shaped and pass; caller-supplied ids pass too) and free of
 * path separators, so appending the literal `.json` suffix verbatim has no
 * traversal surface.
 */
export declare function isValidSessionKey(key: unknown): key is string;
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
export declare function sessionPipelineFilePath(cwd: unknown, sessionId: unknown): string | null;
/**
 * Durably replace `path` with `data`: write a same-directory temp file, fsync
 * it, then `rename()` over the target. A failed write cleans up the temp file.
 * Mirrors the product's JSON-storage backend write protocol.
 * @param path - absolute target file path.
 * @param data - full new file content.
 */
export declare function writeAtomic(path: string, data: string): Promise<void>;
//# sourceMappingURL=storage.d.ts.map