// Native Codex image generation using the existing local ChatGPT subscription login.
// No API credentials are sent. Model and dimensions are not guaranteed by the CLI.
const api = baseUrl.replace(/\/$/, "");
const call = async (path, data) => {
    try {
        return await request({
            url: `${api}${path}`, method: data === undefined ? "get" : "post", data,
            headers: { "Content-Type": "application/json", "X-Infinite-Canvas-Codex": "1" },
        });
    } catch (error) {
        throw new Error(error.response?.data?.error || error.message || "无法连接本机 Codex 生图服务，请重新运行启动无限画布。");
    }
};
const submitted = await call("/jobs", { prompt, images, params });
if (!submitted.id) throw new Error("本机服务未返回任务编号。");
// Reuse the canvas polling defaults; stopping page waiting does not cancel native generation.
let result;
try {
result = await poll(() => call(`/jobs/${submitted.id}`), (job) => {
    if (job.status === "failed") throw new Error(job.error || "Codex 生图失败。");
    if (job.status !== "succeeded") return null;
    if (!job.images?.length) throw new Error("任务完成但没有返回图片。");
    return job.images;
});
} catch (error) {
    throw new Error(`${error.message} 后台任务可能仍在进行，请勿立即重复提交。任务 ${submitted.id}；查看原图与记录：http://127.0.0.1:3000/codex-image/records`);
}
return result.map((url) => new URL(url, api).href);
