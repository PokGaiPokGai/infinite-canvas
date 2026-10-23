import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import type { ProcessResult, WorkflowSettings, WorkflowDefinition } from "@/types/canvas-workflow";
import { getCanvasConfigOutput } from "./canvas-config-output";
import { getNodeDefinition } from "./node-registry";
import { MASK_TYPES } from "./image-mask";
import { REFERENCE_PACK } from "./canvas-production";
import { isConnectionOperational } from "./canvas-connection-state";

export const BATCH_NODE = "process:batch";
export const WORKFLOW_NODE = "process:workflow";
export const WORKFLOW_SOURCE = "canvas-workflow-template";
export const EMPTY_WORKFLOW: WorkflowSettings = { name: "新流程", nodes: [], connections: [], inputs: [], outputs: [], parameters: [], bindings: {}, values: {} };
export const isWorkflowStep = (node: CanvasNodeData) => [CanvasNodeType.Image, CanvasNodeType.Text, REFERENCE_PACK, ...MASK_TYPES].includes(node.type) || node.type === CanvasNodeType.Config && ["image", "text"].includes(node.metadata?.generationMode || "image");
export const canMakeWorkflow = (nodes: CanvasNodeData[]) => nodes.length >= 2 && nodes.every(isWorkflowStep);

export function nodeResult(node: CanvasNodeData): ProcessResult | null {
    const data = node.metadata;
    if (data?.status === "error" || data?.status === "loading") return null;
    const configured = getCanvasConfigOutput(node);
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    const kind = configured?.kind || (node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Image || MASK_TYPES.includes(node.type) ? "image" : data?.outputKind || resource?.kind);
    if (kind !== "image" && kind !== "text") return null;
    const content = configured?.content || (kind === "text" ? resource?.text : resource?.url) || data?.content;
    if (!content && !data?.storageKey) return null;
    return { id: node.id, title: node.title, kind, content: content || "", ...(kind === "image" ? { storageKey: configured && "storageKey" in configured ? configured.storageKey : data?.storageKey, naturalWidth: data?.naturalWidth, naturalHeight: data?.naturalHeight, mimeType: data?.mimeType, bytes: data?.bytes } : {}) };
}

export function captureWorkflow(selected: CanvasNodeData[], nodes: CanvasNodeData[], edges: CanvasConnection[]): WorkflowSettings {
    if (!canMakeWorkflow(selected)) throw new Error("选择至少两个图片、文本、图像／文本生成、参考包或蒙版步骤。");
    const ids = new Set(selected.map(node => node.id));
    const graph = structuredClone(selected).map(node => ({ ...node, metadata: { ...node.metadata, groupId: undefined } }));
    const connections = edges.filter(edge => ids.has(edge.toNodeId) && isConnectionOperational(edge, nodes.find(node => node.id === edge.fromNodeId), nodes.find(node => node.id === edge.toNodeId)));
    const bindings: Record<string, string> = {};
    for (const edge of connections) {
        if (ids.has(edge.fromNodeId) || graph.some(node => node.id === edge.fromNodeId)) continue;
        const source = nodes.find(node => node.id === edge.fromNodeId)!;
        const result = nodeResult(source);
        if (!result) throw new Error(`外部输入「${source.title}」尚未就绪。`);
        graph.push({ ...source, type: result.kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Text, metadata: { ...result, status: "success" } });
        bindings[source.id] = source.id;
    }
    const inputs = graph.filter(node => [CanvasNodeType.Image, CanvasNodeType.Text].includes(node.type as CanvasNodeType) && !connections.some(edge => edge.toNodeId === node.id)).map(node => ({ id: node.id, nodeId: node.id, name: node.title, kind: node.type === CanvasNodeType.Text ? "text" as const : "image" as const }));
    const outputs = selected.filter(node => node.type !== REFERENCE_PACK && !connections.some(edge => edge.fromNodeId === node.id && ids.has(edge.toNodeId))).map(node => ({ id: node.id, name: node.title, nodeId: node.id }));
    if (!outputs.length) throw new Error("流程需要至少一个末端输出，请检查循环连线。");
    const left = Math.min(...graph.map(node => node.position.x)); const top = Math.min(...graph.map(node => node.position.y));
    return { name: "复用流程", nodes: graph.map(node => ({ ...node, position: { x: node.position.x - left, y: node.position.y - top } })), connections: structuredClone(connections), inputs, outputs, parameters: [], bindings, values: {} };
}

export function cloneWorkflowGraph(workflow: WorkflowDefinition, offset = { x: 0, y: 0 }, groupId?: string): WorkflowDefinition {
    const ids = new Map(workflow.nodes.map(node => [node.id, nanoid()]));
    return { ...structuredClone(workflow), nodes: workflow.nodes.map(node => {
        const metadata = structuredClone(node.metadata || {});
        metadata.groupId = groupId;
        if (metadata.composerContent) metadata.composerContent = metadata.composerContent.replace(/@\[node:([^\]]+)\]/g, (token, id: string) => ids.has(id) ? `@[node:${ids.get(id)}]` : token);
        if (metadata.maskSettings) metadata.maskSettings = { ...metadata.maskSettings, imageId: ids.get(metadata.maskSettings.imageId || ""), maskId: ids.get(metadata.maskSettings.maskId || "") };
        return { ...node, id: ids.get(node.id)!, position: { x: node.position.x + offset.x, y: node.position.y + offset.y }, metadata };
    }), connections: workflow.connections.map(edge => ({ ...edge, id: nanoid(), fromNodeId: ids.get(edge.fromNodeId)!, toNodeId: ids.get(edge.toNodeId)! })), inputs: workflow.inputs.map(input => ({ ...input, nodeId: ids.get(input.nodeId)! })), outputs: workflow.outputs.map(output => ({ ...output, nodeId: ids.get(output.nodeId)! })), parameters: workflow.parameters.map(parameter => ({ ...parameter, nodeId: ids.get(parameter.nodeId)! })) };
}

export function validateWorkflow(workflow: WorkflowDefinition) {
    const byId = new Map(workflow.nodes.map(node => [node.id, node]));
    if (!workflow.nodes.length || byId.size !== workflow.nodes.length || !workflow.nodes.every(isWorkflowStep)) throw new Error("流程包含不支持的步骤或重复节点，请展开检查。");
    if (!workflow.outputs.length || workflow.outputs.some(output => !byId.has(output.nodeId))) throw new Error("请选择有效的流程输出。");
    if (workflow.inputs.some(input => !byId.has(input.nodeId))) throw new Error("流程输入绑定已失效。");
    const done = new Set<string>(); const active = new Set<string>();
    const visit = (id: string) => {
        if (active.has(id)) throw new Error("流程存在循环连线。");
        if (done.has(id)) return;
        active.add(id);
        for (const edge of workflow.connections.filter(edge => edge.toNodeId === id && edge.enabled !== false)) {
            if (!byId.has(edge.fromNodeId)) throw new Error("流程连线引用了缺失的节点。");
            visit(edge.fromNodeId);
        }
        active.delete(id); done.add(id);
    };
    workflow.nodes.forEach(node => visit(node.id));
}
