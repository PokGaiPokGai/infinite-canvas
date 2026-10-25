import test from "node:test";
import assert from "node:assert/strict";
import { getPaintMaskSource, MASK_PAINT, maskStrokeSegments, maskStrokeTouches, paintMaskMatches, paintMaskSourceKey, paintMaskSvg, remapPaintMaskSources } from "../src/lib/canvas/paint-mask";
import { normalizeConnection } from "../src/lib/canvas/canvas-node-geometry";
import { applyCanvasAgentOps } from "../src/lib/canvas/canvas-agent-ops";
import { resolveComparisonNodes } from "../src/lib/canvas/image-compare";
import { registerNodeDefinitions } from "../src/lib/canvas/node-registry";
import { MASK_INVERT } from "../src/lib/canvas/image-mask";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { PaintMaskDrawing } from "../src/types/paint-mask";

const stroke = { id: "ink", width: 18, points: [{ x: 20, y: 40 }, { x: 70, y: 40 }] };
const drawing: PaintMaskDrawing = { sourceId: "source", sourceKey: paintMaskSourceKey({ id: "source", title: "source", content: "original", storageKey: "image:source", naturalWidth: 100, naturalHeight: 80 }), width: 100, height: 80, strokes: [stroke] };
const node = (id: string, type: string, metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 80, metadata });
const source = node("source", CanvasNodeType.Image, { content: "original", storageKey: "image:source", naturalWidth: 100, naturalHeight: 80 });
const mask = node("mask", MASK_PAINT, { paintMask: drawing, content: "mask-png", storageKey: "image:mask", status: "success", naturalWidth: 100, naturalHeight: 80 });
registerNodeDefinitions([{ type: MASK_PAINT, title: "mask", icon: null, defaultSize: { width: 100, height: 80 }, resource: node => node.metadata?.content ? { kind: "image", url: node.metadata.content } : null }]);

test("paint output contains only white ink over opaque black at original pixel dimensions", () => {
    const svg = paintMaskSvg(drawing);
    assert.match(svg, /width="100" height="80"/);
    assert.match(svg, /<rect[^>]+fill="black"/);
    assert.match(svg, /stroke="white"/);
    assert.match(svg, /stroke-linecap="round" stroke-linejoin="round"/);
    assert.doesNotMatch(svg, /original|opacity|<image/);
    assert.equal(paintMaskSvg({ ...drawing, previewColor: "#ff6ed4" }), svg, "preview colour must not change mask pixels");
    assert.deepEqual(maskStrokeSegments({ ...stroke, points: [{ x: 30, y: 30 }] }), [{ path: "M 30 30 L 30 30", width: 18 }]);
    assert.ok(maskStrokeSegments({ ...stroke, points: [{ x: 20, y: 40, p: 0.1 }, { x: 70, y: 40, p: 0.9 }] }).some(segment => segment.width !== 18));
});

test("eraser crossing a stroke hits even when neither pointer endpoint touches it", () => {
    assert.equal(maskStrokeTouches(stroke, { x: 45, y: 10 }, { x: 45, y: 70 }), true);
    assert.equal(maskStrokeTouches(stroke, { x: 10, y: 75 }, { x: 85, y: 75 }), false);
});

test("hand painted output feeds downstream masks and becomes invalid when the source changes", () => {
    const downstream = node("invert", MASK_INVERT, {});
    const edges = [{ id: "input", fromNodeId: "source", toNodeId: "mask" }, { id: "output", fromNodeId: "mask", toNodeId: "invert" }];
    const nodes = [source, mask, downstream];
    const snapshot = structuredClone(nodes);
    const valid = resolveComparisonNodes(nodes, edges);
    assert.equal(valid[1].metadata?.content, "mask-png");
    assert.equal(valid[2].metadata?.productionInputs?.[0].content, "mask-png");
    const stale = resolveComparisonNodes([{ ...source, metadata: { ...source.metadata, storageKey: "image:replacement" } }, mask, downstream], edges);
    assert.equal(stale[1].metadata?.content, undefined);
    assert.equal(stale[2].metadata?.productionInputs?.[0]?.content, undefined);
    assert.deepEqual(stale[1].metadata?.paintMask?.strokes, drawing.strokes);
    assert.deepEqual(nodes, snapshot);
    assert.equal(resolveComparisonNodes(nodes, edges.slice(1))[1].metadata?.content, undefined);
});

