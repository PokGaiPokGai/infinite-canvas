import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { MASK_TYPES, maskInputKey } from "./image-mask";
import { getCanvasConfigOutput } from "@/lib/canvas/canvas-config-output";
import { isConnectionOperational } from "@/lib/canvas/canvas-connection-state";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export const IMAGE_COMPARE = "image-compare:compare";

// Derive outputs from the current graph, even for offscreen nodes. Never trust a saved output
// after its source has been disconnected, deleted, or started another generation.
export function resolveComparisonNodes(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (!nodes.some(node => node.type === IMAGE_COMPARE || MASK_TYPES.includes(node.type))) return nodes;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const resolved = new Map<string, CanvasNodeData>();
    const visiting = new Set<string>();
    const resolve = (node: CanvasNodeData): CanvasNodeData => {
        if (node.type !== IMAGE_COMPARE && !MASK_TYPES.includes(node.type)) return node;
        const cached = resolved.get(node.id);
        if (cached) return cached;
        const empty: CanvasNodeMetadata = { content: undefined, storageKey: undefined, naturalWidth: undefined, naturalHeight: undefined, mimeType: undefined, bytes: undefined, status: "idle" };
        if (visiting.has(node.id)) return { ...node, metadata: { ...node.metadata, ...empty } };
        visiting.add(node.id);
        const inputs = connections.filter(edge => edge.toNodeId === node.id).flatMap(edge => {
            const raw = byId.get(edge.fromNodeId);
            if (!raw || !isConnectionOperational(edge, raw, node)) return [];
            const source = resolve(raw);
            const metadata = source.metadata;
            const config = getCanvasConfigOutput(source);
            const resource = getNodeDefinition(source.type)?.resource?.(source);
            const image = source.type === CanvasNodeType.Image || source.type === IMAGE_COMPARE || config?.kind === "image" || resource?.kind === "image";
            if (!image) return [];
            const ready = metadata?.status !== "loading" && metadata?.status !== "error";
            const content = ready ? (config?.kind === "image" ? config.content : resource?.url || metadata?.content) : undefined;
            return [{ nodeId: source.id, title: source.title, content, storageKey: content ? metadata?.storageKey : undefined, naturalWidth: metadata?.naturalWidth, naturalHeight: metadata?.naturalHeight, mimeType: metadata?.mimeType, bytes: metadata?.bytes }];
        });
        if (MASK_TYPES.includes(node.type)) {
            const processInputKey = maskInputKey(node.type, node.metadata?.maskSettings, inputs.map(input => ({ ...input, id: input.nodeId })));
            const stale = processInputKey !== node.metadata?.processOutputKey;
            const result = { ...node, metadata: { ...node.metadata, ...(stale ? { ...empty, status: node.metadata?.status === "loading" || node.metadata?.status === "error" ? node.metadata.status : "idle" as const } : {}), processInputKey, productionInputs: inputs.map(input => ({ ...input, id: input.nodeId })) } };
            visiting.delete(node.id); resolved.set(node.id, result); return result;
        }
        const settings = node.metadata?.comparison;
        const selectedId = settings?.selected === "a" ? settings.aId : settings?.selected === "b" ? settings.bId : undefined;
        const selected = inputs.find(input => input.nodeId === selectedId && input.content);
        const output = selected ? { content: selected.content, storageKey: selected.storageKey, naturalWidth: selected.naturalWidth, naturalHeight: selected.naturalHeight, mimeType: selected.mimeType, bytes: selected.bytes, status: "success" as const } : empty;
        const result = { ...node, metadata: { ...node.metadata, ...output, comparisonInputs: inputs } };
        visiting.delete(node.id);
        resolved.set(node.id, result);
        return result;
    };
    return nodes.map(resolve);
}
