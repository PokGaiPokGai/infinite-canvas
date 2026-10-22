import { createKritaGeneration, getKritaImage, importExternalKritaGeneration, waitKritaGeneration } from "@/services/api/krita-link";
import { uploadImage } from "@/services/image-storage";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { KritaGeneration, KritaGenerationRequest, KritaPresetMetadata, KritaSnapshot } from "@/types/krita-link";

export const KRITA_SOURCE = "krita-link:source";
export const KRITA_PRESET = "krita-link:preset";
const submitting = new Set<string>();
const waiting = new Map<string, { jobId: string; controller: AbortController }>();

export function patchKritaPreset(ctx: CanvasNodeContext, patch: Partial<KritaPresetMetadata>, status?: "idle" | "loading" | "success" | "error", errorDetails?: string) {
    const current = ctx.getNode(ctx.node.id)?.metadata?.krita;
    if (current?.kind !== "preset") return;
    ctx.updateMetadata({ krita: { ...current, ...patch }, ...(status ? { status, errorDetails } : {}) });
}

export async function importKritaResults(ctx: CanvasNodeContext, job: KritaGeneration) {
    if (!ctx.getNode(ctx.node.id)) return;
    for (const image of job.images) {
        if (ctx.getNodes().some((node) => node.metadata?.krita?.kind === "result" && node.metadata.krita.generationId === job.id && node.metadata.krita.imageId === image.id)) continue;
        const stored = await uploadImage(await getKritaImage(image.url));
        if (!ctx.getNode(ctx.node.id)) return;
        if (ctx.getNodes().some((node) => node.metadata?.krita?.kind === "result" && node.metadata.krita.generationId === job.id && node.metadata.krita.imageId === image.id)) continue;
        const ratio = stored.width / stored.height;
        const width = ratio >= 1 ? 320 : 320 * ratio;
        const height = ratio >= 1 ? 320 / ratio : 320;
        const previous = ctx.getNodes().filter((node) => node.metadata?.krita?.kind === "result" && node.metadata.krita.generatorNodeId === ctx.node.id);
        const y = Math.max(ctx.node.position.y, ...previous.map((node) => node.position.y + node.height + 40));
        const id = `image-${crypto.randomUUID()}`;
        ctx.applyOps([
            { type: "add_node", id, nodeType: CanvasNodeType.Image, title: `Krita 结果 · ${job.request.backend === "configured" ? "配置渠道" : job.request.presetId === "detail" ? "细化" : "草稿"}`, x: ctx.node.position.x + ctx.node.width + 80, y, width, height,
                metadata: { ...imageMetadata(stored), prompt: job.request.prompt, krita: { kind: "result", generationId: job.id, imageId: image.id, imageWidth: image.width, imageHeight: image.height, snapshotId: job.snapshotId, generatorNodeId: ctx.node.id, request: job.request } } },
            { type: "connect_nodes", fromNodeId: ctx.node.id, toNodeId: id },
        ]);
    }
}

export async function followKritaGeneration(ctx: CanvasNodeContext, id: string) {
    if (waiting.has(ctx.node.id)) return;
    const controller = new AbortController();
    waiting.set(ctx.node.id, { jobId: id, controller });
    patchKritaPreset(ctx, { generationId: id }, "loading");
    try {
        const job = await waitKritaGeneration(id, controller.signal);
        await importKritaResults(ctx, job);
        patchKritaPreset(ctx, {}, "success");
    } catch (error) {
        patchKritaPreset(ctx, {}, controller.signal.aborted ? "idle" : "error", controller.signal.aborted ? "已停止等待；后台任务可能继续，请刷新任务记录查看。" : `${error instanceof Error ? error.message : "等待失败"} 可刷新任务记录查看，未自动重新生成。`);
    } finally {
        waiting.delete(ctx.node.id);
    }
}

export function stopKritaWaiting(nodeId: string) { waiting.get(nodeId)?.controller.abort(); }
export function isKritaNodeBusy(nodeId: string) { return submitting.has(nodeId) || waiting.has(nodeId); }

export async function submitKritaGeneration(ctx: CanvasNodeContext, request: KritaGenerationRequest) {
    if (submitting.has(ctx.node.id) || waiting.has(ctx.node.id)) return;
    submitting.add(ctx.node.id);
    patchKritaPreset(ctx, {}, "loading");
    try {
        const job = await createKritaGeneration(request);
        if (!job.id) throw new Error("服务未返回任务编号，请刷新任务记录确认是否已提交。");
        await followKritaGeneration(ctx, job.id);
    } catch (error) {
        patchKritaPreset(ctx, {}, "error", `${error instanceof Error ? error.message : "提交未确认"} 请先刷新任务记录，避免重复提交。`);
    } finally {
        submitting.delete(ctx.node.id);
    }
}

function blobDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取生成图片失败。"));
        reader.readAsDataURL(blob);
    });
}

async function asPng(dataUrl: string) {
    if (/^data:image\/png;base64,/.test(dataUrl)) return dataUrl;
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法保存 PNG 原图。");
        context.drawImage(bitmap, 0, 0);
        return canvas.toDataURL("image/png");
    } finally { bitmap.close(); }
}

export async function submitConfiguredKritaGeneration(ctx: CanvasNodeContext, snapshot: KritaSnapshot, prompt: string, model: string) {
    if (isKritaNodeBusy(ctx.node.id)) return;
    submitting.add(ctx.node.id);
    patchKritaPreset(ctx, {}, "loading");
    try {
        const reference = await blobDataUrl(await getKritaImage(snapshot.imageUrl));
        const result = await ctx.ai.generateImage(prompt, { model, references: [reference], count: 1, size: `${snapshot.width}x${snapshot.height}` });
        const images = await Promise.all(result.images.map(asPng));
        const job = await importExternalKritaGeneration(snapshot.id, prompt, model, images);
        patchKritaPreset(ctx, { generationId: job.id });
        await importKritaResults(ctx, job);
        patchKritaPreset(ctx, {}, "success");
    } catch (error) {
        patchKritaPreset(ctx, {}, "error", `${error instanceof Error ? error.message : "配置渠道生成失败"} 未自动重试；先检查渠道和任务记录，避免重复生成。`);
    } finally { submitting.delete(ctx.node.id); }
}
