import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";
import { sameHistoryNodes } from "../src/lib/canvas/canvas-history-inputs.ts";

const node = (id: string, type = "process:mask-grow", metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 10, y: 20 }, width: 320, height: 260, metadata });
const imageOutput = (id: string) => ({ id, content: `/${id}.png`, status: "success" as const, naturalWidth: 32, naturalHeight: 16, bytes: 512, mimeType: "image/png" });

test("automatic mask loading, success and errors do not create another editable history state", () => {
    const original = node("mask", "process:mask-grow", { maskSettings: { amount: 4 }, content: "/old.png", storageKey: "old", processOutputKey: "old-input", status: "success" });
    const loading = { ...original, metadata: { ...original.metadata, content: undefined, processInputKey: "new-input", processRunKey: "new-input", status: "loading" as const } };
    const complete = { ...original, metadata: { ...original.metadata, content: "/new.png", storageKey: "new", naturalWidth: 2048, naturalHeight: 1024, mimeType: "image/png", bytes: 1234, outputKind: "image" as const, processOutputKey: "new-input", status: "success" as const } };
    const failure = { ...loading, metadata: { ...loading.metadata, processRunKey: undefined, processErrorKey: "new-input", status: "error" as const, errorDetails: "图片加载失败" } };
    assert.equal(sameHistoryNodes([original], [loading]), true);
    assert.equal(sameHistoryNodes([loading], [complete]), true);
    assert.equal(sameHistoryNodes([complete], [failure]), true);
});

test("dependent Compare, version stack and production input caches do not add history", () => {
    const before = [
        node("compare", "image-compare:compare", { comparison: { aId: "mask", bId: "source", selected: "a" }, content: "/before.png", comparisonInputs: [] }),
        node("stack", "version-stack:images", { versionStack: { memberIds: ["image-a", "image-b"], selectedId: "image-a" }, content: "/before.png", stackInputs: [] }),
        node("export", "production:export-preset", { productionInputs: [] }),
    ];
    const after = before.map(current => ({ ...current, metadata: {
        ...current.metadata,
        ...(current.id === "export" ? { productionInputs: [{ id: "mask", title: "mask", content: "/new.png", storageKey: "new", status: "success" }] } : { content: "/new.png", storageKey: "new", status: "success" as const }),
        ...(current.id === "compare" ? { comparisonInputs: [{ nodeId: "mask", title: "mask", content: "/new.png" }] } : {}),
        ...(current.id === "stack" ? { stackInputs: [{ nodeId: "image-a", title: "image-a", content: "/new.png" }] } : {}),
    } }));
    assert.equal(sameHistoryNodes(before, after), true);
});

test("mask parameters and Alpha source bindings remain undoable", () => {
    const cases = [
        ["process:mask-extract", { channel: "alpha" }, { channel: "luminance" }],
        ["process:mask-grow", { amount: 4 }, { amount: -4 }],
        ["process:mask-feather", { radius: 4 }, { radius: 8 }],
        ["process:alpha-apply", { imageId: "image", maskId: "mask-a" }, { imageId: "image", maskId: "mask-b" }],
    ] as const;
    for (const [type, before, after] of cases) assert.equal(sameHistoryNodes([node("mask", type, { maskSettings: before })], [node("mask", type, { maskSettings: after })]), false);
});

test("Compare selection, stack selection and interaction mode remain real edits", () => {
    const compare = node("compare", "image-compare:compare", { comparison: { aId: "a", bId: "b", selected: "a", mode: "slider" }, interactive: false });
    assert.equal(sameHistoryNodes([compare], [{ ...compare, metadata: { ...compare.metadata, comparison: { ...compare.metadata?.comparison, selected: "b" } } }]), false);
    assert.equal(sameHistoryNodes([compare], [{ ...compare, metadata: { ...compare.metadata, comparison: { ...compare.metadata?.comparison, mode: "toggle" } } }]), false);
    assert.equal(sameHistoryNodes([compare], [{ ...compare, metadata: { ...compare.metadata, interactive: true } }]), false);
    const stack = node("stack", "version-stack:images", { versionStack: { memberIds: ["a", "b"], selectedId: "a" } });
    assert.equal(sameHistoryNodes([stack], [{ ...stack, metadata: { versionStack: { memberIds: ["a", "b"], selectedId: "b" } } }]), false);
});

test("moving, resizing, renaming, membership and ordering remain undoable", () => {
    const first = node("a"), second = node("b");
    for (const changed of [{ ...first, position: { x: 12, y: 20 } }, { ...first, width: 400 }, { ...first, title: "renamed" }, { ...first, metadata: { groupId: "group" } }]) {
        assert.equal(sameHistoryNodes([first], [changed]), false);
    }
    assert.equal(sameHistoryNodes([first], [first, second]), false);
    assert.equal(sameHistoryNodes([first, second], [second, first]), false);
});

test("ordinary image replacement and Config generation results still create history", () => {
    const image = node("image", "image", { content: "/before.png", storageKey: "before", status: "success" });
    assert.equal(sameHistoryNodes([image], [{ ...image, metadata: { ...image.metadata, content: "/after.png", storageKey: "after" } }]), false);
    const config = node("config", "config", { generationMode: "image", outputImages: [imageOutput("old")], selectedOutputImageId: "old" });
    assert.equal(sameHistoryNodes([config], [{ ...config, metadata: { ...config.metadata, outputImages: [imageOutput("new")], selectedOutputImageId: "new" } }]), false);
});

test("comparison keeps complete snapshots intact", () => {
    const before = [node("mask", "process:mask-invert", { content: "/before.png", storageKey: "before", maskSettings: { channel: "alpha" } })];
    const after = [node("mask", "process:mask-invert", { content: "/after.png", storageKey: "after", maskSettings: { channel: "alpha" } })];
    const originalBefore = structuredClone(before), originalAfter = structuredClone(after);
    assert.equal(sameHistoryNodes(before, after), true);
    assert.deepEqual(before, originalBefore);
    assert.deepEqual(after, originalAfter);
    assert.equal(after[0].metadata?.storageKey, "after");
});
