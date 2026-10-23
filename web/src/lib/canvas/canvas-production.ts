import { getNodeDefinition } from "./node-registry";
import { isConnectionOperational } from "./canvas-connection-state";
import { getCanvasConfigOutput } from "./canvas-config-output";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import type { ProductionImage, ReferencePack, ExportPreset } from "@/types/canvas-production";

export const REFERENCE_PACK = "production:reference-pack";
export const EXPORT_PRESET = "production:export-preset";
export const PACK_SOURCE = "canvas-reference-pack";
export const EXPORT_SOURCE = "canvas-export-preset";
export const EMPTY_PACK: ReferencePack = { name: "", kind: "style", rules: "", version: 0, images: [] };
export const DEFAULT_EXPORT: ExportPreset = { name: "游戏图标", width: 512, height: 512, format: "png", fit: "contain", transparent: true, background: "#ffffff", pattern: "{name}_{index}", directory: "Icons", metadata: true };

export function referencePackText(pack?: ReferencePack) {
    return pack ? `${pack.kind === "character" ? "角色" : "风格"}参考包：${pack.name || "未命名"}（${pack.version ? `v${pack.version}` : "草稿"}）\n${pack.rules}` : "";
}

export function productionImage(node: CanvasNodeData): ProductionImage | null {
    const metadata = node.metadata;
    const config = getCanvasConfigOutput(node);
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    const knownImage = [CanvasNodeType.Image, "image-compare:compare", "version-stack:images", "krita-link:link", "krita-link:source", "blender-link:link"].includes(node.type) || (node.type === CanvasNodeType.Config && (metadata?.generationMode || "image") === "image");
    if (!knownImage && config?.kind !== "image" && resource?.kind !== "image") return null;
    const available = metadata?.status !== "loading" && metadata?.status !== "error";
    return { id: node.id, title: node.title, content: available ? (config?.content || resource?.url || metadata?.content) : undefined, storageKey: metadata?.storageKey, naturalWidth: metadata?.naturalWidth, naturalHeight: metadata?.naturalHeight, bytes: metadata?.bytes, mimeType: metadata?.mimeType, status: available ? "success" : metadata?.status };
}

export function resolveProductionInputs(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    return nodes.map(node => {
        if (node.type !== REFERENCE_PACK && node.type !== EXPORT_PRESET) return node;
        const inputs = connections.filter(edge => edge.toNodeId === node.id).flatMap(edge => {
            const source = byId.get(edge.fromNodeId);
            if (!source || !isConnectionOperational(edge, source, node)) return [];
            const image = productionImage(source);
            return image ? [image] : [];
        });
        return { ...node, metadata: { ...node.metadata, productionInputs: inputs } };
    });
}
