/**
 * Compose the pipeline-level input string from the modal's text and attached
 * file paths. Deterministic: text verbatim, then one "Attached files" block
 * listing one absolute path per line; empty parts are omitted entirely.
 *
 * @param text - the multiline input text (may be empty when files are attached).
 * @param files - attached absolute paths, in attachment order.
 * @returns the composed input string ("" when both are empty).
 */
export declare function composePipelineInput(text: string, files: readonly string[]): string;
/**
 * Render the run result's terminal outputs as continue-in-chat text.
 *
 * @param outputs - the contract's `{ [terminalId]: output }` map.
 * @param labelOf - terminal id → display label (agent name).
 * @returns a single output verbatim (values rendered like the prompt framing);
 *   several outputs as one "## <label>" section per terminal; "" when empty.
 */
export declare function finalOutputText(outputs: Record<string, unknown>, labelOf: (id: string) => string): string;
//# sourceMappingURL=message.d.ts.map