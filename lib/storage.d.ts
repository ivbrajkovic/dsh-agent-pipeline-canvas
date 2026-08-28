/**
 * Durably replace `path` with `data`: write a same-directory temp file, fsync
 * it, then `rename()` over the target. A failed write cleans up the temp file.
 * Mirrors the product's JSON-storage backend write protocol.
 * @param path - absolute target file path.
 * @param data - full new file content.
 */
export declare function writeAtomic(path: string, data: string): Promise<void>;
//# sourceMappingURL=storage.d.ts.map