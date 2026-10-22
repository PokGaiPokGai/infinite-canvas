import { afterAll, expect, test } from "bun:test";
import type { CanvasConnection, CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "zh-CN", setItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { buildNodeGenerationContext } = await import("../src/components/canvas/canvas-node-generation");
const { CanvasNodeType } = await import("../src/types/canvas");
const { hasKritaWriteOutput, isImageInputNode } = await import("../src/lib/canvas/canvas-input-role");
const { registerNodeDefinitions, unregisterPluginNodes } = await import("../src/lib/canvas/node-registry");

const node = (id: string, type: CanvasNodeData["type"] = CanvasNodeType.Image): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    metadata: type === CanvasNodeType.Image ? { content: `data:image/png;base64,${id}` } : {},
});
const nodes = [node("image-a"), node("image-b"), node("config", CanvasNodeType.Config)];

test("role-aware edge order matches image order, labels and run bindings", () => {
    const edges: CanvasConnection[] = [
        { id: "style-edge", fromNodeId: "image-b", toNodeId: "config", order: 1, role: "style", instruction: "只参考笔触" },
        { id: "composition-edge", fromNodeId: "image-a", toNodeId: "config", order: 0, role: "composition" },
    ];
    const context = buildNodeGenerationContext("config", nodes, edges, "生成一张场景图");
    expect(context.referenceImages.map((image) => image.id)).toEqual(["image-a", "image-b"]);
    expect(context.referenceBindings).toEqual([
        { connectionId: "composition-edge", sourceNodeId: "image-a", role: "composition", instruction: undefined, order: 0 },
        { connectionId: "style-edge", sourceNodeId: "image-b", role: "style", instruction: "只参考笔触", order: 1 },
    ]);
    expect(context.prompt).toContain("图片1：构图参考");
    expect(context.prompt).toContain("图片2：风格参考；只参考笔触");

    const withSourceImage = buildNodeGenerationContext("config", nodes, edges, "生成一张场景图", 1);
    expect(withSourceImage.prompt).toContain("图片2：构图参考");
    expect(withSourceImage.prompt).toContain("图片3：风格参考；只参考笔触");
});

test("old unannotated edges preserve their order and prompt, while disabled images are omitted", () => {
    const edges: CanvasConnection[] = [
        { id: "first", fromNodeId: "image-b", toNodeId: "config" },
        { id: "second", fromNodeId: "image-a", toNodeId: "config" },
    ];
    const existing = buildNodeGenerationContext("config", nodes, edges, "生成一张场景图");
    expect(existing.referenceImages.map((image) => image.id)).toEqual(["image-b", "image-a"]);
    expect(existing.prompt).toBe("生成一张场景图");
    expect(existing.referenceBindings.map((binding) => binding.role)).toEqual(["reference", "reference"]);

    const disabled = buildNodeGenerationContext("config", nodes, [{ ...edges[0], enabled: false }, edges[1]], "生成一张场景图");
    expect(disabled.referenceImages.map((image) => image.id)).toEqual(["image-a"]);
    expect(disabled.referenceBindings.map((binding) => binding.connectionId)).toEqual(["second"]);
});

test("composer keeps legacy token selection but includes new role-bearing image edges", () => {
    const composerNodes = [nodes[0], nodes[1], { ...nodes[2], metadata: { composerContent: "已填写" } }];
    const edges: CanvasConnection[] = [
        { id: "legacy", fromNodeId: "image-a", toNodeId: "config" },
        { id: "new", fromNodeId: "image-b", toNodeId: "config", role: "style" },
    ];
    const context = buildNodeGenerationContext("config", composerNodes, edges, "生成一张场景图");
    expect(context.referenceImages.map((image) => image.id)).toEqual(["image-b"]);
    expect(context.prompt).toContain("图片1：风格参考");

    const mentioned = buildNodeGenerationContext("config", composerNodes, edges, "参考 @[node:image-a] 生成一张场景图");
    expect(mentioned.referenceImages.map((image) => image.id)).toEqual(["image-a", "image-b"]);
    expect(mentioned.prompt).toContain("图片2：风格参考");
});

test("reconnecting the same image does not change the role of its first ordered input", () => {
    const edges: CanvasConnection[] = [
        { id: "style", fromNodeId: "image-a", toNodeId: "config", order: 1, role: "style" },
        { id: "composition", fromNodeId: "image-a", toNodeId: "config", order: 0, role: "composition" },
    ];
    const context = buildNodeGenerationContext("config", nodes, edges, "生成一张场景图");
    expect(context.referenceImages.map((image) => image.id)).toEqual(["image-a"]);
    expect(context.referenceBindings[0].connectionId).toBe("composition");
    expect(context.prompt).toContain("图片1：构图参考");
    expect(context.prompt).not.toContain("风格参考");
});

