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
        await rename(tmp, path);
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