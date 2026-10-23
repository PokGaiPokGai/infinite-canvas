import { ALPHA_APPLY, MASK_TYPES } from "./image-mask";
import type { CanvasNodeData } from "@/types/canvas";
import type { MaskUpdateJob } from "./mask-auto-updater";

// The project resolves the whole graph first, so only steps with current inputs run.
// Publishing one step unlocks its dependants, including branches outside the viewport.
export function maskAutoJobs(nodes: CanvasNodeData[]): MaskUpdateJob[] {
    return nodes.flatMap(node => {
        if (!MASK_TYPES.includes(node.type)) return [];
        const data = node.metadata;
        if (!data?.processInputKey) return [];
        const key = data.processInputKey;
        if (key === data.processErrorKey || key === data.processOutputKey && data.content) return [];
        const inputs = data.productionInputs || [];
        const settings = data.maskSettings || {};
        if (inputs.length < (node.type === ALPHA_APPLY ? 2 : 1) || inputs.some(input => !input.content)) return [];
        if (node.type === ALPHA_APPLY && (!inputs.some(input => input.id === settings.imageId) || !inputs.some(input => input.id === settings.maskId))) return [];
        return [{ id: node.id, key, type: node.type, settings: { ...settings }, inputs: inputs.map(input => ({ ...input, kind: "image" as const, content: input.content! })) }];
    });
}
