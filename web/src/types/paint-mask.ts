import type { CanvasMediaOutput } from "./canvas";

export type MaskPoint = { x: number; y: number; p?: number };
export type MaskStroke = { id: string; width: number; points: MaskPoint[] };
export type PaintMaskDrawing = {
    sourceId: string;
    sourceKey: string;
    width: number;
    height: number;
    strokes: MaskStroke[];
    output?: CanvasMediaOutput;
};
