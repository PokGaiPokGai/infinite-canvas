import { getNodeDefinition } from "./node-registry";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasTheme } from "@/lib/canvas-theme";

export type CanvasSocketType = "image" | "mask" | "text" | "video" | "audio" | "reference" | "mixed";
export type CanvasInputSocket = { type: CanvasSocketType; multiple: boolean };

export const canvasSocketLabels: Record<CanvasSocketType, string> = {
    image: "图片", mask: "蒙版 / 灰度图", text: "文字", video: "视频", audio: "音频", reference: "参考包", mixed: "混合数据",
};

// A port describes the data, not the node's status or whether an output already exists.
// Masks are still image resources; this semantic distinction only controls presentation.
export function getCanvasOutputType(node: CanvasNodeData): CanvasSocketType {
    if (node.type.startsWith("process:mask-")) return "mask";
    switch (node.type) {
        case CanvasNodeType.Image: return "image";
        case CanvasNodeType.Text: return "text";
        case CanvasNodeType.Video: return "video";
        case CanvasNodeType.Audio: return "audio";
        case CanvasNodeType.Config: return node.metadata?.generationMode || "image";
        case "process:batch": return node.metadata?.outputKind || node.metadata?.batchSettings?.mode || "image";
        case "process:workflow": return node.metadata?.outputKind || "mixed";
        case "production:reference-pack": return "reference";
        case "image-compare:compare":
        case "version-stack:images":
        case "process:alpha-apply":
        case "blender-link:link":
        case "krita-link:link":
        case "krita-link:source": return "image";
        default: {
            const definition = getNodeDefinition(node.type);
            return definition?.resource?.(node)?.kind || definition?.useBuiltinPanel?.mode || "mixed";
        }
    }
}

export function getCanvasInputSocket(node: CanvasNodeData): CanvasInputSocket {
    switch (node.type) {
        case "process:mask-paint":
        case "process:mask-extract":
        case "blender-link:link":
        case "krita-link:link": return { type: "image", multiple: false };
        case "process:mask-invert":
        case "process:mask-grow":
        case "process:mask-feather": return { type: "mask", multiple: false };
        case "image-compare:compare":
        case "production:reference-pack":
        case "production:export-preset":
        case "process:alpha-apply": return { type: "image", multiple: true };
        case CanvasNodeType.Config:
            return { type: node.metadata?.generationMode === "audio" ? "text" : "mixed", multiple: true };
        default: return { type: "mixed", multiple: true };
    }
}

// Reverse drags use the candidate source's type as soon as a source is snapped.
export function getCanvasPreviewType(node: CanvasNodeData, handle: "source" | "target", target?: CanvasNodeData): CanvasSocketType {
    return handle === "source" ? getCanvasOutputType(node) : target ? getCanvasOutputType(target) : getCanvasInputSocket(node).type;
}

export function getCanvasSocketColor(node: CanvasNodeData, handle: "source" | "target", theme: CanvasTheme): string {
    const brand = node.type === "blender-link:link" ? "blender" : node.type === "krita-link:link" ? "krita" : null;
    if (!brand) return theme.socket[handle === "source" ? getCanvasOutputType(node) : getCanvasInputSocket(node).type];

    // Sample the existing 135deg border at the left/right midpoint. The shared CSS phase
    // drives the border, socket and SVG stop together, including newly mounted connections.
    const midpoint = ((handle === "source" ? node.width : 0) + node.height / 2) / (node.width + node.height);
    const position = `((${midpoint} + (var(--canvas-link-scale) - 1) * var(--canvas-link-phase)) / var(--canvas-link-scale))`;
    const stops = [0, 0.28, 0.53, 0.77, 1];
    let color = `var(--${brand}-flow-0)`;
    for (let index = 1; index < stops.length; index++) {
        const weight = `clamp(0%, calc((${position} - ${stops[index - 1]}) * ${100 / (stops[index] - stops[index - 1])}%), 100%)`;
        color = `color-mix(in srgb, ${color}, var(--${brand}-flow-${index}) ${weight})`;
    }
    return color;
}
