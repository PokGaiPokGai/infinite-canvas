import { nanoid } from "nanoid";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { ProcessResult } from "@/types/canvas-workflow";

export function placeProcessResults(ctx: CanvasNodeContext, results: ProcessResult[]) {
    ctx.applyOps(results.map((result, index) => ({ type: "add_node" as const, id: nanoid(), nodeType: result.kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Text, title: result.title, position: { x: ctx.node.position.x + ctx.node.width + 60 + index % 3 * 350, y: ctx.node.position.y + Math.floor(index / 3) * 310 }, width: 320, height: result.kind === "image" && result.naturalWidth && result.naturalHeight ? 320 * result.naturalHeight / result.naturalWidth : 250, metadata: { ...result, status: "success" as const } })));
}
