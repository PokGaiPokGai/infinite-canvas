import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export function hasCanvasNodeHandle(node: CanvasNodeData, handle: "source" | "target") {
    if (handle === "target" && node.type === CanvasNodeType.Group) return false;
    if (handle === "source" && node.type === CanvasNodeType.Config) return true;
    const definition = getNodeDefinition(node.type);
    const available = handle === "source" ? definition?.hasSourceHandle : definition?.hasTargetHandle;
    return typeof available === "function" ? available(node) : available ?? true;
}

export function connectionUnavailableReason(connection: CanvasConnection, from?: CanvasNodeData, to?: CanvasNodeData) {
    if (connection.enabled === false) return "这条连线已停用";
    if (!from || !to) return "连接的节点不存在";
    if (!hasCanvasNodeHandle(from, "source")) return "源节点当前没有输出接口";
    if (!hasCanvasNodeHandle(to, "target")) return "目标节点当前没有输入接口";
    if (from.type === CanvasNodeType.Config && to.type === "krita-link:link" && (from.metadata?.generationMode || "image") !== "image") return "Krita 写回仅接受图像输出";
    if (from.type === CanvasNodeType.Config && to.type === "blender-link:link" && (from.metadata?.generationMode || "image") !== "image") return "Blender 写回仅接受图像输出";
    if (from.type === CanvasNodeType.Config && to.type === CanvasNodeType.Config) {
        const sourceMode = from.metadata?.generationMode || "image";
        const targetMode = to.metadata?.generationMode || "image";
        if ((sourceMode === "video" || sourceMode === "audio") && targetMode !== "video") return "当前生成模式无法使用此媒体输入";
        if (sourceMode === "image" && targetMode === "audio") return "音频生成当前仅使用文字输入";
    }
    return null;
}

export function isConnectionOperational(connection: CanvasConnection, from?: CanvasNodeData, to?: CanvasNodeData) {
    return connectionUnavailableReason(connection, from, to) === null;
}
