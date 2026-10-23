import { afterAll, expect, test } from "bun:test";
import type { CanvasConnection, CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "zh-CN", setItem: () => {} } });
const { normalizeConnection, wouldCreateConnectionCycle } = await import("../src/lib/canvas/canvas-node-geometry");
const { isConnectionOperational } = await import("../src/lib/canvas/canvas-connection-state");
const { registerNodeDefinitions, unregisterPluginNodes } = await import("../src/lib/canvas/node-registry");
const { BLENDER_LINK, blenderWriteInput, hasBlenderWriteOutput } = await import("../src/lib/canvas/blender-link");
const { CanvasNodeType } = await import("../src/types/canvas");
const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 360, height: 360, metadata });
registerNodeDefinitions([{ type: BLENDER_LINK, title: "Blender Link", hasSourceHandle: true, hasTargetHandle: node => node.metadata?.blender?.mode === "write", resource: node => node.metadata?.content && (node.metadata.blender?.mode === "read" || hasBlenderWriteOutput(node)) ? { kind: "image", url: node.metadata.content } : null }], "blender-link-test");
afterAll(() => {
    unregisterPluginNodes("blender-link-test");
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("empty Blender ports can be wired ahead of time and only image inputs are accepted", () => {
    const nodes = [node("read", BLENDER_LINK, { blender: { mode: "read" } }), node("write", BLENDER_LINK, { blender: { mode: "write" } }), node("config", CanvasNodeType.Config), node("image", CanvasNodeType.Image), node("text", CanvasNodeType.Text)];
    expect(normalizeConnection("read", "config", nodes, "source")).toEqual({ fromNodeId: "read", toNodeId: "config" });
    expect(normalizeConnection("config", "write", nodes, "source")).toEqual({ fromNodeId: "config", toNodeId: "write" });
    expect(normalizeConnection("image", "write", nodes, "source")).not.toBeNull();
    expect(normalizeConnection("read", "write", nodes, "source")).not.toBeNull();
    expect(normalizeConnection("image", "read", nodes, "source")).toBeNull();
    expect(normalizeConnection("text", "write", nodes, "source")).toBeNull();
    expect(wouldCreateConnectionCycle("write", "read", [{ id: "edge", fromNodeId: "read", toNodeId: "write" }])).toBe(true);
});

test("switching modes makes existing image connections dormant and restores them", () => {
    const config = node("config", CanvasNodeType.Config);
    const write = node("write", BLENDER_LINK, { blender: { mode: "write" } });
    const connection: CanvasConnection = { id: "edge", fromNodeId: "config", toNodeId: "write" };
    expect(isConnectionOperational(connection, config, write)).toBe(true);
    write.metadata!.blender!.mode = "read";
    expect(isConnectionOperational(connection, config, write)).toBe(false);
    write.metadata!.blender!.mode = "write";
    config.metadata!.generationMode = "text";
    expect(isConnectionOperational(connection, config, write)).toBe(false);
    config.metadata!.generationMode = "image";
    expect(isConnectionOperational(connection, config, write)).toBe(true);
});

test("write freezes only one finished selected image, excluding stale or loading config output", () => {
    const write = node("write", BLENDER_LINK, { blender: { mode: "write" } });
    const config = node("config", CanvasNodeType.Config, { status: "success", content: "image-url", storageKey: "original", selectedOutputImageId: "result", outputImages: [{ id: "result", content: "image-url", storageKey: "original", status: "success" }] });
    const connections: CanvasConnection[] = [{ id: "edge", fromNodeId: "config", toNodeId: "write" }];
    expect(blenderWriteInput(write, [config, write], connections)?.storageKey).toBe("original");
    config.metadata!.status = "loading";
    expect(blenderWriteInput(write, [config, write], connections)).toBeNull();
    config.metadata!.status = "success";
    config.metadata!.selectedOutputImageId = "not-selected";
    expect(blenderWriteInput(write, [config, write], connections)).toBeNull();
    config.metadata!.selectedOutputImageId = "result";
    expect(blenderWriteInput(write, [config, write], [...connections, { ...connections[0], id: "second" }])).toBeNull();
});

test("a pending write cannot release an image downstream", () => {
    const write = node("write", BLENDER_LINK, { content: "frozen-image", storageKey: "frozen", blender: { mode: "write" } });
    expect(hasBlenderWriteOutput(write)).toBe(false);
    write.metadata!.blender!.receipt = { commandId: "command", sessionId: "session", port: 9876, destination: { kind: "new", name: "Result" }, imageId: "image", imageName: "Result", sha256: "digest", returnedAt: "date" };
    expect(hasBlenderWriteOutput(write)).toBe(true);
    write.metadata!.blender!.pending = { commandId: "next", sessionId: "session", port: 9876, destination: { kind: "image", imageId: "image", expectedRevision: "revision" }, colorSpace: "sRGB", storageKey: "frozen", inputKey: "edge:frozen" };
    expect(hasBlenderWriteOutput(write)).toBe(false);
});
