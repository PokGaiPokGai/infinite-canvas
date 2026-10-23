import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getCanvasConfigOutput } from "@/lib/canvas/canvas-config-output";
import { isConnectionOperational } from "@/lib/canvas/canvas-connection-state";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export const BLENDER_LINK = "blender-link:link";
export function hasBlenderWriteOutput(node: CanvasNodeData) {
    const link = node.metadata?.blender;
    return node.type === BLENDER_LINK && link?.mode === "write" && !link.pending && !!link.receipt && !!node.metadata?.storageKey && !!node.metadata.content;
}

export function blenderWriteInput(writeNode: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const inputs = connections.filter(connection => connection.toNodeId === writeNode.id && isConnectionOperational(connection, nodes.find(node => node.id === connection.fromNodeId), writeNode));
    if (inputs.length !== 1) return null;
    const node = nodes.find(node => node.id === inputs[0].fromNodeId);
    if (!node || node.metadata?.status === "loading" || node.metadata?.status === "error") return null;
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    const output = getCanvasConfigOutput(node);
    if (node.type === CanvasNodeType.Config) {
        const selected = node.metadata?.outputImages?.find(image => image.id === node.metadata?.selectedOutputImageId);
        if (output?.kind !== "image" || node.metadata?.status !== "success" || selected?.status !== "success" || selected.content !== output.content || selected.storageKey !== output.storageKey) return null;
    } else if (node.type !== CanvasNodeType.Image && resource?.kind !== "image") return null;
    const storageKey = node.metadata?.storageKey;
    const url = resource?.kind === "image" ? resource.url : node.metadata?.content;
    if (!storageKey || !url) return null;
    return { node, storageKey, url, key: `${inputs[0].id}:${storageKey}` };
}
