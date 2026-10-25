import test from "node:test";
import assert from "node:assert/strict";
import { getCanvasInputSocket, getCanvasOutputType, getCanvasPreviewType, getCanvasSocketColor } from "../src/lib/canvas/canvas-sockets";
import { normalizeConnection } from "../src/lib/canvas/canvas-node-geometry";
import { applyCanvasAgentOps } from "../src/lib/canvas/canvas-agent-ops";
import { registerNodeDefinitions, unregisterPluginNodes } from "../src/lib/canvas/node-registry";
import { canvasThemes } from "../src/lib/canvas-theme";
import type { CanvasNodeData } from "../src/types/canvas";

const node = (id: string, type: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 200, metadata });

test("typed outputs stay stable before generation and through loading or errors", () => {
    const cases = [
        ["image", "image"], ["text", "text"], ["video", "video"], ["audio", "audio"],
        ["process:mask-paint", "mask"], ["process:mask-extract", "mask"], ["process:mask-feather", "mask"],
        ["process:alpha-apply", "image"], ["blender-link:link", "image"], ["krita-link:link", "image"],
        ["image-compare:compare", "image"], ["version-stack:images", "image"], ["production:reference-pack", "reference"],
    ];
    for (const [type, expected] of cases) {
        for (const status of ["idle", "loading", "error", "success"] as const) assert.equal(getCanvasOutputType(node("n", type, { status })), expected);
    }
    for (const generationMode of ["image", "text", "video", "audio"] as const) {
        const config = node("n", "config", { generationMode, outputKind: "image" });
        assert.equal(getCanvasOutputType(config), generationMode, "config type must follow current mode, not an older result");
        assert.equal(getCanvasInputSocket(config).multiple, true);
    }
    assert.equal(getCanvasOutputType(node("n", "process:batch", { batchSettings: { mode: "text", prompt: "", inputText: "", model: "", size: "", axes: [] } })), "text");
    assert.equal(getCanvasOutputType(node("n", "process:workflow")), "mixed");
    assert.equal(getCanvasOutputType(node("n", "process:workflow", { outputKind: "text" })), "text");
});

test("single input shapes agree with connection capacity in both drag directions and Agent batches", () => {
    const source = node("a", "image"), other = node("b", "image");
    for (const type of ["process:mask-paint", "process:mask-extract", "process:mask-invert", "process:mask-grow", "process:mask-feather", "blender-link:link", "krita-link:link"]) {
        const target = node("target", type, { blender: { mode: "write", writeMode: "image", colorSpace: "sRGB" }, krita: { kind: "link", mode: "write" } });
        const nodes = [source, other, target];
        const occupied = [{ id: "edge", fromNodeId: source.id, toNodeId: target.id }];
        assert.equal(getCanvasInputSocket(target).multiple, false);
        assert.ok(normalizeConnection(source.id, target.id, nodes, "source"));
        assert.ok(normalizeConnection(target.id, source.id, nodes, "target"));
        assert.equal(normalizeConnection(other.id, target.id, nodes, "source", occupied), null);
        assert.equal(normalizeConnection(target.id, other.id, nodes, "target", occupied), null);
        const result = applyCanvasAgentOps({ projectId: "test", title: "test", nodes, connections: occupied, selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }, [{ type: "connect_nodes", fromNodeId: other.id, toNodeId: target.id }]);
        assert.equal(result.connections.length, 1);
    }
});

test("multi input sockets keep accepting multiple sources; output fan-out remains available", () => {
    const source = node("a", "image"), other = node("b", "image");
    for (const type of ["config", "process:alpha-apply", "image-compare:compare", "production:reference-pack", "production:export-preset", "process:batch", "process:workflow"]) {
        const target = node("target", type);
        assert.equal(getCanvasInputSocket(target).multiple, true);
        assert.ok(normalizeConnection(other.id, target.id, [source, other, target], "source", [{ id: "first", fromNodeId: source.id, toNodeId: target.id }]));
    }
    const mask = node("mask", "process:mask-paint"), second = node("second", "process:mask-extract");
    assert.ok(normalizeConnection(source.id, second.id, [source, mask, second], "source", [{ id: "first", fromNodeId: source.id, toNodeId: mask.id }]));
});