test("a Krita Read connected before capture becomes a Config image reference after capture", () => {
    const pluginId = "test-krita-read-role";
    registerNodeDefinitions([{ type: "krita-link:link", title: "Krita Link", icon: null, defaultSize: { width: 100, height: 100 },
        resource: (source) => source.metadata?.krita?.kind === "link" && source.metadata.content && (source.metadata.krita.mode === "read" || hasKritaWriteOutput(source))
            ? { kind: "image", url: source.metadata.content }
            : null,
    }], pluginId);
    try {
        const read: CanvasNodeData = { ...node("krita-read", "krita-link:link"), metadata: { krita: { kind: "link", mode: "read" } } };
        const config: CanvasNodeData = { ...node("config", CanvasNodeType.Config), metadata: { composerContent: "改绘提示" } };
        const write: CanvasNodeData = { ...node("krita-write", "krita-link:link"), metadata: { krita: { kind: "link", mode: "write" } } };
        const text: CanvasNodeData = { ...node("text", CanvasNodeType.Text), metadata: { krita: { kind: "link", mode: "read" }, content: "不是图像" } };
        expect(isImageInputNode(read)).toBe(true);
        expect(isImageInputNode(write)).toBe(true);
        expect(isImageInputNode(text)).toBe(false);

        const edge: CanvasConnection = { id: "krita-edge", fromNodeId: read.id, toNodeId: config.id, role: isImageInputNode(read) ? "reference" : undefined };
        expect(buildNodeGenerationContext(config.id, [read, config], [edge], "改绘提示").referenceImages).toEqual([]);

        const captured: CanvasNodeData = { ...read, metadata: { ...read.metadata, content: "data:image/png;base64,aGVsbG8=" } };
        const context = buildNodeGenerationContext(config.id, [captured, config], [edge], "改绘提示");
        expect(context.referenceImages.map((image) => image.id)).toEqual([read.id]);
        expect(context.referenceBindings.map((binding) => binding.role)).toEqual(["reference"]);

        // Existing edges created before this fix lack a role; they must also include the captured image.
        const legacy = buildNodeGenerationContext(config.id, [captured, config], [{ ...edge, role: undefined }], "改绘提示");
        expect(legacy.referenceImages.map((image) => image.id)).toEqual([read.id]);
        expect(legacy.referenceBindings.map((binding) => binding.role)).toEqual(["reference"]);

        const pending: CanvasNodeData = { ...write, metadata: { content: "data:image/png;base64,aGVsbG8=", storageKey: "frozen.png", krita: { kind: "link", mode: "write", commandId: "command-1", sourceImage: { nodeId: "image-a", storageKey: "frozen.png", width: 100, height: 100 } } } };
        const writeEdge: CanvasConnection = { id: "write-edge", fromNodeId: write.id, toNodeId: config.id, role: "reference" };
        expect(hasKritaWriteOutput(pending)).toBe(false);
        expect(buildNodeGenerationContext(config.id, [pending, config], [writeEdge], "继续处理").referenceImages).toEqual([]);
        const completed: CanvasNodeData = { ...pending, metadata: { ...pending.metadata, krita: { ...pending.metadata.krita, kind: "link", mode: "write", returnedLayerId: "layer-1", returnedAt: "2026-10-22T00:00:00Z" } } };
        expect(hasKritaWriteOutput(completed)).toBe(true);
        expect(buildNodeGenerationContext(config.id, [completed, config], [writeEdge], "继续处理").referenceImages.map((image) => image.id)).toEqual([write.id]);
        expect(hasKritaWriteOutput({ ...completed, metadata: { ...completed.metadata, storageKey: "different.png" } })).toBe(false);
    } finally {
        unregisterPluginNodes(pluginId);
    }
});

test("generation ignores a retained edge while its source port is unavailable and resumes when it returns", () => {
    const pluginId = "test-conditional-image-port";
    registerNodeDefinitions([{
        type: "test:conditional-image", title: "Conditional Image", icon: null, defaultSize: { width: 100, height: 100 },
        hasSourceHandle: (source) => source.metadata?.generationMode === "image",
        resource: (source) => source.metadata?.content ? { kind: "image", url: source.metadata.content } : null,
    }], pluginId);
    try {
        const source = { ...node("conditional", "test:conditional-image"), metadata: { content: "data:image/png;base64,aGVsbG8=", generationMode: "image" as const } };
        const unavailable = { ...source, metadata: { ...source.metadata, generationMode: "text" as const } };
        const target = node("config", CanvasNodeType.Config);
        const edge: CanvasConnection = { id: "retained", fromNodeId: source.id, toNodeId: target.id, role: "style" };

        expect(buildNodeGenerationContext(target.id, [source, target], [edge], "继续处理").referenceImages.map((image) => image.id)).toEqual([source.id]);
        expect(buildNodeGenerationContext(target.id, [unavailable, target], [edge], "继续处理").referenceImages).toEqual([]);
        expect(buildNodeGenerationContext(target.id, [source, target], [edge], "继续处理").referenceImages.map((image) => image.id)).toEqual([source.id]);
        expect(edge.enabled).toBeUndefined();
    } finally {
        unregisterPluginNodes(pluginId);
    }
});
