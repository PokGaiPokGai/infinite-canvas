import type { CanvasConnection, CanvasMediaOutput, CanvasNodeData, CanvasNodeMetadata, CanvasInputRole } from "./canvas";

export type MaskSettings = { channel?: "alpha" | "luminance"; amount?: number; radius?: number; imageId?: string; maskId?: string };
export type ProcessResult = CanvasMediaOutput & { id: string; title: string; kind: "image" | "text"; role?: CanvasInputRole };
export type MatrixField = "prompt" | "model" | "size" | "seed" | "steps" | "cfg" | "denoise";
export type BatchSettings = { mode: "image" | "text"; prompt: string; inputText: string; model: string; size: string; axes: { field: MatrixField; values: string[] }[] };
export type BatchRow = { id: string; input: ProcessResult; params: Partial<Record<MatrixField, string>>; config: CanvasNodeMetadata; references: ProcessResult[]; state: "pending" | "running" | "success" | "error" | "cancelled"; result?: ProcessResult; error?: string };
export type WorkflowInput = { id: string; name: string; nodeId: string; kind: "image" | "text" };
export type WorkflowParameter = { id: string; name: string; nodeId: string; field: "prompt" | "model" | "size" | "amount" | "radius"; value: string };
export type WorkflowDefinition = {
    name: string; nodes: CanvasNodeData[]; connections: CanvasConnection[];
    inputs: WorkflowInput[]; outputs: { id: string; name: string; nodeId: string }[]; parameters: WorkflowParameter[];
};
export type WorkflowSettings = WorkflowDefinition & { assetId?: string; bindings: Record<string, string>; values: Record<string, string>; expandedGroupId?: string };
