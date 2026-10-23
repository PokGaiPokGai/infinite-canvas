import { imageToDataUrl } from "@/services/image-storage";
import { createZip } from "@/lib/zip";
import type { ExportPreset, ProductionImage } from "@/types/canvas-production";

export function safeExportName(value: string) {
    const name = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
    return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `asset_${name}` : name;
}
export function exportDirectory(value: string) {
    if (!value.trim()) return "";
    if (/^[\\/]|^[a-z]:/i.test(value) || value.split(/[\\/]/).some(part => part === "." || part === "..")) throw new Error("子目录须为相对路径，不能包含 . 或 ..。");
    return value.split(/[\\/]/).filter(Boolean).map(safeExportName).join("/");
}
export function validateExportPreset(preset: ExportPreset) {
    if (![preset.width, preset.height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("宽高必须为正整数。");
    if (!["png", "webp", "jpeg"].includes(preset.format)) throw new Error("不支持的导出格式。");
    if (preset.format === "jpeg" && preset.transparent) throw new Error("JPEG 不支持透明，请关闭透明或选择 PNG / WebP。");
    if (!/^#[0-9a-f]{6}$/i.test(preset.background)) throw new Error("底色须为六位十六进制颜色。");
    if (!preset.pattern.trim()) throw new Error("请填写命名模板。");
    exportDirectory(preset.directory);
}
export type ExportFile = { name: string; data: Blob };
export async function preparePresetExport(images: ProductionImage[], preset: ExportPreset, signal?: AbortSignal) {
    validateExportPreset(preset);
    if (!images.length) throw new Error("请先连接要导出的图片。");
    if (images.some(image => !image.content || image.status === "loading" || image.status === "error")) throw new Error("有来源尚未就绪，请等待或移除对应连线。");
    const files: ExportFile[] = [];
    const records: Record<string, unknown>[] = [];
    const names = new Set<string>(["manifest.json"]);
    const directory = exportDirectory(preset.directory);
    for (const [index, image] of images.entries()) {
        signal?.throwIfAborted();
        const dataUrl = await imageToDataUrl({ storageKey: image.storageKey, url: image.content });
        const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
        try {
            signal?.throwIfAborted();
            const canvas = document.createElement("canvas");
            canvas.width = preset.width;
            canvas.height = preset.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("当前浏览器无法创建导出画布。");
            if (!preset.transparent) { ctx.fillStyle = preset.background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
            const scale = (preset.fit === "cover" ? Math.max : Math.min)(canvas.width / source.width, canvas.height / source.height);
            const w = source.width * scale, h = source.height * scale;
            ctx.drawImage(source, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
            const mime = `image/${preset.format}`;
            const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片编码失败，请检查导出尺寸。")), mime));
            if (blob.type !== mime) throw new Error(`当前浏览器不支持 ${preset.format} 编码，请选择 PNG。`);
            const base = safeExportName(preset.pattern.replaceAll("{name}", image.title).replaceAll("{index}", String(index + 1).padStart(2, "0")).replaceAll("{width}", String(preset.width)).replaceAll("{height}", String(preset.height)));
            const extension = preset.format === "jpeg" ? "jpg" : preset.format;
            let name = `${base}.${extension}`;
            for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base}_${n}.${extension}`;
            names.add(name.toLowerCase());
            const path = directory ? `${directory}/${name}` : name;
            files.push({ name: path, data: blob });
            records.push({ path, sourceNodeId: image.id, sourceTitle: image.title, sourceStorageKey: image.storageKey, sourceWidth: source.width, sourceHeight: source.height, width: preset.width, height: preset.height, mimeType: blob.type, bytes: blob.size });
        } finally { source.close(); }
    }
    signal?.throwIfAborted();
    if (preset.metadata) files.push({ name: directory ? `${directory}/manifest.json` : "manifest.json", data: new Blob([JSON.stringify({ app: "infinite-canvas", schemaVersion: 1, exportedAt: new Date().toISOString(), preset, images: records }, null, 2)], { type: "application/json" }) });
    return files;
}
export async function presetZip(files: ExportFile[]) { return createZip(files); }

// Handles only come from a user-initiated browser directory picker; they are never persisted.
export type ExportDirectoryHandle = {
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ExportDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;
};
export async function writeExportDirectory(root: ExportDirectoryHandle, files: ExportFile[], signal?: AbortSignal) {
    const base = `export_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let folderName = base;
    for (let n = 2; ; n++) {
        try { await root.getDirectoryHandle(folderName); }
        catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") break; throw error; }
        folderName = `${base}_${n}`;
    }
    signal?.throwIfAborted();
    const destination = await root.getDirectoryHandle(folderName, { create: true });
    for (const file of files) {
        signal?.throwIfAborted();
        const parts = file.name.split("/");
        let folder = destination;
        for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
        const handle = await folder.getFileHandle(parts.at(-1)!, { create: true });
        const writer = await handle.createWritable();
        await writer.write(file.data);
        await writer.close();
    }
    return folderName;
}
