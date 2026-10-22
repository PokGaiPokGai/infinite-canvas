import { readFileSync, writeFileSync } from "node:fs";

const script = readFileSync(new URL("./comfyui-image.js", import.meta.url), "utf8");
const model = "dreamshaperXL_lightningDPMSDE.safetensors";
const modelId = `comfyui::${model}`;
const config = {
    channelMode: "local", baseUrl: "http://127.0.0.1:3000/comfy", apiKey: "local-comfyui", apiFormat: "openai",
    channels: [{ id: "comfyui", name: "本机 ComfyUI · SDXL Lightning", baseUrl: "http://127.0.0.1:3000/comfy", apiKey: "local-comfyui", apiFormat: "openai", models: [{ name: model, capability: "image", script }] }],
    model: modelId, imageModel: modelId, videoModel: "", textModel: "", audioModel: "", models: [modelId],
    audioVoice: "alloy", audioFormat: "mp3", audioSpeed: "1", audioInstructions: "",
    videoSeconds: "6", vquality: "720", videoGenerateAudio: "true", videoWatermark: "false", videoMode: "frames",
    systemPrompt: "", reasoningEffort: "auto", quality: "auto", size: "auto", background: "", count: "1", canvasImageCount: "1",
    proxyEnabled: false, proxyUrl: "http://127.0.0.1:23210", nodeRegenerateBehavior: "new-node", autoFocusOnSelect: false,
};
writeFileSync(new URL("./comfyui-config.json", import.meta.url), JSON.stringify({
    app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config,
    webdav: { url: "", username: "", password: "", directory: "infinite-canvas", lastSyncedAt: "" },
    promptSources: { sources: [], schedule: { intervalMinutes: 30, lastFetchedAt: "" } },
}, null, 2) + "\n");
