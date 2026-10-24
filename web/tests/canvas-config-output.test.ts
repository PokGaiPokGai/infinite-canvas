import assert from "node:assert/strict";
import { after as afterAll, test } from "node:test";
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
        assert.strictEqual(hasCanvasNodeHandle(source, "source"), true);
        assert.deepStrictEqual(normalizeConnection(source.id, target.id, [source, target], "source"), { fromNodeId: source.id, toNodeId: target.id });
        assert.deepStrictEqual(normalizeConnection(source.id, target.id, [source, target], "target"), { fromNodeId: target.id, toNodeId: source.id });
    }
    assert.strictEqual(wouldCreateConnectionCycle(target.id, "source", [edge]), true);
});

test("Config only exposes the selected output for its current mode, never its prompt or an unselected text batch", () => {
    const source = node("source", {
        prompt: "不要作为生成结果传下去", generationMode: "text", content: "data:image/png;base64,aGVsbG8=",
        outputTexts: [{ id: "first", status: "success", content: "第一段" }, { id: "second", status: "success", content: "第二段" }],
        outputVideo: { content: "blob:old-video" },
    });
    assert.strictEqual(getCanvasConfigOutput(source), null);
    assert.deepStrictEqual(buildNodeGenerationInputs(target.id, [source, target], [edge]), []);
    assert.strictEqual(buildNodeGenerationContext(target.id, [source, target], [edge], "继续生成").prompt, "继续生成");

    const selected = { ...source, metadata: { ...source.metadata, selectedOutputTextId: "second", outputText: "第二段" } };
    assert.deepStrictEqual(getCanvasConfigOutput(selected), { kind: "text", content: "第二段" });
    assert.partialDeepStrictEqual(buildNodeGenerationInputs(target.id, [selected, target], [edge]), [{ nodeId: "source", type: "text", text: "第二段" }]);
    assert.ok((buildNodeGenerationContext(target.id, [selected, target], [edge], "继续生成").prompt).includes("第二段"));
    assert.ok(!(buildNodeGenerationContext(target.id, [selected, target], [edge], "继续生成").prompt).includes("不要作为生成结果传下去"));
    const composed = node("target", { generationMode: "text", composerContent: "续写 @[node:source]" });
    assert.ok((buildNodeGenerationContext(composed.id, [selected, composed], [edge], "续写 @[node:source]").prompt).includes("第二段"));

    const video = { ...selected, metadata: { ...selected.metadata, generationMode: "video" as const } };
    assert.deepStrictEqual(getCanvasConfigOutput(video), { kind: "video", content: "blob:old-video" });
    const videoTarget = node("target", { generationMode: "video" });
    assert.strictEqual(buildNodeGenerationInputs(videoTarget.id, [video, videoTarget], [edge])[0]?.type, "video");
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
        assert.strictEqual(isConnectionOperational(edge, source, downstream), true);
        const inputs = buildNodeGenerationInputs(downstream.id, [source, downstream], [edge]);
        assert.strictEqual((inputs).length, 1);
        assert.strictEqual(inputs[0]?.type, item.input);
        const context = buildNodeGenerationContext(downstream.id, [source, downstream], [edge], "继续生成");
        assert.strictEqual((context[item.collection]).length, 1);
        assert.strictEqual(context[item.collection][0]?.storageKey, item.storageKey);
    }
});

test("unsupported Config media paths become dormant and recover when the target mode changes", () => {
    const source = node("source", { generationMode: "video", outputVideo: { content: "blob:video" } });
    assert.strictEqual(isConnectionOperational(edge, source, target), false);
    assert.deepStrictEqual(buildNodeGenerationInputs(target.id, [source, target], [edge]), []);
    const videoTarget = node("target", { generationMode: "video" });
    assert.strictEqual(isConnectionOperational(edge, source, videoTarget), true);
    assert.strictEqual(buildNodeGenerationInputs(videoTarget.id, [source, videoTarget], [edge])[0]?.type, "video");
});
