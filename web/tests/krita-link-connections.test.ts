import assert from "node:assert/strict";
import { after as afterAll, test } from "node:test";
import type { CanvasConnection, CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "zh-CN", setItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { normalizeConnection, wouldCreateConnectionCycle } = await import("../src/lib/canvas/canvas-node-geometry");
const { hasCanvasNodeHandle, isConnectionOperational } = await import("../src/lib/canvas/canvas-connection-state");
const { registerNodeDefinitions, unregisterPluginNodes } = await import("../src/lib/canvas/node-registry");
const { CanvasNodeType } = await import("../src/types/canvas");

const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 240, metadata,
});

test("Krita Link write mode accepts an image and exposes an image output", () => {
    const nodes = [
        node("read", "krita-link:link", { krita: { kind: "link", mode: "read" } }),
        node("write", "krita-link:link", { krita: { kind: "link", mode: "write" } }),
        node("write-next", "krita-link:link", { krita: { kind: "link", mode: "write" } }),
        node("image", CanvasNodeType.Image),
        node("text", CanvasNodeType.Text),
        node("config", CanvasNodeType.Config),
    ];
    assert.deepStrictEqual(normalizeConnection("read", "config", nodes, "source"), { fromNodeId: "read", toNodeId: "config" });
    assert.deepStrictEqual(normalizeConnection("image", "write", nodes, "source"), { fromNodeId: "image", toNodeId: "write" });
    assert.deepStrictEqual(normalizeConnection("write", "config", nodes, "source"), { fromNodeId: "write", toNodeId: "config" });
    assert.deepStrictEqual(normalizeConnection("write", "write-next", nodes, "source"), { fromNodeId: "write", toNodeId: "write-next" });
    assert.strictEqual(normalizeConnection("image", "read", nodes, "source"), null);
    assert.strictEqual(normalizeConnection("text", "write", nodes, "source"), null);
    assert.deepStrictEqual(normalizeConnection("read", "write", nodes, "source"), { fromNodeId: "read", toNodeId: "write" });
    assert.strictEqual(wouldCreateConnectionCycle("write", "config", [{ id: "existing", fromNodeId: "config", toNodeId: "write" }]), true);
    assert.strictEqual(wouldCreateConnectionCycle("write", "config", [{ id: "disabled", fromNodeId: "config", toNodeId: "write", enabled: false }]), true);
});

test("Krita Link preserves a dormant input edge and restores it after switching back to write", () => {
    const pluginId = "test-krita-connection-ports";
    registerNodeDefinitions([{
        type: "krita-link:link", title: "Krita Link", icon: null, defaultSize: { width: 320, height: 240 },
        hasSourceHandle: (item) => item.metadata?.krita?.kind === "link",
        hasTargetHandle: (item) => item.metadata?.krita?.kind === "link" && item.metadata.krita.mode === "write",
    }], pluginId);
    try {
        const image = node("image", CanvasNodeType.Image);
        const read = node("link", "krita-link:link", { krita: { kind: "link", mode: "read" } });
        const write = node("link", "krita-link:link", { krita: { kind: "link", mode: "write" } });
        const edge: CanvasConnection = { id: "preserved", fromNodeId: image.id, toNodeId: read.id, role: "style", instruction: "只参考笔触" };
        const savedEdge = { ...edge };

        assert.strictEqual(hasCanvasNodeHandle(read, "source"), true);
        assert.strictEqual(hasCanvasNodeHandle(read, "target"), false);
        assert.strictEqual(hasCanvasNodeHandle(write, "source"), true);
        assert.strictEqual(hasCanvasNodeHandle(write, "target"), true);
        assert.strictEqual(isConnectionOperational(edge, image, read), false);
        assert.strictEqual(isConnectionOperational(edge, image, write), true);
        assert.deepStrictEqual(edge, savedEdge);
        assert.strictEqual(isConnectionOperational({ ...edge, enabled: false }, image, write), false);

        // A dormant edge still reserves its place in the possible graph: restoring the port must not create a cycle.
        assert.strictEqual(wouldCreateConnectionCycle(read.id, image.id, [edge]), true);
    } finally {
        unregisterPluginNodes(pluginId);
    }
});

test("Config keeps its output port while non-image output makes a retained Krita Write edge dormant", () => {
    const pluginId = "test-krita-config-port";
    registerNodeDefinitions([{
        type: "krita-link:link", title: "Krita Link", icon: null, defaultSize: { width: 320, height: 240 },
        hasSourceHandle: () => true, hasTargetHandle: (item) => item.metadata?.krita?.kind === "link" && item.metadata.krita.mode === "write",
    }], pluginId);
    try {
        const configImage = node("config", CanvasNodeType.Config, { generationMode: "image" });
        const configText = node("config", CanvasNodeType.Config, { generationMode: "text" });
        const write = node("write", "krita-link:link", { krita: { kind: "link", mode: "write" } });
        const edge: CanvasConnection = { id: "config-output", fromNodeId: configImage.id, toNodeId: write.id };

        assert.strictEqual(hasCanvasNodeHandle(configImage, "source"), true);
        assert.strictEqual(hasCanvasNodeHandle(configText, "source"), true);
        assert.deepStrictEqual(normalizeConnection(configImage.id, write.id, [configImage, write], "source"), { fromNodeId: configImage.id, toNodeId: write.id });
        assert.strictEqual(normalizeConnection(configText.id, write.id, [configText, write], "source"), null);
        assert.strictEqual(isConnectionOperational(edge, configImage, write), true);
        assert.strictEqual(isConnectionOperational(edge, configText, write), false);
        assert.strictEqual(isConnectionOperational(edge, configImage, write), true);
        assert.strictEqual(edge.enabled, undefined);
    } finally {
        unregisterPluginNodes(pluginId);
    }
});
