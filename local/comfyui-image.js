// Infinite Canvas custom image script. Uses the native ComfyUI API, without an API key.
// DreamShaper XL Lightning: 6 steps, CFG 2, DPM++ SDE / Karras.
// One reference image enables img2img at denoise 0.65; quality is not an SDXL parameter.
if (images.length > 1) throw new Error("当前 ComfyUI 工作流支持单张参考图，请只保留一张后再生成。");
if (params.background === "transparent") throw new Error("当前 SDXL 工作流不生成透明背景，请关闭透明背景选项。");

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

let width = 1024;
let height = 1024;
const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, watermark, text", clip: ["1", 1] } },
    "5": {
        class_type: "KSampler",
        inputs: {
            model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
            seed: crypto.getRandomValues(new Uint32Array(1))[0], steps: 6, cfg: 2,
            sampler_name: "dpmpp_sde", scheduler: "karras", denoise: 1,
        },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "InfiniteCanvas/Canvas" } },
};

if (images.length) {
    const blob = await (await fetch(images[0], { signal })).blob();
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
    const form = new FormData();
    const suffix = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
    form.append("image", blob, `canvas-${crypto.randomUUID()}.${suffix}`);
    form.append("subfolder", "InfiniteCanvas");
    const uploaded = await call("/upload/image", form);
    const imageName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    graph["8"] = { class_type: "LoadImage", inputs: { image: imageName } };
    graph["9"] = { class_type: "ImageScale", inputs: { image: ["8", 0], width, height, upscale_method: "lanczos", crop: "disabled" } };
    graph["10"] = { class_type: "VAEEncode", inputs: { pixels: ["9", 0], vae: ["1", 2] } };
    graph["4"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["10", 0], amount: params.count } };
    graph["5"].inputs.denoise = 0.65;
}

if (params.size) [width, height] = params.size.split("x").map(Number);
if (images.length) {
    Object.assign(graph["9"].inputs, { width, height });
} else {
    graph["4"] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: params.count } };
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
