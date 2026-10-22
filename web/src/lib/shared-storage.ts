import localforage from "localforage";

type StoredEntry = { revision: number; view: unknown; failed?: boolean };
type SharedStatus = { pending: number; error: string; remoteChanged: boolean; importConflicts: number };
type StorageOptions = { name: string; storeName: string };
type PendingValue = { namespace: string; key: string; value: unknown; deleted: boolean };
const enabled = import.meta.env.VITE_LOCAL_SHARED_STORAGE === "1";
const endpoint = "/local-data";
const appNamespace = JSON.stringify(["infinite-canvas", "app_state"]);
const listeners = new Set<() => void>();
const entries = new Map<string, StoredEntry>();
const queues = new Map<string, Promise<unknown>>();
const pendingValues = new Map<string, PendingValue>();
const deferredWrites = new Map<string, () => void>();
const writeErrors = new WeakSet<object>();
const instanceCache = new Map<string, LocalForage>();
let status: SharedStatus = { pending: 0, error: "", remoteChanged: false, importConflicts: 0 };
let clientId = "";
let events: EventSource | undefined;
let globalRevision = 0;
let activeWrites = 0;

export const isSharedStorageEnabled = () => enabled;
export const getSharedStorageStatus = () => status;
export function subscribeSharedStorage(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function updateStatus(patch: Partial<SharedStatus>) {
    const next = { ...status, ...patch };
    if (Object.keys(next).every((key) => next[key as keyof SharedStatus] === status[key as keyof SharedStatus])) return;
    status = next;
    listeners.forEach((listener) => listener());
}
export function clearRemoteNotice() { updateStatus({ remoteChanged: false }); }
function updatePending() { updateStatus({ pending: activeWrites + deferredWrites.size }); }
export function deferSharedWrite(key: string, callback?: () => void) {
    if (!enabled) return;
    if (callback) deferredWrites.set(key, callback);
    else deferredWrites.delete(key);
    updatePending();
}
function flushDeferredWrites() {
    for (const callback of Array.from(deferredWrites.values())) callback();
}
const address = (namespace: string, key?: string) => `${endpoint}/${key === undefined ? "items" : "item"}?${new URLSearchParams({ namespace, ...(key === undefined ? {} : { key }) })}`;
const entryId = (namespace: string, key: string) => JSON.stringify([namespace, key]);
function headers(extra?: Record<string, string>) {
    return { "X-Infinite-Canvas-Storage": "1", "X-Storage-Client": clientId, ...extra };
}
async function checkedFetch(url: string, options?: RequestInit) {
    let response: Response;
    try { response = await fetch(url, { ...options, headers: { ...headers(), ...options?.headers } }); }
    catch { throw new Error("无法连接本机数据服务。内容尚未保存，请保留此窗口并重新启动无限画布。"); }
    if (!response.ok) {
        let message = "本机保存失败，请保留此窗口。";
        if (response.status === 409) message = "另一窗口已修改相同内容，已阻止覆盖。请导出未保存内容，再重新载入。";
        else if (response.status === 404) message = "本机共享存储接口不可用，请重新运行启动无限画布。";
        throw new Error(message);
    }
    return response;
}

// Binary media travels as raw bytes. Multipart preserves embedded Blobs in plugin values.
function hasBinary(value: unknown): boolean {
    if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Date) return true;
    return !!value && typeof value === "object" && Object.values(value).some(hasBinary);
}
function packValue(value: unknown): { kind: "json" | "blob"; body: BodyInit; mimeType?: string } {
    if (value instanceof Blob) return { kind: "blob", body: value, mimeType: value.type || "application/octet-stream" };
    if (!hasBinary(value)) return { kind: "json", body: JSON.stringify(value ?? null), mimeType: "application/json" };
    const form = new FormData();
    let binaryIndex = 0;
    const encode = (item: unknown): unknown => {
        if (item instanceof Date) return ["date", item.toISOString()];
        if (item instanceof Blob || item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
            const key = `binary-${binaryIndex++}`;
            let binary: Blob;
            if (item instanceof Blob) binary = item;
            else if (item instanceof ArrayBuffer) binary = new Blob([item]);
            else {
                const bytes = new Uint8Array(item.byteLength);
                bytes.set(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
                binary = new Blob([bytes.buffer]);
            }
            form.append(key, binary, key);
            return [item instanceof Blob ? "blob" : "buffer", key, binary.type];
        }
        if (Array.isArray(item)) return ["array", item.map(encode)];
        if (item && typeof item === "object") return ["object", Object.entries(item).map(([key, child]) => [key, encode(child)])];
        return ["value", item ?? null];
    };
    form.append("__infinite_canvas_value_v1", JSON.stringify(encode(value)));
    return { kind: "blob", body: form };
}
async function unpackResponse(response: Response): Promise<unknown> {
    if (response.headers.get("X-Storage-Kind") !== "blob") return response.json();
    const blob = await response.blob();
    if (!blob.type.startsWith("multipart/form-data")) return blob;
    const form = await new Response(blob).formData();
    const manifest = form.get("__infinite_canvas_value_v1");
    if (typeof manifest !== "string") return blob;
    const decode = async (node: [string, unknown, string?]): Promise<unknown> => {
        const [kind, data, mimeType] = node;
        if (kind === "blob" || kind === "buffer") {
            const binary = form.get(String(data));
            if (!(binary instanceof Blob)) throw new Error("共享文件的二进制内容缺失。");
            return kind === "buffer" ? binary.arrayBuffer() : binary.slice(0, binary.size, mimeType);
        }
        if (kind === "date") return new Date(String(data));
        if (kind === "array") return Promise.all((data as Parameters<typeof decode>[0][]).map(decode));
        if (kind === "object") return Object.fromEntries(await Promise.all((data as [string, Parameters<typeof decode>[0]][]).map(async ([key, child]) => [key, await decode(child)])));
        return data;
    };
    return decode(JSON.parse(manifest));
}

async function readValue<T>(namespace: string, key: string): Promise<T | null> {
    const id = entryId(namespace, key);
    const previous = entries.get(id);
    const response = await fetch(address(namespace, key), { headers: headers() });
    if (response.status !== 404 && !response.ok) throw new Error("无法读取本机保存的数据，请重新启动无限画布。");
    const revision = Number(response.headers.get("X-Storage-Revision") || 0);
    const value = response.status === 404 ? null : await unpackResponse(response);
    const current = entries.get(id);
    // A list refresh must not reset an in-flight write's baseline or its conflict marker.
    // Missing entries can still be initialized by the first queued write's read.
    if (!current || (current === previous && !current.failed && !pendingValues.has(id))) {
        entries.set(id, { revision, view: structuredClone(value) });
    }
    return value as T | null;
}

async function listKeys(namespace: string): Promise<string[]> {
    const data = await (await checkedFetch(address(namespace))).json();
    return data.items.map((item: { key: string }) => item.key);
}

function writeValue(namespace: string, key: string, value: unknown, deleted = false): Promise<unknown> {
    const id = entryId(namespace, key);
    const snapshot = structuredClone(value ?? null);
    const pending: PendingValue = { namespace, key, value: snapshot, deleted };
    pendingValues.set(id, pending);
    activeWrites += 1;
    updatePending();
    const task = (queues.get(id) || Promise.resolve()).catch(() => undefined).then(async () => {
        let entry = entries.get(id);
        if (!entry) { await readValue(namespace, key); entry = entries.get(id)!; }
        if (entry.failed) throw new Error("此内容有尚未处理的保存冲突，请先导出未保存内容并重新载入。");
        const packed = packValue(snapshot);
        const isEnvelope = !deleted && packed.kind === "json";
        const response = await checkedFetch(address(namespace, key), {
            method: deleted ? "DELETE" : "PUT",
            headers: headers({ "If-Match": String(entry.revision), "X-Storage-Kind": packed.kind,
                ...(packed.mimeType ? { "Content-Type": packed.mimeType } : {}), ...(isEnvelope ? { "X-Storage-Envelope": "1" } : {}) }),
            body: deleted ? undefined : isEnvelope ? JSON.stringify({ value: snapshot, baseValue: entry.view }) : packed.body,
        });
        const result = await response.json();
        // Keep the actual local view as the next three-way merge baseline.
        entries.set(id, { revision: result.revision, view: deleted ? null : snapshot });
        if (pendingValues.get(id) === pending) pendingValues.delete(id);
        if (result.merged) updateStatus({ remoteChanged: true });
        return value;
    }).catch((error: unknown) => {
        const entry = entries.get(id) || { revision: 0, view: null };
        entry.failed = true;
        entries.set(id, entry);
        const failure = error instanceof Error ? error : new Error("本机保存失败，请保留此窗口。");
        writeErrors.add(failure);
        updateStatus({ error: failure.message });
        throw failure;
    }).finally(() => { activeWrites -= 1; updatePending(); });
    // Zustand's set is synchronous; report rejected persistence through the persistent notice.
    void task.catch(() => undefined);
    queues.set(id, task);
    return task;
}

export function createAppStorage(options: StorageOptions): LocalForage {
    if (!enabled || ["image_previews", "prompt_cache"].includes(options.storeName)) return localforage.createInstance(options);
    const namespace = JSON.stringify([options.name, options.storeName]);
    const existing = instanceCache.get(namespace);
    if (existing) return existing;
    const api = {
        getItem: <T>(key: string) => readValue<T>(namespace, String(key)),
        setItem: <T>(key: string, value: T) => writeValue(namespace, String(key), value) as Promise<T>,
        removeItem: async (key: string) => { await writeValue(namespace, String(key), null, true); },
        keys: () => listKeys(namespace),
        length: async () => (await listKeys(namespace)).length,
        key: async (index: number) => (await listKeys(namespace))[index] ?? null,
        clear: async () => { for (const key of await listKeys(namespace)) { await readValue(namespace, key); await writeValue(namespace, key, null, true); } },
        iterate: async <T, U>(iterator: (value: T, key: string, iterationNumber: number) => U | Promise<U>) => {
            const keys = await listKeys(namespace);
            for (let i = 0; i < keys.length; i++) {
                const value = await readValue<T>(namespace, keys[i]);
                if (value === null) continue;
                const result = await iterator(value, keys[i], i + 1);
                if (result !== undefined) return result;
            }
            return undefined;
        },
        ready: async () => undefined,
    } as unknown as LocalForage;
    instanceCache.set(namespace, api);
    return api;
}

export async function flushSharedWrites() {
    do {
        flushDeferredWrites();
        await Promise.all(Array.from(queues.values()));
        if (status.error) throw new Error(status.error);
    } while (deferredWrites.size || activeWrites);
}
export async function exportPendingSharedWrites() {
    flushDeferredWrites();
    const { createZip } = await import("@/lib/zip");
    const files: { name: string; data: BlobPart }[] = [];
    const items = [];
    for (const [index, item] of Array.from(pendingValues.values()).entries()) {
        const packed = packValue(item.value);
        const data = packed.body instanceof FormData ? await new Response(packed.body).blob() : packed.body;
        const path = `pending-${index}.${packed.kind === "json" ? "json" : "bin"}`;
        files.push({ name: path, data: data as BlobPart });
        items.push({ namespace: item.namespace, key: item.key, deleted: item.deleted, kind: packed.kind, path, mimeType: data instanceof Blob ? data.type : packed.mimeType });
    }
    files.push({ name: "pending.json", data: JSON.stringify({ app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), items }, null, 2) });
    const url = URL.createObjectURL(await createZip(files));
    const link = document.createElement("a");
    link.href = url; link.download = `无限画布-未保存内容-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    link.click();
    link.addEventListener("blur", () => URL.revokeObjectURL(url), { once: true });
}
export async function getSharedStorageStats(): Promise<{ items: number; bytes: number; versions: number; backupBytes: number }> {
    return (await checkedFetch(`${endpoint}/stats`)).json();
}

async function legacyStores(): Promise<StorageOptions[]> {
    const result: StorageOptions[] = [];
    const databases = await indexedDB.databases();
    for (const { name } of databases) {
        if (name !== "infinite-canvas" && name !== "infinite-canvas-plugins") continue;
        const stores = await new Promise<string[]>((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { const database = request.result; const names = Array.from(database.objectStoreNames); database.close(); resolve(names); };
        });
        for (const storeName of stores) if (!["image_previews", "prompt_cache", "local-forage-detect-blob-support"].includes(storeName)) result.push({ name, storeName });
    }
    return result;
}

async function migrateBrowserData() {
    const markerKey = "infinite-canvas:shared-storage-migration-v1";
    if (localStorage.getItem(markerKey)) return;
    const migration = await (await checkedFetch(`${endpoint}/imports`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: "{}" })).json();
    const upload = async (namespace: string, key: string, value: unknown) => {
        const packed = packValue(value);
        await checkedFetch(`${endpoint}/imports/${migration.id}/item?${new URLSearchParams({ namespace, key })}`, {
            method: "PUT", headers: headers({ "X-Storage-Kind": packed.kind, ...(packed.mimeType ? { "Content-Type": packed.mimeType } : {}) }), body: packed.body,
        });
    };
    // Originals remain untouched in this browser. The import stage is a complete disk backup.
    for (const options of await legacyStores()) {
        const namespace = JSON.stringify([options.name, options.storeName]);
        const store = localforage.createInstance(options);
        for (const key of await store.keys()) await upload(namespace, key, await store.getItem(key));
    }
    for (const key of ["infinite-canvas:ai_config_store", "infinite-canvas:prompt_source_store_v2", "infinite-canvas:theme_store"]) {
        const value = localStorage.getItem(key);
        if (value !== null) await upload(appNamespace, key, value);
    }
    const result = await (await checkedFetch(`${endpoint}/imports/${migration.id}/commit`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: "{}" })).json();
    localStorage.setItem(markerKey, JSON.stringify({ id: migration.id, completedAt: new Date().toISOString() }));
    updateStatus({ importConflicts: result.conflicts?.length || 0 });
}

export async function initializeSharedStorage() {
    if (!enabled) return;
    clientId = sessionStorage.getItem("infinite-canvas:shared-client") || crypto.randomUUID();
    sessionStorage.setItem("infinite-canvas:shared-client", clientId);
    const meta = await (await checkedFetch(`${endpoint}/meta`)).json();
    if (meta.schemaVersion !== 1) throw new Error("本机数据库版本与应用不一致，已停止载入以保护原数据。");
    await migrateBrowserData();
    const latest = await (await checkedFetch(`${endpoint}/meta`)).json();
    globalRevision = latest.revision;
    events = new EventSource(`${endpoint}/events?${new URLSearchParams({ client: clientId })}`);
    events.onmessage = (message) => {
        let event: { globalRevision?: number; revision?: number; clientId?: string };
        try {
            event = JSON.parse(message.data);
        } catch {
            updateStatus({ error: "本机数据更新通知无法读取，请保留此窗口并检查本机服务。" });
            return;
        }
        if (!event || typeof event !== "object") {
            updateStatus({ error: "本机数据更新通知格式不正确，请保留此窗口并检查本机服务。" });
            return;
        }
        const revision = Number(event.globalRevision ?? event.revision);
        if (!Number.isSafeInteger(revision)) {
            updateStatus({ error: "本机数据更新通知版本不正确，请保留此窗口并检查本机服务。" });
            return;
        }
        if (revision <= globalRevision) return;
        globalRevision = revision;
        if (event.clientId !== clientId) updateStatus({ remoteChanged: true });
    };
    window.addEventListener("unhandledrejection", (event) => {
        // Zustand's synchronous actions may discard the returned persistence promise.
        // The notice already exposes these failures; unrelated rejections remain visible.
        if (event.reason && typeof event.reason === "object" && writeErrors.has(event.reason)) event.preventDefault();
    });
    window.addEventListener("beforeunload", (event) => {
        if (status.pending || pendingValues.size) { event.preventDefault(); event.returnValue = ""; }
    });
    window.addEventListener("focus", () => {
        void checkedFetch(`${endpoint}/meta`).then((response) => response.json()).then((current) => {
            if (current.revision > globalRevision) { globalRevision = current.revision; updateStatus({ remoteChanged: true }); }
        }).catch(() => updateStatus({ error: "本机数据服务已断开，请重新启动无限画布。" }));
    });
}
