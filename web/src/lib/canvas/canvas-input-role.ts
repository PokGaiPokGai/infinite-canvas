import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasInputRole, type CanvasNodeData } from "@/types/canvas";

export const CANVAS_INPUT_ROLES: { value: CanvasInputRole; label: string }[] = [
    { value: "reference", label: "参考" },
    { value: "composition", label: "构图" },
    { value: "style", label: "风格" },
    { value: "palette", label: "配色" },
    { value: "character", label: "角色" },
    { value: "material", label: "材质" },
    { value: "pose", label: "姿态" },
    { value: "depth", label: "深度" },
    { value: "mask", label: "蒙版描述" },
];

export function canvasInputRoleLabel(role?: CanvasInputRole) {
    return CANVAS_INPUT_ROLES.find((item) => item.value === role)?.label || "参考";
}

export function isKritaReadInputNode(node: CanvasNodeData) {
    const krita = node.metadata?.krita;
    return (node.type === "krita-link:source" && krita?.kind === "source") || (node.type === "krita-link:link" && krita?.kind === "link" && krita.mode === "read");
}

export function isImageLinkNode(node: CanvasNodeData) {
    return node.type === "krita-link:link" || node.type === "blender-link:link";
}

export function isKritaWriteInputNode(node: CanvasNodeData) {
    return node.type === "krita-link:link" && node.metadata?.krita?.kind === "link" && node.metadata.krita.mode === "write";
}

export function hasKritaWriteOutput(node: CanvasNodeData) {
    const link = node.metadata?.krita;
    return isKritaWriteInputNode(node) && link?.kind === "link" && !!link.commandId && !!link.returnedLayerId && !!link.returnedAt && !!link.sourceImage?.storageKey && link.sourceImage.storageKey === node.metadata?.storageKey && !!node.metadata?.content;
}

export function isImageInputNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image || (node.type === CanvasNodeType.Config && (!node.metadata?.generationMode || node.metadata.generationMode === "image")) || isKritaReadInputNode(node) || isKritaWriteInputNode(node) || getNodeDefinition(node.type)?.resource?.(node)?.kind === "image";
}
