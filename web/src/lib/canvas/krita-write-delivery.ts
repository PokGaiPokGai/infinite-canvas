import { isConnectionOperational } from "@/lib/canvas/canvas-connection-state";
import { hasKritaWriteOutput, isKritaReadInputNode, isKritaWriteInputNode } from "@/lib/canvas/canvas-input-role";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type KritaWriteDelivery = {
    connectionId: string;
    sourceNode: CanvasNodeData;
    storageKey: string;
    url?: string;
    key: string;
};

export function getKritaWriteDelivery(writeNode: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): KritaWriteDelivery | null {
    if (!isKritaWriteInputNode(writeNode)) return null;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const inputs = connections.filter((connection) => connection.toNodeId === writeNode.id && isConnectionOperational(connection, byId.get(connection.fromNodeId), writeNode));
    if (inputs.length !== 1) return null;

    const connection = inputs[0];
    const sourceNode = byId.get(connection.fromNodeId);
    if (!sourceNode) return null;
    const metadata = sourceNode.metadata;
    if (metadata?.status === "loading" || metadata?.status === "error") return null;

    if (sourceNode.type === CanvasNodeType.Config) {
        const selected = metadata?.outputImages?.find((image) => image.id === metadata.selectedOutputImageId);
        if (metadata?.status !== "success" || !selected || selected.status !== "success" || !selected.content || !selected.storageKey || selected.storageKey !== metadata.storageKey || selected.content !== metadata.content) return null;
    } else if (isKritaReadInputNode(sourceNode)) {
        const link = metadata?.krita;
        if ((link?.kind !== "link" && link?.kind !== "source") || !link.snapshot) return null;
    } else if (isKritaWriteInputNode(sourceNode)) {
        if (!hasKritaWriteOutput(sourceNode) || metadata?.status !== "success") return null;
    } else if (sourceNode.type !== CanvasNodeType.Image && getNodeDefinition(sourceNode.type)?.resource?.(sourceNode)?.kind !== "image") {
        return null;
    }

    const storageKey = metadata?.storageKey;
    if (!storageKey) return null;
    const resource = getNodeDefinition(sourceNode.type)?.resource?.(sourceNode);
    const url = metadata?.content || (resource?.kind === "image" ? resource.url : undefined);
    return { connectionId: connection.id, sourceNode, storageKey, url, key: `${connection.id}:${storageKey}` };
}

export function isAutoReadDelivery(delivery: KritaWriteDelivery) {
    const link = delivery.sourceNode.metadata?.krita;
    return link?.kind === "link" && link.mode === "read" && "lastReadKind" in link && link.lastReadKind === "auto";
}
