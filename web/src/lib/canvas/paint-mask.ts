// Drawing geometry adapted from Suavis Notes (MIT); see web/THIRD_PARTY_NOTICES.md.
import { getStrokePoints } from "perfect-freehand";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { MaskPoint, MaskStroke, PaintMaskDrawing } from "@/types/paint-mask";
import type { ProductionImage } from "@/types/canvas-production";

export const MASK_PAINT = "process:mask-paint";
export const DEFAULT_MASK_PREVIEW_COLOR = "#323b4a";
export const DRAW_WEIGHTS = [3, 8, 18, 34] as const;
export const paintMaskSourceKey = (source: ProductionImage) => JSON.stringify([source.storageKey || source.content, source.naturalWidth, source.naturalHeight]);
export function getPaintMaskSource(node: CanvasNodeData, inputs = node.metadata?.productionInputs || []) {
    return inputs.length === 1 ? inputs[0] : undefined;
}
export function paintMaskMatches(drawing: PaintMaskDrawing | undefined, source: ProductionImage | undefined) {
    return !!drawing && !!source?.content && drawing.sourceId === source.id && drawing.sourceKey === paintMaskSourceKey(source);
}
export function resolvePaintMask(node: CanvasNodeData, inputs: ProductionImage[], empty: CanvasNodeMetadata): CanvasNodeData {
    const valid = paintMaskMatches(node.metadata?.paintMask, getPaintMaskSource(node, inputs));
    const output = node.metadata?.paintMask?.output;
    return { ...node, metadata: { ...node.metadata, ...(valid && output ? { ...output, status: "success" as const, outputKind: "image" as const } : {}), ...(!valid ? empty : {}), productionInputs: inputs } };
}
export function remapPaintMaskSources(metadata: CanvasNodeMetadata, ids: Map<string, string>): Partial<CanvasNodeMetadata> {
    return {
        ...(metadata.paintMask ? { paintMask: { ...metadata.paintMask, sourceId: ids.get(metadata.paintMask.sourceId) || metadata.paintMask.sourceId } } : {}),
    };
}

export function maskStrokeSegments(stroke: MaskStroke): { path: string; width: number }[] {
    if (!stroke.points.length) return [];
    const pressure = stroke.points.some(point => point.p != null);
    if (!pressure) {
        const points = stroke.points, first = points[0], last = points[points.length - 1];
        let path = `M ${first.x} ${first.y}`;
        for (let i = 1; i < points.length - 1; i++) {
            const point = points[i], next = points[i + 1];
            path += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`;
        }
        return [{ path: `${path} L ${last.x} ${last.y}`, width: stroke.width }];
    }
    const points = getStrokePoints(stroke.points.map(point => [point.x, point.y, point.p ?? 0.5]), { size: stroke.width, streamline: 0.08, last: true });
    return points.map((point, index) => {
        const previous = points[Math.max(0, index - 1)];
        const p = Math.max(0, Math.min(1, (point.pressure + previous.pressure) / 2));
        return { path: `M ${previous.point[0]} ${previous.point[1]} L ${point.point[0]} ${point.point[1]}`, width: stroke.width * (0.55 + 0.9 * p) };
    });
}
export function maskStrokeBounds(stroke: MaskStroke) {
    const pad = stroke.width * (stroke.points.some(point => point.p != null) ? 0.75 : 0.5);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const point of stroke.points) {
        left = Math.min(left, point.x); top = Math.min(top, point.y);
        right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
    }
    return { x: left - pad, y: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 };
}
/** Segment hit testing also catches quick eraser gestures crossing thin strokes. */
export function maskStrokeTouches(stroke: MaskStroke, a: MaskPoint, b: MaskPoint, radius = 8): boolean {
    const distance = (point: MaskPoint, u: MaskPoint, v: MaskPoint) => {
        const dx = v.x - u.x, dy = v.y - u.y;
        const t = Math.max(0, Math.min(1, ((point.x - u.x) * dx + (point.y - u.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(point.x - u.x - t * dx, point.y - u.y - t * dy);
    };
    const cross = (p: MaskPoint, q: MaskPoint, r: MaskPoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return stroke.points.some((p, i, points) => {
        const q = points[Math.max(0, i - 1)];
        const intersects = cross(a, b, p) * cross(a, b, q) < 0 && cross(p, q, a) * cross(p, q, b) < 0;
        return intersects || Math.min(distance(p, a, b), distance(q, a, b), distance(a, p, q), distance(b, p, q)) <= radius + stroke.width / 2;
    });
}
export function paintMaskSvg(drawing: PaintMaskDrawing): string {
    // Native round strokes cover their intersections. Filled freehand outlines can
    // self-intersect and leave winding-rule holes during fast backtracking.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.width}" height="${drawing.height}" viewBox="0 0 ${drawing.width} ${drawing.height}"><rect width="100%" height="100%" fill="black"/><g fill="none" stroke="white" stroke-linecap="round" stroke-linejoin="round">${drawing.strokes.flatMap(maskStrokeSegments).map(segment => `<path d="${segment.path}" stroke-width="${segment.width}"/>`).join("")}</g></svg>`;
}
export async function paintMaskPng(drawing: PaintMaskDrawing, signal: AbortSignal) {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(paintMaskSvg(drawing))}`;
    await image.decode();
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = drawing.width; canvas.height = drawing.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建蒙版画布。");
    context.drawImage(image, 0, 0);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("蒙版编码失败。")), "image/png"));
}
