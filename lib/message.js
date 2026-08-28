// dsh-agent-pipeline-canvas — message composition (pure, runtime-only).
//
// Frames the two free-text surfaces the UI adds around a run. Neither function
// touches the persisted graph, the wire `{ agents, connections }` shape, or the
// execution contract — the composed string simply becomes the pipeline-level
// INPUT the roots receive under `$input` (renderValue framing), and the
// continue-text becomes an unsent chat draft.
//
// - composePipelineInput: the Run modal's text + attached workspace files.
//   Files travel as ABSOLUTE PATHS ONLY — contents are never inlined; the
//   first agent reads them with its own file tools.
// - finalOutputText: the run result `{ outputs: { [terminalId]: output } }`
//   rendered as the text a result modal hands to a chat composer.
import { renderValue } from "./execution.js";
/**
 * Compose the pipeline-level input string from the modal's text and attached
 * file paths. Deterministic: text verbatim, then one "Attached files" block
 * listing one absolute path per line; empty parts are omitted entirely.
 *
 * @param text - the multiline input text (may be empty when files are attached).
 * @param files - attached absolute paths, in attachment order.
 * @returns the composed input string ("" when both are empty).
 */
export function composePipelineInput(text, files) {
    const parts = [];
    if (typeof text === "string" && text.length > 0)
        parts.push(text);
    if (Array.isArray(files) && files.length > 0) {
        parts.push("Attached files (absolute paths — read them with your file tools; their contents are not inlined here):"
            + "\n" + files.map((f) => "- " + String(f)).join("\n"));
    }
    return parts.join("\n\n");
}
/**
 * Render the run result's terminal outputs as continue-in-chat text.
 *
 * @param outputs - the contract's `{ [terminalId]: output }` map.
 * @param labelOf - terminal id → display label (agent name).
 * @returns a single output verbatim (values rendered like the prompt framing);
 *   several outputs as one "## <label>" section per terminal; "" when empty.
 */
export function finalOutputText(outputs, labelOf) {
    const map = outputs ?? {};
    const ids = Object.keys(map);
    if (ids.length === 0)
        return "";
    if (ids.length === 1)
        return renderValue(map[ids[0]]);
    return ids.map((id) => "## " + labelOf(id) + "\n" + renderValue(map[id])).join("\n\n");
}
//# sourceMappingURL=message.js.map