test("source identity survives object URL recreation and painting requires exactly one input", () => {
    const input = { id: "source", title: "source", ...source.metadata };
    assert.equal(paintMaskSourceKey(input), paintMaskSourceKey({ ...input, content: "blob:after-reload" }));
    const empty = node("mask", MASK_PAINT, {});
    const other = { ...input, id: "other" };
    assert.equal(getPaintMaskSource(empty, [input, other]), undefined);
    assert.equal(getPaintMaskSource(empty, []), undefined);
    assert.equal(getPaintMaskSource(empty, [input]), input);
    assert.equal(getPaintMaskSource(mask, [other]), other);
    assert.equal(paintMaskMatches(mask.metadata?.paintMask, other), false);
});

test("copying a source and its mask remaps the binding without losing the editable drawing", () => {
    const metadata = { ...mask.metadata };
    const copy = remapPaintMaskSources(metadata, new Map([["source", "new-source"]]));
    assert.equal(copy.paintMask?.sourceId, "new-source");
    assert.equal(copy.paintMask?.sourceKey, drawing.sourceKey);
    assert.deepEqual(copy.paintMask?.strokes, drawing.strokes);
    assert.equal(metadata.paintMask?.sourceId, "source");
    assert.equal(remapPaintMaskSources(metadata, new Map()).paintMask?.sourceId, "source");
});

test("paint mask accepts one image from either drag direction and rejects a second connection", () => {
    const other = node("other", CanvasNodeType.Image, { content: "second" });
    const text = node("text", CanvasNodeType.Text, { content: "text" });
    const nodes = [source, other, text, mask];
    const edge = { id: "input", fromNodeId: source.id, toNodeId: mask.id };
    assert.deepEqual(normalizeConnection(source.id, mask.id, nodes, "source", []), { fromNodeId: source.id, toNodeId: mask.id });
    assert.deepEqual(normalizeConnection(mask.id, source.id, nodes, "target", []), { fromNodeId: source.id, toNodeId: mask.id });
    assert.equal(normalizeConnection(text.id, mask.id, nodes, "source", []), null);
    assert.equal(normalizeConnection(other.id, mask.id, nodes, "source", [edge]), null);
    assert.equal(normalizeConnection(mask.id, other.id, nodes, "target", [edge]), null);
    assert.equal(normalizeConnection(other.id, mask.id, nodes, "source", [{ ...edge, enabled: false }]), null);
    assert.deepEqual(normalizeConnection(other.id, mask.id, nodes, "source", []), { fromNodeId: other.id, toNodeId: mask.id });
});

test("Agent connection batches respect the same single-image limit and allow replacement after disconnect", () => {
    const other = node("other", CanvasNodeType.Image, { content: "second" });
    const snapshot = { nodes: [source, other, mask], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
    const first = applyCanvasAgentOps(snapshot, [
        { type: "connect_nodes", id: "first", fromNodeId: source.id, toNodeId: mask.id },
        { type: "connect_nodes", fromNodeId: other.id, toNodeId: mask.id },
    ]);
    assert.equal(first.connections.length, 1);
    assert.equal(first.connections[0].fromNodeId, source.id);
    const replaced = applyCanvasAgentOps(first, [
        { type: "delete_connections", id: "first" },
        { type: "connect_nodes", fromNodeId: other.id, toNodeId: mask.id },
    ]);
    assert.equal(replaced.connections.length, 1);
    assert.equal(replaced.connections[0].fromNodeId, other.id);
    assert.deepEqual(snapshot.connections, []);
});

test("disconnect and reload retain the saved mask file; reconnecting the same source restores output", () => {
    const retained = node("mask", MASK_PAINT, { paintMask: { ...drawing, output: { content: "restored-mask", storageKey: "image:saved-mask", naturalWidth: 100, naturalHeight: 80 } } });
    const disconnected = resolveComparisonNodes([source, retained], [])[1];
    assert.equal(disconnected.metadata?.content, undefined);
    assert.equal(disconnected.metadata?.paintMask?.output?.storageKey, "image:saved-mask");
    const reconnected = resolveComparisonNodes([source, disconnected], [{ id: "input", fromNodeId: "source", toNodeId: "mask" }])[1];
    assert.equal(reconnected.metadata?.content, "restored-mask");
    assert.equal(reconnected.metadata?.storageKey, "image:saved-mask");
});
