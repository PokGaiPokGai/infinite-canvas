// Native Codex text generation through this machine's existing ChatGPT login.
// The bridge accepts text-only messages; no API key or Codex credential is sent by the browser.
const api = baseUrl.replace(/\/$/, "");
const call = async (path, data) => {
    try {
        return await request({
            url: `${api}${path}`, method: data === undefined ? "get" : "post", data,
            headers: { "Content-Type": "application/json", "X-Infinite-Canvas-Codex": "1" },
        });
    } catch (error) {
        throw new Error(error.response?.data?.error || error.message || "无法连接本机 Codex 文本服务，请重新运行启动无限画布。");
    }
};
const submitted = await call("/text/jobs", { messages, reasoningEffort });
if (!submitted.id) throw new Error("本机服务未返回文本任务编号。");
let result;
try {
    result = await poll(() => call(`/text/jobs/${submitted.id}`), (job) => {
        if (job.status === "failed") throw new Error(job.error || "Codex 文本生成失败。");
        if (job.status !== "succeeded") return null;
        if (typeof job.result !== "string" || !job.result.trim()) throw new Error("任务完成但没有返回文本。");
        return job.result;
    });
} catch (error) {
    throw new Error(`${error.message} 后台任务可能仍在进行，请勿立即重复提交。任务 ${submitted.id}。`);
}
onDelta?.(result);
return result;
