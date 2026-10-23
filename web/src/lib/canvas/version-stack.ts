import { CanvasNodeType, type CanvasNodeData, type CanvasConnection, type CanvasNodeMetadata } from "@/types/canvas";

export const VERSION_STACK = "version-stack:images";
export const STACK_RELEASE = "version-stack:release";
export function stackMembers(stack: CanvasNodeData, nodes: CanvasNodeData[]) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    return [...new Set(stack.metadata?.versionStack?.memberIds || [])].flatMap(id => {
        const node = byId.get(id);
        return node?.type === CanvasNodeType.Image ? [node] : [];
    });
}
export function stackedNodeIds(nodes: CanvasNodeData[]) {
    return new Set(nodes.filter(node => node.type === VERSION_STACK).flatMap(stack => stackMembers(stack, nodes).map(node => node.id)));
}
export function stackDisplayNodes(nodes: CanvasNodeData[]) {
    const hidden = stackedNodeIds(nodes);
    return nodes.filter(node => !hidden.has(node.id));
}
export function canStackNodes(nodes: CanvasNodeData[]) {
    return nodes.length >= 2 && nodes.every(node => node.type === CanvasNodeType.Image);
}
export function resolveVersionStacks(nodes: CanvasNodeData[]) {
    if (!nodes.some(node => node.type === VERSION_STACK)) return nodes;
    return nodes.map(node => {
        if (node.type !== VERSION_STACK) return node;
        const members = stackMembers(node, nodes);
        const inputs = members.map(member => ({ nodeId: member.id, title: member.title, ...member.metadata }));
        const selected = inputs.find(input => input.nodeId === node.metadata?.versionStack?.selectedId);
        const ready = selected?.content && selected.status !== "loading" && selected.status !== "error";
        const output: CanvasNodeMetadata = { content: ready ? selected.content : undefined, storageKey: ready ? selected.storageKey : undefined, naturalWidth: ready ? selected.naturalWidth : undefined, naturalHeight: ready ? selected.naturalHeight : undefined, mimeType: ready ? selected.mimeType : undefined, bytes: ready ? selected.bytes : undefined, status: ready ? "success" : "idle" };
        return { ...node, metadata: { ...node.metadata, ...output, stackInputs: inputs } };
    });
}
// Keep original nodes and their edges intact. Releasing restores them near the moved pile.
export function releaseVersionStack(nodes: CanvasNodeData[], connections: CanvasConnection[], stackId: string, memberId?: string) {
    const stack = nodes.find(node => node.id === stackId && node.type === VERSION_STACK);
    if (!stack) return null;
    const members = stackMembers(stack, nodes);
    if (memberId && !members.some(node => node.id === memberId)) return null;
    const released = memberId ? members.filter(node => node.id === memberId) : members;
    const remaining = members.filter(node => !released.includes(node));
    const dissolve = remaining.length < 2;
    const arranged = dissolve ? members : released;
    const positions = new Map(arranged.map((node, index) => [node.id, { x: stack.position.x + (index % 3) * (stack.width + 32), y: stack.position.y + Math.floor(index / 3) * (stack.height + 48) }]));
    if (!dissolve && memberId) positions.set(memberId, { x: stack.position.x + stack.width + 40, y: stack.position.y });
    const selectedId = stack.metadata?.versionStack?.selectedId;
    const outputId = members.find(node => node.id === selectedId)?.id;
    const nextNodes = nodes.filter(node => !dissolve || node.id !== stackId).map(node => {
        if (node.id === stackId) return { ...node, metadata: { ...node.metadata, versionStack: { memberIds: remaining.map(member => member.id), selectedId: remaining.some(member => member.id === selectedId) ? selectedId : undefined } } };
        const position = positions.get(node.id);
        const comparison = node.metadata?.comparison;
        const rebound = dissolve && comparison && (comparison.aId === stackId || comparison.bId === stackId) ? { ...node, metadata: { ...node.metadata, comparison: { ...comparison, aId: comparison.aId === stackId ? outputId : comparison.aId, bId: comparison.bId === stackId ? outputId : comparison.bId } } } : node;
        return position ? { ...rebound, position } : rebound;
    });
    const nextConnections = dissolve ? connections.flatMap(edge => {
        if (edge.toNodeId === stackId) return [];
        if (edge.fromNodeId !== stackId) return [edge];
        if (!outputId || outputId === edge.toNodeId || connections.some(other => other.fromNodeId === outputId && other.toNodeId === edge.toNodeId)) return [];
        return [{ ...edge, fromNodeId: outputId }];
    }) : connections.filter(edge => edge.toNodeId !== stackId || !released.some(node => node.id === edge.fromNodeId));
    return { nodes: nextNodes, connections: nextConnections, selectedIds: arranged.map(node => node.id) };
}
