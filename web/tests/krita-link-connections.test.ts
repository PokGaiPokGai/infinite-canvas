import { afterAll, expect, test } from "bun:test";
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
    expect(normalizeConnection("read", "config", nodes, "source")).toEqual({ fromNodeId: "read", toNodeId: "config" });
    expect(normalizeConnection("image", "write", nodes, "source")).toEqual({ fromNodeId: "image", toNodeId: "write" });
    expect(normalizeConnection("write", "config", nodes, "source")).toEqual({ fromNodeId: "write", toNodeId: "config" });
    expect(normalizeConnection("write", "write-next", nodes, "source")).toEqual({ fromNodeId: "write", toNodeId: "write-next" });
    expect(normalizeConnection("image", "read", nodes, "source")).toBeNull();
    expect(normalizeConnection("text", "write", nodes, "source")).toBeNull();
    expect(normalizeConnection("read", "write", nodes, "source")).toEqual({ fromNodeId: "read", toNodeId: "write" });
    expect(wouldCreateConnectionCycle("write", "config", [{ id: "existing", fromNodeId: "config", toNodeId: "write" }])).toBe(true);
    expect(wouldCreateConnectionCycle("write", "config", [{ id: "disabled", fromNodeId: "config", toNodeId: "write", enabled: false }])).toBe(true);
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

        expect(hasCanvasNodeHandle(read, "source")).toBe(true);
        expect(hasCanvasNodeHandle(read, "target")).toBe(false);
        expect(hasCanvasNodeHandle(write, "source")).toBe(true);
        expect(hasCanvasNodeHandle(write, "target")).toBe(true);
        expect(isConnectionOperational(edge, image, read)).toBe(false);
        expect(isConnectionOperational(edge, image, write)).toBe(true);
        expect(edge).toEqual(savedEdge);
        expect(isConnectionOperational({ ...edge, enabled: false }, image, write)).toBe(false);

        // A dormant edge still reserves its place in the possible graph: restoring the port must not create a cycle.
        expect(wouldCreateConnectionCycle(read.id, image.id, [edge])).toBe(true);
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

        expect(hasCanvasNodeHandle(configImage, "source")).toBe(true);
        expect(hasCanvasNodeHandle(configText, "source")).toBe(true);
        expect(normalizeConnection(configImage.id, write.id, [configImage, write], "source")).toEqual({ fromNodeId: configImage.id, toNodeId: write.id });
        expect(normalizeConnection(configText.id, write.id, [configText, write], "source")).toBeNull();
        expect(isConnectionOperational(edge, configImage, write)).toBe(true);
        expect(isConnectionOperational(edge, configText, write)).toBe(false);
        expect(isConnectionOperational(edge, configImage, write)).toBe(true);
        expect(edge.enabled).toBeUndefined();
    } finally {
        unregisterPluginNodes(pluginId);
    }
});
