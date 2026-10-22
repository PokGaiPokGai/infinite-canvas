import { initializeSharedStorage } from "@/lib/shared-storage";

async function bootstrap() {
    const root = document.getElementById("root");
    if (root) {
        root.textContent = "正在打开本机应用，首次使用会保留并迁移原有浏览器数据…";
        Object.assign(root.style, { padding: "24px", fontFamily: '"Microsoft YaHei",sans-serif' });
    }
    await initializeSharedStorage();
    const { mountApp } = await import("./app-entry");
    if (root) root.removeAttribute("style");
    await mountApp();
}

void bootstrap().catch((error: unknown) => {
    const root = document.getElementById("root");
    if (!root) return;
    const heading = document.createElement("h1");
    heading.textContent = "暂时无法打开本机数据";
    const detail = document.createElement("p");
    detail.textContent = error instanceof Error ? error.message : "请确认无限画布的本机服务已启动。";
    const preservation = document.createElement("p");
    preservation.textContent = "原有浏览器数据已保留。请恢复本机服务后重试。";
    const retry = document.createElement("button");
    retry.textContent = "重新载入";
    retry.onclick = () => location.reload();
    root.replaceChildren(heading, detail, preservation, retry);
    Object.assign(root.style, { padding: "32px", fontFamily: '"Microsoft YaHei",sans-serif', lineHeight: "1.8" });
});
