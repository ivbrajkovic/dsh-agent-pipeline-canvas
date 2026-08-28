// The Run modal: multiline pipeline input plus workspace files attached as
// ABSOLUTE PATHS. Files are never inlined — the first agent reads them with
// its own tools. The picker rides the harness's own `@`-mention file-reference
// completion (`remote.fileReferences.list`): type a path prefix, click a file
// to attach it, click a directory to descend. OS drag-and-drop of files
// cannot yield absolute paths in a browser, so a dropped file shows a notice;
// dropped plain-text paths are attached.
import * as React from "react";
import { ENDPOINT, absolutePath, type FileRefCandidate } from "./shared.ts";
import "./run-modal.css";

function RunModal({ cwd, initialText, initialFiles, running, fileList, onRun, onClose }: {
	cwd?: string;
	initialText: string;
	initialFiles: string[];
	running: boolean;
	fileList: ((query: string, signal: AbortSignal) => Promise<FileRefCandidate[]>) | null;
	onRun: (text: string, files: string[]) => void;
	onClose: () => void;
}) {
	const [text, setText] = React.useState(initialText);
	const [files, setFiles] = React.useState<string[]>(initialFiles);
	const [query, setQuery] = React.useState("");
	const [candidates, setCandidates] = React.useState<FileRefCandidate[]>([]);
	const [pickerState, setPickerState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
	const [manual, setManual] = React.useState("");
	const [notice, setNotice] = React.useState<string | null>(null);
	const [dragOver, setDragOver] = React.useState(false);
	function stopKey(e: React.KeyboardEvent) {
		e.stopPropagation();
		if (e.key === "Escape") onClose();
	}
	function attach(path: string) {
		const abs = absolutePath(path.trim(), cwd);
		if (abs.length === 0) return;
		setFiles((prev) => (prev.indexOf(abs) === -1 ? prev.concat([abs]) : prev));
	}
	function onPickRow(candidate: FileRefCandidate, add: boolean) {
		const path = typeof candidate.path === "string" ? candidate.path : "";
		if (path.length === 0) return;
		if (add || candidate.kind !== "directory") attach(path);
		else setQuery(path + "/");
	}
	function onDrop(e: React.DragEvent) {
		e.preventDefault();
		setDragOver(false);
		const text = e.dataTransfer.getData("text/plain");
		if (typeof text === "string" && text.trim().startsWith("/")) {
			text.split("\n").forEach((line) => { if (line.trim().startsWith("/")) attach(line); });
			return;
		}
		if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
			setNotice("The browser hides dropped files' paths — use the picker below (or paste a path).");
		}
	}
	// Debounced completion query against the file-reference source.
	React.useEffect(() => {
		if (fileList === null) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			setPickerState("loading");
			fileList(query, controller.signal)
				.then((rows) => {
					if (controller.signal.aborted) return;
					setCandidates(rows.filter((c) => c && typeof c.path === "string" && c.path.length > 0));
					setPickerState("ready");
				})
				.catch(() => {
					if (controller.signal.aborted) return;
					setCandidates([]);
					setPickerState("error");
				});
		}, 150);
		return () => { clearTimeout(timer); controller.abort(); };
	}, [query, fileList]);
	return (
		<div className="pipeline-modal-overlay" onPointerDown={(e) => { e.stopPropagation(); }}>
			<div className="pipeline-modal">
				<h3>Run Pipeline</h3>
				<div className="modal-row">
					<label>Input (the first agent receives this)</label>
					<textarea
						value={text}
						placeholder="What should the pipeline do?"
						onChange={(e) => { setText(e.target.value); }}
						onKeyDown={stopKey}
					/>
				</div>
				<div
					className={"pipeline-attach-zone" + (dragOver ? " drag" : "")}
					onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
					onDragLeave={() => { setDragOver(false); }}
					onDrop={onDrop}
				>
					{files.length > 0 ? (
						<div className="pipeline-chips">
							{files.map((f) => (
								<span key={f} className="pipeline-chip" title={f}>
									<span className="chip-path">{f}</span>
									<button
										className="chip-x"
										title="Remove"
										onClick={() => { setFiles((prev) => prev.filter((p) => p !== f)); }}
									>×</button>
								</span>
							))}
						</div>
					) : (
						<div className="pipeline-picker-status">No files attached.</div>
					)}
					{fileList !== null ? (
						<input
							value={query}
							placeholder="Attach workspace files — type a path to search…"
							onChange={(e) => { setQuery(e.target.value); }}
							onKeyDown={stopKey}
						/>
					) : null}
					{fileList !== null && (pickerState !== "idle" || query.length > 0) ? (
						<div className="pipeline-picker-list">
							{pickerState === "loading" ? <div className="pipeline-picker-row"><span className="pipeline-picker-status">Searching…</span></div> : null}
							{pickerState === "error" ? <div className="pipeline-picker-row"><span className="pipeline-picker-status">File search unavailable.</span></div> : null}
							{pickerState === "ready" && candidates.length === 0 ? <div className="pipeline-picker-row"><span className="pipeline-picker-status">No matches.</span></div> : null}
							{candidates.map((c) => (
								<div key={c.path} className="pipeline-picker-row" onClick={() => { onPickRow(c, false); }}>
									<span className="row-kind">{c.kind === "directory" ? "dir" : "file"}</span>
									<span className="row-path" title={c.path}>{c.path}</span>
									<button
										className="row-add"
										title="Attach"
										onClick={(e) => { e.stopPropagation(); onPickRow(c, true); }}
									>+ attach</button>
								</div>
							))}
						</div>
					) : null}
					<div className="pipeline-chips">
						<input
							value={manual}
							placeholder="…or paste an absolute path"
							style={{ flex: "1 1 200px", width: "auto" }}
							onChange={(e) => { setManual(e.target.value); }}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter") { attach(manual); setManual(""); }
								if (e.key === "Escape") onClose();
							}}
						/>
						<button
							className="pipeline-btn"
							disabled={manual.trim().length === 0}
							onClick={() => { attach(manual); setManual(""); }}
						>Add</button>
					</div>
					{notice ? <div className="pipeline-modal-notice">{notice}</div> : null}
				</div>
				<div className="pipeline-picker-status">
					Files attach as absolute paths only — the first agent reads them with its own tools.
				</div>
				<div className="pipeline-modal-actions">
					<button className="pipeline-btn" onClick={onClose}>Cancel</button>
					<button
						className="pipeline-btn pipeline-btn-run"
						disabled={running}
						onClick={() => { onRun(text, files); }}
					>{running ? "Running…" : "Run"}</button>
				</div>
			</div>
		</div>
	);
}

export { RunModal };
