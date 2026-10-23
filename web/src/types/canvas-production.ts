import type { CanvasMediaOutput } from "./canvas";

export type ProductionImage = Partial<CanvasMediaOutput> & { id: string; title: string; status?: string };
export type ReferencePack = { assetId?: string; name: string; kind: "style" | "character"; rules: string; version: number; images: ProductionImage[] };
export type ExportPreset = { name: string; width: number; height: number; format: "png" | "webp" | "jpeg"; fit: "contain" | "cover"; transparent: boolean; background: string; pattern: string; directory: string; metadata: boolean };
