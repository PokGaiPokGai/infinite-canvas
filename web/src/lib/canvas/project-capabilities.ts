import type { CanvasNodeData } from '../../types/canvas';

// Check nested reusable workflows too, before hydration or autosave can rewrite a project.
export function unsupportedNodeTypes(nodes: CanvasNodeData[], supports: (type: string) => boolean): string[] {
    const missing = new Set<string>();
    const visit = (items: CanvasNodeData[]) => {
        for (const node of items) {
            if (!supports(node.type)) missing.add(node.type);
            if (node.metadata?.workflow?.nodes) visit(node.metadata.workflow.nodes);
        }
    };
    visit(nodes);
    return [...missing].sort();
}
