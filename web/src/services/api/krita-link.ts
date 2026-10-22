import { createPoll } from "./model-plugin";
import type { KritaGeneration, KritaGenerationRequest, KritaPresetCatalog, KritaSnapshot, KritaSnapshotCheck, KritaStatus } from "@/types/krita-link";

const root = "/krita-link";
const headers = { "X-Infinite-Canvas-Krita-UI": "1" };

async function checked(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await fetch(`${root}${path}`, {
        method: body === undefined ? "GET" : "POST", signal,
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(typeof error?.error === "string" ? error.error : `本机绘画连接请求失败（${response.status}）。`);
    }
    return response;
}

export const getKritaStatus = async (signal?: AbortSignal): Promise<KritaStatus> => (await checked("/status", undefined, signal)).json();
export const getKritaPresets = async (signal?: AbortSignal): Promise<KritaPresetCatalog> => (await checked("/presets", undefined, signal)).json();
export const createKritaSnapshot = async (documentId: string, layerId?: string): Promise<KritaSnapshot> => (await checked("/snapshots", { documentId, ...(layerId ? { layerId } : {}) })).json();
export const checkKritaSnapshot = async (documentId: string, layerId?: string, expectedPixelSha256?: string, signal?: AbortSignal): Promise<KritaSnapshotCheck> => (await checked("/snapshots", { documentId, ...(layerId ? { layerId } : {}), ...(expectedPixelSha256 ? { expectedPixelSha256 } : {}) }, signal)).json();
export type KritaActivity = { sessionId: string; revision: number; changed: boolean } | { standby: true };
export const claimKritaAuto = async (projectId: string, clientId: string, signal?: AbortSignal): Promise<{ leader: boolean; leaseId?: string }> => (await checked(`/auto/claim?${new URLSearchParams({ projectId, clientId })}`, undefined, signal)).json();
export const heartbeatKritaAuto = async (projectId: string, clientId: string, leaseId: string, signal?: AbortSignal): Promise<{ leader: boolean }> => (await checked(`/auto/heartbeat?${new URLSearchParams({ projectId, clientId, leaseId })}`, undefined, signal)).json();
export const releaseKritaAuto = async (projectId: string, clientId: string, leaseId: string): Promise<void> => { await checked("/auto/release", { projectId, clientId, leaseId }); };
export const waitKritaActivity = async (after: number, projectId: string, clientId: string, signal?: AbortSignal): Promise<KritaActivity> => (await checked(`/watch?${new URLSearchParams({ after: String(after), projectId, clientId })}`, undefined, signal)).json();
export const createKritaGeneration = async (request: KritaGenerationRequest): Promise<KritaGeneration> => (await checked("/generations", request)).json();
export const importExternalKritaGeneration = async (snapshotId: string, prompt: string, model: string, images: string[]): Promise<KritaGeneration> => (await checked("/generations/external", { snapshotId, prompt, model, images })).json();
export const getKritaGeneration = async (id: string, signal?: AbortSignal): Promise<KritaGeneration> => (await checked(`/generations/${encodeURIComponent(id)}`, undefined, signal)).json();
export const listKritaGenerations = async (signal?: AbortSignal): Promise<{ generations: KritaGeneration[] }> => (await checked("/generations", undefined, signal)).json();
export const returnKritaImage = async (generationId: string, imageId: string, commandId: string, fitToCanvas = false): Promise<{ commandId: string; layerId: string; documentId: string }> => (await checked("/returns", { generationId, imageId, commandId, fitToCanvas })).json();
// imageBase64 is plain PNG base64; the snapshot binds this write to one Krita document/session.
export type KritaWriteTarget = { writeMode: "insert"; insertAboveLayerId?: string } | { writeMode: "replace"; replaceLayerId: string };
export const returnCanvasImage = async (snapshotId: string, imageBase64: string, commandId: string, fitToCanvas: boolean, target: KritaWriteTarget, options?: { deliveryId?: string; expectedPriorLayerSha256?: string }): Promise<{ commandId: string; layerId: string; documentId: string; layerPixelSha256?: string }> => (await checked("/image-returns", { snapshotId, imageBase64, commandId, fitToCanvas, ...target, ...options })).json();

export async function getKritaImage(url: string, signal?: AbortSignal): Promise<Blob> {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin || !/^\/krita-link\/(snapshots|generations)\//.test(parsed.pathname)) throw new Error("绘画图片地址无效。");
    const response = await fetch(parsed.href, { headers, signal });
    if (!response.ok) throw new Error(`读取绘画原图失败（${response.status}）。`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("本机返回的内容不是图片。");
    return blob;
}

export async function waitKritaGeneration(id: string, signal?: AbortSignal) {
    return createPoll(signal)(() => getKritaGeneration(id, signal), (job) => {
        if (job.status === "failed") throw new Error(job.error || "生成失败，请查看任务记录。");
        if (job.status !== "succeeded") return null;
        if (!job.images?.length) throw new Error("任务完成但没有原图。");
        return job;
    });
}
