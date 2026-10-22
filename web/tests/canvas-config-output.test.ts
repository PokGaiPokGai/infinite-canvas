import { afterAll, expect, test } from "bun:test";
import type { CanvasConnection, CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "zh-CN", setItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { CanvasNodeType } = await import("../src/types/canvas");
const { getCanvasConfigOutput } = await import("../src/lib/canvas/canvas-config-output");
const { hasCanvasNodeHandle, isConnectionOperational } = await import("../src/lib/canvas/canvas-connection-state");
const { normalizeConnection, wouldCreateConnectionCycle } = await import("../src/lib/canvas/canvas-node-geometry");
const { buildNodeGenerationContext, buildNodeGenerationInputs } = await import("../src/components/canvas/canvas-node-generation");

const node = (id: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type: CanvasNodeType.Config, title: id, position: { x: 0, y: 0 }, width: 320, height: 240, metadata,
});
const edge: CanvasConnection = { id: "config-chain", fromNodeId: "source", toNodeId: "target" };
const target = node("target", { generationMode: "text", prompt: "目标提示词" });

test("Config output stays available in every mode and Config-to-Config direction follows the dragged handle", () => {
    for (const generationMode of ["image", "text", "video", "audio"] as const) {
        const source = node("source", { generationMode });
        expect(hasCanvasNodeHandle(source, "source")).toBe(true);
        expect(normalizeConnection(source.id, target.id, [source, target], "source")).toEqual({ fromNodeId: source.id, toNodeId: target.id });
        expect(normalizeConnection(source.id, target.id, [source, target], "target")).toEqual({ fromNodeId: target.id, toNodeId: source.id });
    }
    expect(wouldCreateConnectionCycle(target.id, "source", [edge])).toBe(true);
});

test("Config only exposes the selected output for its current mode, never its prompt or an unselected text batch", () => {
    const source = node("source", {
        prompt: "不要作为生成结果传下去", generationMode: "text", content: "data:image/png;base64,aGVsbG8=",
        outputTexts: [{ id: "first", status: "success", content: "第一段" }, { id: "second", status: "success", content: "第二段" }],
        outputVideo: { content: "blob:old-video" },
    });
    expect(getCanvasConfigOutput(source)).toBeNull();
    expect(buildNodeGenerationInputs(target.id, [source, target], [edge])).toEqual([]);
    expect(buildNodeGenerationContext(target.id, [source, target], [edge], "继续生成").prompt).toBe("继续生成");

    const selected = { ...source, metadata: { ...source.metadata, selectedOutputTextId: "second", outputText: "第二段" } };
    expect(getCanvasConfigOutput(selected)).toEqual({ kind: "text", content: "第二段" });
    expect(buildNodeGenerationInputs(target.id, [selected, target], [edge])).toMatchObject([{ nodeId: "source", type: "text", text: "第二段" }]);
    expect(buildNodeGenerationContext(target.id, [selected, target], [edge], "继续生成").prompt).toContain("第二段");
    expect(buildNodeGenerationContext(target.id, [selected, target], [edge], "继续生成").prompt).not.toContain("不要作为生成结果传下去");
    const composed = node("target", { generationMode: "text", composerContent: "续写 @[node:source]" });
    expect(buildNodeGenerationContext(composed.id, [selected, composed], [edge], "续写 @[node:source]").prompt).toContain("第二段");

    const video = { ...selected, metadata: { ...selected.metadata, generationMode: "video" as const } };
    expect(getCanvasConfigOutput(video)).toEqual({ kind: "video", content: "blob:old-video" });
    const videoTarget = node("target", { generationMode: "video" });
    expect(buildNodeGenerationInputs(videoTarget.id, [video, videoTarget], [edge])[0]?.type).toBe("video");
});

test("Config image, video and audio outputs become typed downstream references", () => {
    const cases = [
        { mode: "image", targetMode: "text", metadata: { content: "data:image/png;base64,aGVsbG8=", storageKey: "image.png", mimeType: "image/png" }, input: "image", collection: "referenceImages", storageKey: "image.png" },
        { mode: "video", targetMode: "video", metadata: { outputVideo: { content: "blob:video", storageKey: "video.mp4", mimeType: "video/mp4", durationMs: 1200 } }, input: "video", collection: "referenceVideos", storageKey: "video.mp4" },
        { mode: "audio", targetMode: "video", metadata: { outputAudio: { content: "blob:audio", storageKey: "audio.mp3", mimeType: "audio/mpeg", durationMs: 900 } }, input: "audio", collection: "referenceAudios", storageKey: "audio.mp3" },
    ] as const;
    for (const item of cases) {
        const source = node("source", { generationMode: item.mode, ...item.metadata });
        const downstream = node("target", { generationMode: item.targetMode });
        expect(isConnectionOperational(edge, source, downstream)).toBe(true);
        const inputs = buildNodeGenerationInputs(downstream.id, [source, downstream], [edge]);
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.type).toBe(item.input);
        const context = buildNodeGenerationContext(downstream.id, [source, downstream], [edge], "继续生成");
        expect(context[item.collection]).toHaveLength(1);
        expect(context[item.collection][0]?.storageKey).toBe(item.storageKey);
    }
});

test("unsupported Config media paths become dormant and recover when the target mode changes", () => {
    const source = node("source", { generationMode: "video", outputVideo: { content: "blob:video" } });
    expect(isConnectionOperational(edge, source, target)).toBe(false);
    expect(buildNodeGenerationInputs(target.id, [source, target], [edge])).toEqual([]);
    const videoTarget = node("target", { generationMode: "video" });
    expect(isConnectionOperational(edge, source, videoTarget)).toBe(true);
    expect(buildNodeGenerationInputs(videoTarget.id, [source, videoTarget], [edge])[0]?.type).toBe("video");
});