test("reverse preview adopts the source data type and themes keep data colours distinct", () => {
    const mask = node("mask", "process:mask-paint"), config = node("config", "config");
    assert.equal(getCanvasPreviewType(mask, "source", config), "mask");
    assert.equal(getCanvasPreviewType(config, "target"), "mixed");
    assert.equal(getCanvasPreviewType(config, "target", mask), "mask");
    for (const theme of Object.values(canvasThemes)) {
        const colors = ["image", "mask", "text", "video", "audio", "reference", "mixed"].map(type => theme.socket[type as keyof typeof theme.socket]);
        assert.equal(new Set(colors).size, colors.length);
    }
});

test("reverse drags on basic nodes commit the same direction as their coloured preview", () => {
    const target = node("image", "image");
    for (const type of ["text", "config", "video", "audio", "group"]) {
        const source = node("source", type, { generationMode: "text" });
        assert.deepEqual(normalizeConnection(target.id, source.id, [target, source], "target"), { fromNodeId: source.id, toNodeId: target.id });
        assert.equal(getCanvasPreviewType(target, "target", source), getCanvasOutputType(source));
    }
    assert.equal(normalizeConnection("image", "group", [target, node("group", "group")], "source"), null);
});

test("plugins retain generic multi input while output kinds use their existing resource contract", () => {
    const type = "socket-test:media";
    registerNodeDefinitions([{ type, title: "test", icon: null, defaultSize: { width: 100, height: 100 }, resource: () => ({ kind: "audio", url: "fixture" }) }], "socket-test");
    try {
        assert.equal(getCanvasOutputType(node("n", type)), "audio");
        assert.deepEqual(getCanvasInputSocket(node("n", type)), { type: "mixed", multiple: true });
        assert.equal(getCanvasOutputType(node("n", "unregistered:node")), "mixed");
    } finally { unregisterPluginNodes("socket-test"); }
});

test("link socket colours share the border phase and palette without changing image semantics", () => {
    for (const brand of ["blender", "krita"]) {
        const link = node("link", `${brand}-link:link`);
        const input = getCanvasSocketColor(link, "target", canvasThemes.dark);
        const output = getCanvasSocketColor(link, "source", canvasThemes.dark);
        assert.match(input, new RegExp(`var\\(--${brand}-flow-`));
        assert.match(input, /var\(--canvas-link-phase\)/);
        assert.notEqual(input, output, "left and right sample distinct points on the moving border");
        assert.equal(getCanvasOutputType(link), "image");
        assert.equal(getCanvasInputSocket(link).type, "image");
        assert.equal(getCanvasSocketColor({ ...link, metadata: { status: "loading" } }, "source", canvasThemes.light), output);
        assert.equal(getCanvasSocketColor({ ...link, width: link.width * 2, height: link.height * 2 }, "source", canvasThemes.dark), output, "uniform scaling keeps the same border colours");
        assert.notEqual(getCanvasSocketColor({ ...link, width: link.width * 2 }, "source", canvasThemes.dark), output, "aspect changes move the sample along the diagonal gradient");
    }
});

test("ordinary edge endpoints retain independent input and output type colours", () => {
    for (const theme of Object.values(canvasThemes)) {
        const image = node("image", "image"), mask = node("mask", "process:mask-feather");
        assert.equal(getCanvasSocketColor(image, "source", theme), theme.socket.image);
        assert.equal(getCanvasSocketColor(mask, "target", theme), theme.socket.mask);
        assert.notEqual(getCanvasSocketColor(image, "source", theme), getCanvasSocketColor(mask, "target", theme));
        assert.equal(getCanvasSocketColor(mask, "source", theme), theme.socket.mask);
    }
});
