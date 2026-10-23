import type { CanvasNodeData } from "@/types/canvas";

const inputCaches = new Set(["productionInputs", "comparisonInputs", "stackInputs"]);
const computedOutput = new Set([
    "content", "storageKey", "naturalWidth", "naturalHeight", "mimeType", "bytes", "outputKind",
    "status", "errorDetails", "processInputKey", "processOutputKey", "processRunKey", "processErrorKey", "selectedProcessResultId",
]);

function historyInput(node: CanvasNodeData) {
    const computed = node.type.startsWith("process:mask-") || ["process:alpha-apply", "image-compare:compare", "version-stack:images"].includes(node.type);
    const metadata = Object.fromEntries(Object.entries(node.metadata || {}).filter(([key]) => !inputCaches.has(key) && !(computed && computedOutput.has(key))));
    return { ...node, metadata };
}

// Compare editable state only; callers retain the original nodes in history snapshots.
export function sameHistoryNodes(first: CanvasNodeData[], second: CanvasNodeData[]) {
    return first === second || first.length === second.length && first.every((node, index) => node === second[index] || JSON.stringify(historyInput(node)) === JSON.stringify(historyInput(second[index])));
}
