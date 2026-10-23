import type { BlenderImagePreview, BlenderReceipt, BlenderSnapshot, BlenderStatus, BlenderWrite } from "@/types/blender-link";

const root = "/blender-link";
const headers = { "X-Infinite-Canvas-Blender-UI": "1" };
async function checked(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await fetch(`${root}${path}`, { method: body === undefined ? "GET" : "POST", signal,
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(typeof error?.error === "string" ? error.error : `Blender Link 请求失败（${response.status}）。`);
    }
    return response;
}
export const getBlenderStatus = async (signal?: AbortSignal): Promise<BlenderStatus> => (await checked("/status", undefined, signal)).json();
export const getBlenderConnection = async (): Promise<{ port: number }> => (await checked("/connection")).json();
export const setBlenderConnection = async (port: number): Promise<{ port: number }> => (await checked("/connection", { port })).json();
export const createBlenderSnapshot = async (sessionId: string, sourceId: string): Promise<BlenderSnapshot> => (await checked("/snapshots", { sessionId, sourceId })).json();
export const getBlenderImagePreview = async (sessionId: string, imageId: string, signal?: AbortSignal): Promise<BlenderImagePreview> => (await checked("/image-preview", { sessionId, imageId }, signal)).json();
export const writeBlenderTexture = async (write: BlenderWrite, imageBase64: string): Promise<BlenderReceipt> => {
    const { commandId, sessionId, port, destination, colorSpace } = write;
    return (await checked("/returns", { commandId, sessionId, port, destination, colorSpace, imageBase64 })).json();
};
export async function getBlenderImage(url: string) {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin || !/^\/blender-link\/snapshots\/[0-9a-f-]+\/image$/i.test(parsed.pathname)) throw new Error("Blender 快照地址无效。");
    return (await checked(parsed.pathname.slice(root.length))).blob();
}
