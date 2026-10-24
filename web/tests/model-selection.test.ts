import assert from "node:assert/strict";
import { after as afterAll, test } from "node:test";
import type { AiConfig, ModelCapability } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";

// Config and i18n use browser storage during module initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { defaultConfig, resolveModelForCapability, useConfigStore } = await import("../src/stores/use-config-store");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");

const config: AiConfig = {
    ...defaultConfig,
    videoModel: "replacement::video-b",
    channels: [
        {
            id: "replacement",
            name: "Replacement",
            baseUrl: "https://example.com",
            apiKey: "test-key",
            apiFormat: "openai",
            models: [
                { name: "video-b", capability: "video" },
                { name: "video-a", capability: "video" },
                { name: "image-a", capability: "image" },
            ],
        },
    ],
};
const ready = useConfigStore.getState().isAiConfigReady;
const videoNode = (model: string): CanvasNodeData => ({
    id: "saved-video",
    type: CanvasNodeType.Video,
    title: "Saved video",
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata: { model, videoTaskId: "original-task", videoTaskProvider: "openai", seconds: "4" },
});

test("a saved video on a removed provider is not replaced by the default video model", () => {
    const selected = buildGenerationConfig(config, videoNode("removed::video-a"), "video");
    assert.strictEqual(selected.model, "removed::video-a");
    assert.strictEqual(ready(selected, selected.model), false);
});

test("removing a model from an existing provider prevents retry even with valid credentials", () => {
    const selected = buildGenerationConfig(config, videoNode("replacement::deleted-video"), "video");
    assert.strictEqual(selected.model, "replacement::deleted-video");
    assert.strictEqual(ready(selected, selected.model), false);
});

test("task recovery rejects a missing provider instead of querying the first provider", () => {
    assert.strictEqual(ready(config, "removed::video-a"), false);
    assert.strictEqual(ready(config, "unknown-video"), false);
});

test("an explicitly selected unavailable default is not replaced by the built-in default", () => {
    const selected = buildGenerationConfig({ ...config, videoModel: "removed::video-a" }, undefined, "video");
    assert.strictEqual(selected.model, "removed::video-a");
    assert.strictEqual(ready(selected, selected.model), false);
});

test("a new node without a selection still uses its configured default", () => {
    const selected = buildGenerationConfig(config, undefined, "video");
    assert.strictEqual(selected.model, "replacement::video-b");
    assert.strictEqual(ready(selected, selected.model), true);
});

test("switching generation capability still selects a model of the new capability", () => {
    assert.strictEqual(resolveModelForCapability(config, "replacement::image-a", "video"), "replacement::video-b");
});

test("changing only the key on the same provider preserves the saved model and task", () => {
    const node = videoNode("replacement::video-a");
    const selected = buildGenerationConfig({ ...config, channels: [{ ...config.channels[0], apiKey: "rotated-key" }] }, node, "video");
    assert.strictEqual(selected.model, "replacement::video-a");
    assert.strictEqual(ready(selected, selected.model), true);
    assert.strictEqual(node.metadata?.videoTaskId, "original-task");
    assert.strictEqual(ready({ ...selected, channels: [{ ...config.channels[0], apiKey: "" }] }, selected.model), false);
});

test("unavailable explicit selections are preserved for every generation capability", () => {
    for (const capability of ["image", "video", "text", "audio"] as ModelCapability[]) {
        assert.strictEqual(resolveModelForCapability(config, `removed::${capability}`, capability), `removed::${capability}`);
    }
});
