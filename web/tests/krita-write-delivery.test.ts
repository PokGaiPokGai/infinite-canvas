import assert from "node:assert/strict";
import { after as afterAll, test } from "node:test";
import type { CanvasConnection, CanvasNodeData, CanvasNodeImage } from "../src/types/canvas";
import type { KritaSnapshot } from "../src/types/krita-link";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "zh-CN", setItem: () => {} } });

const { CanvasNodeType } = await import("../src/types/canvas");
const { registerNodeDefinitions, unregisterPluginNodes } = await import("../src/lib/canvas/node-registry");
const { getKritaWriteDelivery, isAutoReadDelivery } = await import("../src/lib/canvas/krita-write-delivery");
const pluginId = "test-krita-write-delivery";
registerNodeDefinitions([
    { type: "krita-link:link", title: "Krita Link", icon: null, defaultSize: { width: 100, height: 100 },
        hasSourceHandle: () => true, hasTargetHandle: (node) => node.metadata?.krita?.kind === "link" && node.metadata.krita.mode === "write" },
    { type: "krita-link:source", title: "Krita Source", icon: null, defaultSize: { width: 100, height: 100 }, hasSourceHandle: () => true },
], pluginId);
afterAll(() => {
    unregisterPluginNodes(pluginId);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata,
});
const write = node("write", "krita-link:link", { krita: { kind: "link", mode: "write" } });
const edge = (id: string, source: CanvasNodeData, target = write): CanvasConnection => ({ id, fromNodeId: source.id, toNodeId: target.id });
const image = (id: string, storageKey = `image:${id}`) => node(id, CanvasNodeType.Image, { content: `/media/${id}`, storageKey, status: "success" });
const snapshot: KritaSnapshot = {
    id: "snapshot", sessionId: "session", documentId: "document", documentName: "Painting", width: 32, height: 16,
    colorModel: "RGBA", colorDepth: "U8", colorProfile: "sRGB", sha256: "sha", createdAt: "2026-10-22", imageUrl: "/snapshot.png",
};
const generated = (id: string, status: CanvasNodeImage["status"] = "success"): CanvasNodeImage => ({
    id, status, content: `/media/${id}`, storageKey: `image:${id}`, naturalWidth: 32, naturalHeight: 16, bytes: 1, mimeType: "image/png",
});

test("only one operational inbound image connection can deliver, and its key tracks the connection and image version", () => {
    const first = image("first");
    const second = image("second");
    const nodes = [write, first, second];
    const firstEdge = edge("edge-a", first);
    assert.partialDeepStrictEqual(getKritaWriteDelivery(write, nodes, [firstEdge]), { connectionId: "edge-a", sourceNode: first, storageKey: "image:first", key: "edge-a:image:first" });
    assert.strictEqual(getKritaWriteDelivery(write, nodes, [firstEdge, edge("edge-b", second)]), null);
    assert.strictEqual(getKritaWriteDelivery(write, nodes, [firstEdge, { ...edge("edge-b", second), enabled: false }])?.key, "edge-a:image:first");
    assert.strictEqual(getKritaWriteDelivery(write, nodes, [{ ...firstEdge, enabled: false }]), null);
    assert.strictEqual(getKritaWriteDelivery(write, nodes, [edge("edge-c", first)])?.key, "edge-c:image:first");
    assert.strictEqual(getKritaWriteDelivery(write, [write, image("first", "image:new")], [firstEdge])?.key, "edge-a:image:new");
    assert.strictEqual(getKritaWriteDelivery(write, [write, node("first", CanvasNodeType.Image, { status: "loading", content: "/old", storageKey: "image:old" })], [firstEdge]), null);
});

test("Config delivers only a selected, successful output from its current completed batch", () => {
    const old = generated("old");
    const current = generated("current");
    const config = node("config", CanvasNodeType.Config, { generationMode: "image", status: "success", outputImages: [current], selectedOutputImageId: current.id, content: current.content, storageKey: current.storageKey });
    const connection = edge("config-edge", config);
    assert.strictEqual(getKritaWriteDelivery(write, [write, config], [connection])?.key, "config-edge:image:current");
    assert.strictEqual(getKritaWriteDelivery(write, [write, { ...config, metadata: { ...config.metadata, status: "loading" } }], [connection]), null);
    assert.strictEqual(getKritaWriteDelivery(write, [write, { ...config, metadata: { ...config.metadata, selectedOutputImageId: old.id, content: old.content, storageKey: old.storageKey } }], [connection]), null);
    assert.strictEqual(getKritaWriteDelivery(write, [write, { ...config, metadata: { ...config.metadata, outputImages: [generated("current", "loading")] } }], [connection]), null);
    assert.strictEqual(getKritaWriteDelivery(write, [write, { ...config, metadata: { ...config.metadata, selectedOutputImageId: undefined } }], [connection]), null);
    assert.strictEqual(getKritaWriteDelivery(write, [write, { ...config, metadata: { ...config.metadata, generationMode: "text" } }], [connection]), null);
});

test("Krita Read identifies Auto snapshots, while manual reads remain eligible for the caller to deliver", () => {
    const manual = node("read", "krita-link:link", { content: "/read.png", storageKey: "image:manual", krita: { kind: "link", mode: "read", snapshot, lastReadKind: "manual" } });
    const automatic = node("read", "krita-link:link", { content: "/read.png", storageKey: "image:auto", krita: { kind: "link", mode: "read", snapshot, lastReadKind: "auto" } });
    const connection = edge("read-edge", manual);
    const manualDelivery = getKritaWriteDelivery(write, [write, manual], [connection]);
    const autoDelivery = getKritaWriteDelivery(write, [write, automatic], [connection]);
    assert.strictEqual(manualDelivery?.key, "read-edge:image:manual");
    assert.strictEqual(manualDelivery && isAutoReadDelivery(manualDelivery), false);
    assert.strictEqual(autoDelivery?.key, "read-edge:image:auto");
    assert.strictEqual(autoDelivery && isAutoReadDelivery(autoDelivery), true);
    assert.strictEqual(getKritaWriteDelivery(write, [write, { ...manual, metadata: { ...manual.metadata, krita: { kind: "link", mode: "read" } } }], [connection]), null);
});

test("upstream Krita Write delivers only a completed write result", () => {
    const result = node("prior-write", "krita-link:link", { status: "success", content: "/returned.png", storageKey: "image:returned", krita: {
        kind: "link", mode: "write", commandId: "command", sourceImage: { nodeId: "original", storageKey: "image:returned", width: 32, height: 16 }, returnedLayerId: "layer", returnedAt: "2026-10-22",
    } });
    const connection = edge("prior-edge", result);
    assert.strictEqual(getKritaWriteDelivery(write, [write, result], [connection])?.key, "prior-edge:image:returned");
    assert.strictEqual(getKritaWriteDelivery(write, [write, { ...result, metadata: { ...result.metadata, krita: { kind: "link", mode: "write", commandId: "pending" } } }], [connection]), null);
    assert.strictEqual(getKritaWriteDelivery(write, [write, { ...result, metadata: { ...result.metadata, status: "error" } }], [connection]), null);
});
