// Infinite Canvas custom image script. Uses the native ComfyUI API, without an API key.
// Canvas Config passes optional controls in params.comfy and per-image roles in params.referenceRoles.
// One reference/composition image is the img2img source. Style images use the installed SDXL IP-Adapter.
if (params.background === "transparent") throw new Error("当前 SDXL 工作流不生成透明背景，请关闭透明背景选项。");

const settings = params.comfy || {};
const roles = params.referenceRoles || images.map(() => "reference");
if (!Array.isArray(roles) || roles.length !== images.length) throw new Error("参考图角色与图片数量不一致，请重新连接图片。");
const sources = [];
const styles = [];
for (let index = 0; index < roles.length; index++) {
    if (roles[index] === "reference" || roles[index] === "composition") sources.push(index);
    else if (roles[index] === "style") styles.push(index);
    else throw new Error(`当前 ComfyUI 工作流还不能直接使用「${roles[index]}」图像角色；请选择支持该角色的模型工作流。`);
}
if (sources.length > 1) throw new Error("当前 ComfyUI 工作流只能指定一张改绘底图；其余图片可设为风格参考。");

const steps = settings.steps ?? 6;
const cfg = settings.cfg ?? 2;
const denoise = settings.denoise ?? 0.65;
const sampler = settings.sampler ?? "dpmpp_sde";
const scheduler = settings.scheduler ?? "karras";
const styleWeight = settings.styleWeight ?? 0.6;
let seed = settings.seed ?? -1;
if (!Number.isSafeInteger(steps) || steps <= 0 || !Number.isFinite(cfg) || cfg < 0 ||
    !Number.isFinite(denoise) || denoise < 0 || denoise > 1 ||
    !Number.isSafeInteger(seed) || seed < -1 ||
    typeof sampler !== "string" || !sampler || typeof scheduler !== "string" || !scheduler ||
    (settings.negativePrompt !== undefined && typeof settings.negativePrompt !== "string") ||
    !Number.isFinite(styleWeight) || styleWeight < 0 || styleWeight > 1) {
    throw new Error("ComfyUI 参数无效，请检查步数、CFG、改绘强度、种子和风格权重。");
}
if (seed === -1) seed = crypto.getRandomValues(new Uint32Array(1))[0];

const api = baseUrl.replace(/\/$/, "");
const call = async (path, data) => {
    try {
        return await request({ url: `${api}${path}`, method: data === undefined ? "get" : "post", data });
    } catch (error) {
        const details = error.response?.data;
        if (details?.error || details?.node_errors) {
            throw new Error(`ComfyUI 校验失败：${JSON.stringify(details.error || details.node_errors)}`);
        }
        throw error;
    }
};

if (styles.length) {
    const info = await call("/object_info");
    if (!info.IPAdapterModelLoader?.input?.required?.ipadapter_file?.[0]?.includes("ip-adapter_sdxl_vit-h.safetensors") ||
        !info.CLIPVisionLoader?.input?.required?.clip_name?.[0]?.includes("clip-vision_vit-h.safetensors") ||
        !info.IPAdapterAdvanced?.input?.required?.weight_type?.[0]?.includes("style transfer")) {
        throw new Error("ComfyUI 缺少已配置的 SDXL IP-Adapter 或 CLIP Vision 模型，未提交生成任务。");
    }
}

let width = 1024;
let height = 1024;
if (params.size) [width, height] = params.size.split("x").map(Number);
const uploaded = [];
for (let index = 0; index < images.length; index++) {
    const blob = await (await fetch(images[index], { signal })).blob();
    if (index === sources[0] && !params.size) {
        const bitmap = await createImageBitmap(blob);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
    }
    const form = new FormData();
    const suffix = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
    form.append("image", blob, `canvas-${crypto.randomUUID()}.${suffix}`);
    form.append("subfolder", "InfiniteCanvas");
    const result = await call("/upload/image", form);
    if (!result?.name) throw new Error("ComfyUI 未返回上传图片的名称。");
    uploaded[index] = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

const latentWidth = Math.max(8, Math.round(width / 8) * 8);
const latentHeight = Math.max(8, Math.round(height / 8) * 8);
const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: settings.negativePrompt ?? "blurry, low quality, watermark, text", clip: ["1", 1] } },
    "5": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
        seed, steps, cfg, sampler_name: sampler, scheduler, denoise: sources.length ? denoise : 1 } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "InfiniteCanvas/Canvas" } },
};

if (sources.length) {
    graph["8"] = { class_type: "LoadImage", inputs: { image: uploaded[sources[0]] } };
    graph["9"] = { class_type: "ImageScale", inputs: { image: ["8", 0], width: latentWidth, height: latentHeight, upscale_method: "lanczos", crop: "disabled" } };
    graph["10"] = { class_type: "VAEEncode", inputs: { pixels: ["9", 0], vae: ["1", 2] } };
    graph["4"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["10", 0], amount: params.count } };
    if (latentWidth !== width || latentHeight !== height) {
        graph["11"] = { class_type: "ImageScale", inputs: { image: ["6", 0], width, height, upscale_method: "lanczos", crop: "disabled" } };
        graph["7"].inputs.images = ["11", 0];
    }
} else {
    graph["4"] = { class_type: "EmptyLatentImage", inputs: { width: latentWidth, height: latentHeight, batch_size: params.count } };
}

if (styles.length) {
    graph["18"] = { class_type: "IPAdapterModelLoader", inputs: { ipadapter_file: "ip-adapter_sdxl_vit-h.safetensors" } };
    graph["19"] = { class_type: "CLIPVisionLoader", inputs: { clip_name: "clip-vision_vit-h.safetensors" } };
    let currentModel = ["1", 0];
    for (let index = 0; index < styles.length; index++) {
        const loadId = String(20 + index * 2);
        const adapterId = String(21 + index * 2);
        graph[loadId] = { class_type: "LoadImage", inputs: { image: uploaded[styles[index]] } };
        graph[adapterId] = { class_type: "IPAdapterAdvanced", inputs: { model: currentModel, ipadapter: ["18", 0], image: [loadId, 0],
            clip_vision: ["19", 0], weight: styleWeight / styles.length, weight_type: "style transfer", combine_embeds: "concat",
            start_at: 0, end_at: 1, embeds_scaling: "V only" } };
        currentModel = [adapterId, 0];
    }
    graph["5"].inputs.model = currentModel;
}

const submitted = await call("/prompt", { prompt: graph, client_id: `infinite-canvas-${crypto.randomUUID()}` });
if (!submitted.prompt_id) throw new Error("ComfyUI 未返回任务编号。");
// Reuse Infinite Canvas's polling defaults. Cancelling the page does not interrupt other ComfyUI jobs.
const output = await poll(
    () => call(`/history/${submitted.prompt_id}`),
    (history) => {
        const job = history[submitted.prompt_id];
        if (!job) return null;
        if (job.status?.status_str === "error") {
            const failure = job.status.messages?.find(([kind]) => kind === "execution_error" || kind === "execution_interrupted");
            throw new Error(`ComfyUI 生成失败：${failure?.[1]?.exception_message || "任务被中断，请查看 ComfyUI 日志。"}`);
        }
        return job.outputs?.["7"]?.images;
    },
);
return output.map((image) => `${api}/view?${new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })}`);
