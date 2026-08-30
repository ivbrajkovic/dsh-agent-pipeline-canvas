// dsh-agent-pipeline-canvas — durable file storage (Host side).
//
// The atomic-write protocol shared by everything the Host half persists: the
// pipeline graph (`.agent-pipeline/pipeline.json`, see index.ts) and the run
// records (`.agent-pipeline/runs/<runId>.json`, see runs.ts). One writer (this
// process) publishing whole files is safe because every replacement goes
// through a same-directory temp file + rename (atomic on POSIX and Windows),
// so a crash mid-write never leaves a truncated file behind.

import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * On Windows the rename leg intermittently fails with EPERM/EACCES: a freshly
 * closed file can be momentarily held by the OS (Defender scans, the indexer,
 * search indexing) and `rename()` over it is rejected for a few milliseconds.
 * The write is retried with a small backoff — the protocol only needs the
 * rename to EVENTUALLY land, and the temp file is fresh every attempt.
 */
const RENAME_RETRIES = 8;
const RETRY_DELAY_MS = 25;

function isTransientRenameError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (attempt >= RENAME_RETRIES || !isTransientRenameError(error)) throw error;
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
export async function writeAtomic(path: string, data: string): Promise<void> {
	const dir = dirname(path);
	const tmp = join(dir, `.${randomUUID()}.tmp`);
	try {
		const handle = await open(tmp, "wx", 0o600);
		try {
			await handle.writeFile(data, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await renameWithRetry(tmp, path);
	} catch (error) {
		try { await rm(tmp, { force: true }); } catch { /* best-effort cleanup */ }
		throw error;
	}
}
