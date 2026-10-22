import { CanvasNodeType, type CanvasMediaOutput, type CanvasNodeData } from "@/types/canvas";

export type CanvasConfigOutput = ({ kind: "image" | "video" | "audio" } & CanvasMediaOutput) | { kind: "text"; content: string };

export function getCanvasConfigOutput(node: CanvasNodeData): CanvasConfigOutput | null {
    if (node.type !== CanvasNodeType.Config) return null;
    const metadata = node.metadata;
    switch (metadata?.generationMode || "image") {
        case "image":
            return metadata?.content ? { kind: "image", content: metadata.content, storageKey: metadata.storageKey, mimeType: metadata.mimeType, bytes: metadata.bytes, naturalWidth: metadata.naturalWidth, naturalHeight: metadata.naturalHeight } : null;
        case "text":
            return metadata?.outputText?.trim() ? { kind: "text", content: metadata.outputText } : null;
        case "video":
            return metadata?.outputVideo?.content ? { kind: "video", ...metadata.outputVideo } : null;
        case "audio":
            return metadata?.outputAudio?.content ? { kind: "audio", ...metadata.outputAudio } : null;
    }
}
