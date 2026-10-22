// Local Krita/ComfyUI adapter. Connection credentials and artwork stay in .local/.
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const ORIGIN = 'http://127.0.0.1:3000';
const NATIVE = 'http://127.0.0.1:3003';
const COMFY = 'http://127.0.0.1:8188';
const COMFY_FOLDER = 'InfiniteCanvas/Krita';
const comfyFolder = (value) => typeof value === 'string' && value.replaceAll('\\', '/') === COMFY_FOLDER;
const PRESETS = [
    { id: 'draft', name: '草稿转绘', defaults: { steps: 6, cfg: 2, denoise: 0.65, sampler: 'dpmpp_sde', scheduler: 'karras' } },
    { id: 'detail', name: '保留结构细化', defaults: { steps: 20, cfg: 7, denoise: 0.35, sampler: 'dpmpp_2m', scheduler: 'karras' } },
];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validId = (value) => typeof value === 'string' && UUID.test(value);
const layerIdOf = (value) => {
    if (typeof value !== 'string') return value;
    const plain = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
    return UUID.test(plain) ? plain.toLowerCase() : value;
};

class LinkError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    response.end(JSON.stringify(value));
}

async function bodyOf(request) {
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new LinkError(415, '此接口需要 JSON。');
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new LinkError(400, 'JSON 数据无效。'); }
    if (!object(value)) throw new LinkError(400, '请求内容必须是对象。');
    return value;
}

function pngInfo(bytes) {
    // Match the existing local adapter's PNG signature/IHDR check; Qt performs actual decoding.
    if (bytes.length <= 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
        throw new LinkError(502, '图片不是有效 PNG。');
    }
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) throw new LinkError(502, 'PNG 图片尺寸无效。');
    return { width, height, sha256: digest(bytes) };
}

function decodePng(value, expected) {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new LinkError(502, 'Krita 返回的 PNG 编码无效。');
    }
    const bytes = Buffer.from(value, 'base64');
    const info = pngInfo(bytes);
    if (!SHA.test(expected.sha256 || '') || info.sha256 !== expected.sha256 ||
        info.width !== expected.width || info.height !== expected.height) {
        throw new LinkError(502, '图片内容与尺寸或 SHA-256 不一致。');
    }
    return bytes;
}

async function atomicJson(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
}

async function storedJson(path) {
    try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new LinkError(500, '本机记录位置无效。');
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function snapshotOf(value) {
    if (!object(value) || !validId(value.id) || !['sessionId', 'documentId', 'documentName', 'colorModel', 'colorDepth', 'colorProfile', 'createdAt']
        .every((key) => typeof value[key] === 'string' && value[key]) ||
        !Number.isSafeInteger(value.width) || value.width <= 0 || !Number.isSafeInteger(value.height) || value.height <= 0 ||
        (value.layerId !== undefined && (typeof value.layerId !== 'string' || !value.layerId))) {
        throw new LinkError(502, 'Krita 快照信息无效。');
    }
    return { id: value.id, sessionId: value.sessionId, documentId: value.documentId, documentName: value.documentName,
        ...(value.layerId ? { layerId: layerIdOf(value.layerId) } : {}), width: value.width, height: value.height,
        colorModel: value.colorModel, colorDepth: value.colorDepth, colorProfile: value.colorProfile,
        sha256: value.sha256, createdAt: value.createdAt };
}

function publicSnapshot(value) {
    return { ...value, imageUrl: `/krita-link/snapshots/${value.id}/image` };
}

function publicJob(job) {
    return { id: job.id, status: job.status, snapshotId: job.snapshotId, request: job.request,
        createdAt: job.createdAt, finishedAt: job.finishedAt, promptId: job.promptId,
        ...(job.error ? { error: job.error } : {}), images: (job.images || []).map((item) => ({
            id: item.id, url: `/krita-link/generations/${job.id}/images/${item.id}`,
            width: item.width, height: item.height, sha256: item.sha256,
        })) };
}

function graphOf(snapshot, request, uploaded, jobId) {
    const params = request.params;
    // VAE inputs need a multiple of eight. The final image returns to the exact Krita dimensions.
    const width = Math.max(8, Math.round(snapshot.width / 8) * 8);
    const height = Math.max(8, Math.round(snapshot.height / 8) * 8);
    return {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: request.model } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: request.prompt, clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: request.negativePrompt, clip: ['1', 1] } },
        '4': { class_type: 'LoadImage', inputs: { image: uploaded } },
        '5': { class_type: 'ImageScale', inputs: { image: ['4', 0], width, height, upscale_method: 'lanczos', crop: 'disabled' } },
        '6': { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['1', 2] } },
        '7': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['6', 0],
            seed: params.seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: params.denoise } },
        '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
        '9': { class_type: 'ImageScale', inputs: { image: ['8', 0], width: snapshot.width, height: snapshot.height, upscale_method: 'lanczos', crop: 'disabled' } },
        '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: `InfiniteCanvas/Krita/${jobId}` } },
    };
}

export function createKritaBridge({ appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), fetchImpl = fetch, ensureComfy } = {}) {
    const root = join(appRoot, '.local', 'krita-link');
    const snapshotsRoot = join(root, 'snapshots'), jobsRoot = join(root, 'jobs'), returnsRoot = join(root, 'returns');
    const locks = new Map();
    const submissions = new Set();
    const serialize = async (key, action) => {
        const before = locks.get(key) || Promise.resolve();
        const current = before.catch(() => {}).then(action);
        locks.set(key, current);
        try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
    };
    const ensure = () => Promise.all([snapshotsRoot, jobsRoot, returnsRoot].map((path) => mkdir(path, { recursive: true })));

    async function remote(url, options, label) {
        let response;
        try { response = await fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit' }); }
        catch { throw new LinkError(503, `${label} 未连接，请打开相应应用后手动重试。`); }
        let value;
        try { value = await response.json(); }
        catch { throw new LinkError(502, `${label} 返回的数据无效。`); }
        if (!response.ok) throw new LinkError(response.status === 409 ? 409 : 502,
            typeof value?.error === 'string' ? value.error : `${label} 拒绝了本次操作。`);
        return value;
    }

    async function native(path, body) {
        let connection;
        try { connection = await storedJson(join(root, 'connection.json')); }
        catch { throw new LinkError(503, 'Krita 本机连接配置暂不可读取，请重新打开 Krita 后手动连接。'); }
        if (connection?.version !== 1 || connection.port !== 3003 || typeof connection.token !== 'string' || !connection.token) {
            throw new LinkError(503, 'Krita 连接插件尚未启用，请在 Krita 中启用 Infinite Canvas Link。');
        }
        return remote(`${NATIVE}${path}`, { method: body === undefined ? 'GET' : 'POST',
            headers: { 'X-Infinite-Canvas-Krita': connection.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'Krita');
    }

    const comfy = (path, body) => remote(`${COMFY}${path}`, { method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }, 'ComfyUI');

    async function options() {
        await ensureComfy?.();
        const info = await comfy('/object_info');
        const models = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
        const samplers = info.KSampler?.input?.required?.sampler_name?.[0];
        const schedulers = info.KSampler?.input?.required?.scheduler?.[0];
        if (![models, samplers, schedulers].every((items) => Array.isArray(items) && items.every((item) => typeof item === 'string'))) {
            throw new LinkError(502, 'ComfyUI 缺少当前预设需要的基础节点。');
        }
        return { models, samplers, schedulers };
    }

    async function loadSnapshot(id) {
        if (!validId(id)) throw new LinkError(400, '快照编号无效。');
        const value = await storedJson(join(snapshotsRoot, id, 'snapshot.json'));
        if (!value) throw new LinkError(404, '源图快照不存在，请手动同步 Krita。');
        const snapshot = snapshotOf(value);
        if (snapshot.id !== id) throw new LinkError(500, '本机快照记录损坏。');
        return snapshot;
    }

    async function imageBytes(path, expected) {
        let bytes;
        try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
            bytes = await readFile(path);
        } catch { throw new LinkError(500, '本机原图缺失或位置无效。'); }
        const info = pngInfo(bytes);
        if (info.sha256 !== expected.sha256 || info.width !== expected.width || info.height !== expected.height) {
            throw new LinkError(500, '本机原图校验失败，已保留文件供恢复。');
        }
        return bytes;
    }

    async function sendImage(response, path, expected) {
        const bytes = await imageBytes(path, expected);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
        response.end(bytes);
    }

    async function loadJob(id) {
        if (!validId(id)) throw new LinkError(400, '生成编号无效。');
        const job = await storedJson(join(jobsRoot, id, 'job.json'));
        if (!job) throw new LinkError(404, '生成记录不存在。');
        if (job.id !== id || !validId(job.snapshotId) || !['running', 'succeeded', 'failed'].includes(job.status) ||
            !object(job.request) || !Array.isArray(job.images) || job.images.some((image) => !validId(image.id))) {
            throw new LinkError(500, '本机生成记录损坏。');
        }
        return job;
    }

    const saveJob = (job) => atomicJson(join(jobsRoot, job.id, 'job.json'), job);

    async function startGeneration(data) {
        const snapshot = await loadSnapshot(data.snapshotId);
        if (typeof data.prompt !== 'string' || !data.prompt.trim() ||
            (data.negativePrompt !== undefined && typeof data.negativePrompt !== 'string')) {
            throw new LinkError(400, '请输入提示词，负向提示词必须是文本。');
        }
        const preset = PRESETS.find((entry) => entry.id === data.presetId);
        if (!preset || !object(data.params)) throw new LinkError(400, '请选择有效预设和生成参数。');
        const params = { ...preset.defaults, ...data.params };
        if (params.seed === undefined || params.seed === -1) params.seed = randomInt(0, 2 ** 32);
        if (!Number.isSafeInteger(params.steps) || params.steps <= 0 || !Number.isFinite(params.cfg) || params.cfg < 0 ||
            !Number.isFinite(params.denoise) || params.denoise < 0 || params.denoise > 1 ||
            !Number.isSafeInteger(params.seed) || params.seed < 0) throw new LinkError(400, '生成参数无效，请检查步数、CFG、重绘强度和种子。');
        const available = await options();
        if (!available.models.includes(data.model)) throw new LinkError(400, '所选模型当前不可用，请手动选择已有模型。');
        if (!available.samplers.includes(params.sampler) || !available.schedulers.includes(params.scheduler)) {
            throw new LinkError(400, '所选采样器或调度器当前不可用，请手动修改。');
        }
        const request = { backend: 'comfy', documentId: snapshot.documentId, documentName: snapshot.documentName, sessionId: snapshot.sessionId,
            sourceWidth: snapshot.width, sourceHeight: snapshot.height,
            ...(snapshot.layerId ? { layerId: snapshot.layerId } : {}), prompt: data.prompt, negativePrompt: data.negativePrompt || '',
            model: data.model, presetId: preset.id,
            params: { steps: params.steps, cfg: params.cfg, denoise: params.denoise, seed: params.seed, sampler: params.sampler, scheduler: params.scheduler } };
        const bytes = await imageBytes(join(snapshotsRoot, snapshot.id, 'image.png'), snapshot);
        const job = { id: randomUUID(), status: 'running', snapshotId: snapshot.id, request,
            createdAt: new Date().toISOString(), images: [] };
        await mkdir(join(jobsRoot, job.id));
        submissions.add(job.id);
        try {
            await saveJob(job);
            const form = new FormData();
            form.append('image', new Blob([bytes], { type: 'image/png' }), `${snapshot.id}.png`);
            form.append('subfolder', 'InfiniteCanvas/Krita');
            form.append('overwrite', 'false');
            const uploaded = await comfy('/upload/image', form);
            if (typeof uploaded.name !== 'string' || /[/\\]/.test(uploaded.name) || !uploaded.name.endsWith('.png') ||
                !comfyFolder(uploaded.subfolder)) throw new LinkError(502, 'ComfyUI 返回的输入图片位置无效。');
            const submitted = await comfy('/prompt', { prompt: graphOf(snapshot, request, `${COMFY_FOLDER}/${uploaded.name}`, job.id), client_id: job.id });
            if (!validId(submitted.prompt_id)) throw new LinkError(502, 'ComfyUI 未返回有效任务编号，请检查队列；不会自动重新提交。');
            job.promptId = submitted.prompt_id;
        } catch (error) {
            job.status = 'failed';
            job.error = `${error.message} 未自动重新提交；若提交过程曾中断，请先检查 ComfyUI 队列。`;
            job.finishedAt = new Date().toISOString();
        }
        try { await saveJob(job); } finally { submissions.delete(job.id); }
        return job;
    }

    async function importExternal(data) {
        const snapshot = await loadSnapshot(data.snapshotId);
        await imageBytes(join(snapshotsRoot, snapshot.id, 'image.png'), snapshot);
        if (typeof data.prompt !== 'string' || !data.prompt.trim() || typeof data.model !== 'string' || !data.model.trim() ||
            !Array.isArray(data.images) || !data.images.length) throw new LinkError(400, '请提供提示词、生成渠道模型和 PNG 结果。');
        const decoded = data.images.map((value) => {
            const match = typeof value === 'string' && /^data:image\/png;base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(value);
            if (!match) throw new LinkError(400, '生成结果必须是 PNG data URL，不接受文件路径或远程地址。');
            const bytes = Buffer.from(match[1], 'base64');
            try { return { bytes, image: { id: randomUUID(), ...pngInfo(bytes) } }; }
            catch { throw new LinkError(400, '生成结果不是有效 PNG。'); }
        });
        const job = { id: randomUUID(), status: 'succeeded', snapshotId: snapshot.id,
            createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
            request: { backend: 'configured', documentId: snapshot.documentId, documentName: snapshot.documentName,
                sessionId: snapshot.sessionId, sourceWidth: snapshot.width, sourceHeight: snapshot.height,
                ...(snapshot.layerId ? { layerId: snapshot.layerId } : {}),
                model: data.model, prompt: data.prompt, params: {} }, images: decoded.map(({ image }) => image) };
        await mkdir(join(jobsRoot, job.id));
        const directory = join(jobsRoot, job.id, 'images');
        await mkdir(directory);
        for (const { bytes, image } of decoded) await writeFile(join(directory, `${image.id}.png`), bytes, { mode: 0o600, flag: 'wx' });
        await saveJob(job);
        return job;
    }

    async function refreshJob(id) {
        return serialize(`generation:${id}`, async () => {
            const job = await loadJob(id);
            if (job.status === 'succeeded' || (job.status === 'failed' && !validId(job.promptId))) return job;
            if (submissions.has(id)) return job;
            if (!validId(job.promptId)) {
                job.status = 'failed';
                job.error = '本机服务曾在提交过程中中断。为避免重复生成，未重新提交；请先检查 ComfyUI 队列。';
                job.finishedAt = new Date().toISOString();
                await saveJob(job);
                return job;
            }
            // Connectivity failures leave the original job running so an explicit refresh can recover it.
            const history = await comfy(`/history/${job.promptId}`);
            const entry = history[job.promptId];
            if (!entry) return job;
            try {
                if (entry.status?.status_str === 'error') {
                    const failure = entry.status.messages?.find(([kind]) => kind === 'execution_error' || kind === 'execution_interrupted');
                    throw new Error(failure?.[1]?.exception_message || 'ComfyUI 任务被中断。');
                }
                const outputs = entry.outputs?.['10']?.images;
                if (!outputs && !entry.status?.completed) return job;
                if (!Array.isArray(outputs) || !outputs.length) throw new Error('ComfyUI 未返回当前预设的生成图片。');
                const snapshot = await loadSnapshot(job.snapshotId);
                const imagesRoot = join(jobsRoot, id, 'images');
                await mkdir(imagesRoot, { recursive: true });
                const images = [];
                for (const output of outputs) {
                    if (typeof output.filename !== 'string' || /[/\\]/.test(output.filename) || !output.filename.endsWith('.png') ||
                        !comfyFolder(output.subfolder) || output.type !== 'output') throw new Error('ComfyUI 生成图片位置无效。');
                    let response;
                    try {
                        response = await fetchImpl(`${COMFY}/view?${new URLSearchParams({ filename: output.filename, subfolder: COMFY_FOLDER, type: 'output' })}`,
                            { redirect: 'error', credentials: 'omit' });
                    } catch { throw new LinkError(503, 'ComfyUI 原图暂不可读取，请稍后手动刷新此任务。'); }
                    if (!response.ok) throw new LinkError(503, 'ComfyUI 原图暂不可读取，请稍后手动刷新此任务。');
                    const bytes = Buffer.from(await response.arrayBuffer());
                    const info = pngInfo(bytes);
                    if (info.width !== snapshot.width || info.height !== snapshot.height) throw new Error('生成结果尺寸与原 Krita 快照不一致，已停止回传。');
                    const image = { id: randomUUID(), ...info };
                    await writeFile(join(imagesRoot, `${image.id}.png`), bytes, { mode: 0o600, flag: 'wx' });
                    images.push(image);
                }
                job.images = images;
                job.status = 'succeeded';
                if (job.error) {
                    job.previousErrors = [...(job.previousErrors || []), job.error];
                    delete job.error;
                }
            } catch (error) {
                if (error instanceof LinkError && error.status === 503) throw error;
                job.status = 'failed';
                job.error = error.message;
            }
            job.finishedAt = new Date().toISOString();
            await saveJob(job);
            return job;
        });
    }

    async function sendBack(data) {
        if (!validId(data.generationId) || !validId(data.imageId) || !validId(data.commandId)) throw new LinkError(400, '回传编号无效。');
        if (data.fitToCanvas !== undefined && typeof data.fitToCanvas !== 'boolean') throw new LinkError(400, '回传缩放选项无效。');
        const fitToCanvas = data.fitToCanvas === true;
        return serialize(`return:${data.commandId}`, async () => {
            const path = join(returnsRoot, `${data.commandId}.json`);
            const previous = await storedJson(path);
            if (previous && (previous.generationId !== data.generationId || previous.imageId !== data.imageId ||
                (previous.fitToCanvas === true) !== fitToCanvas)) {
                throw new LinkError(409, '此回传指令已绑定另一张图片或缩放方式，请刷新状态。');
            }
            if (previous?.ack) return previous.ack;
            const job = await loadJob(data.generationId);
            const image = job.images.find((entry) => entry.id === data.imageId);
            if (job.status !== 'succeeded' || !image) throw new LinkError(409, '生成原图尚未准备好。');
            const snapshot = await loadSnapshot(job.snapshotId);
            if (!fitToCanvas && (image.width !== snapshot.width || image.height !== snapshot.height)) {
                throw new LinkError(409, '原图尺寸与 Krita 源图不同，请明确选择缩放回传副本；存档原图保持不变。');
            }
            const bytes = await imageBytes(join(jobsRoot, job.id, 'images', `${image.id}.png`), image);
            const command = { commandId: data.commandId, generationId: job.id, imageId: image.id, snapshotId: snapshot.id, fitToCanvas };
            await atomicJson(path, command);
            const ack = await native('/apply', { commandId: data.commandId, snapshotId: snapshot.id,
                imageBase64: bytes.toString('base64'), sha256: image.sha256, fitToCanvas, layerName: `Infinite Canvas · ${job.request.documentName}` });
            if (!object(ack) || ack.commandId !== data.commandId || ack.documentId !== snapshot.documentId || typeof ack.layerId !== 'string' || !ack.layerId) {
                throw new LinkError(502, 'Krita 回传确认无效。请检查文档；重复同一指令不会再次添加图层。');
            }
            const result = { commandId: data.commandId, documentId: ack.documentId, layerId: ack.layerId };
            await atomicJson(path, { ...command, ack: result });
            return result;
        });
    }

    return { async handle(request, response, path) {
        if (path !== '/krita' && !path.startsWith('/krita/')) return false;
        try {
            if (request.headers['x-infinite-canvas-krita-ui'] !== '1' ||
                (request.method === 'POST' && request.headers.origin !== ORIGIN)) {
                throw new LinkError(403, '请从本机无限画布访问 Krita 连接。');
            }
            await ensure();
            if (request.method === 'GET' && path === '/krita/status') {
                try {
                    const value = await native('/status');
                    if (!object(value) || value.version !== 1 || typeof value.sessionId !== 'string' || !value.sessionId || !Array.isArray(value.documents)) {
                        throw new LinkError(502, 'Krita 连接信息无效。');
                    }
                    const documents = value.documents.map((doc) => {
                        if (!object(doc) || !['id', 'name', 'colorModel', 'colorDepth', 'colorProfile'].every((key) => typeof doc[key] === 'string') ||
                            !Number.isSafeInteger(doc.width) || doc.width <= 0 || !Number.isSafeInteger(doc.height) || doc.height <= 0 || !Array.isArray(doc.layers)) {
                            throw new LinkError(502, 'Krita 文档信息无效。');
                        }
                        return { id: doc.id, name: doc.name, width: doc.width, height: doc.height,
                            colorModel: doc.colorModel, colorDepth: doc.colorDepth, colorProfile: doc.colorProfile,
                            layers: doc.layers.map((layer) => {
                                if (!object(layer) || !['id', 'name', 'type'].every((key) => typeof layer[key] === 'string')) throw new LinkError(502, 'Krita 图层信息无效。');
                                return { id: layerIdOf(layer.id), name: layer.name, type: layer.type };
                            }) };
                    });
                    json(response, 200, { connected: true, version: 1, sessionId: value.sessionId, documents });
                } catch (error) { json(response, 200, { connected: false, documents: [], error: error.message }); }
                return true;
            }
            if (request.method === 'GET' && path === '/krita/presets') {
                const base = { presets: PRESETS, supported: ['prompt', 'negativePrompt', 'model', 'steps', 'cfg', 'denoise', 'seed', 'sampler', 'scheduler'] };
                try { json(response, 200, { ...base, ...await options(), available: true }); }
                catch (error) { json(response, 200, { ...base, models: [], samplers: [], schedulers: [], available: false, error: error.message }); }
                return true;
            }
            if (request.method === 'POST' && path === '/krita/snapshots') {
                const data = await bodyOf(request);
                if (typeof data.documentId !== 'string' || !data.documentId ||
                    (data.layerId !== undefined && (typeof data.layerId !== 'string' || !data.layerId))) throw new LinkError(400, '请选择 Krita 文档和有效图层。');
                const layerId = layerIdOf(data.layerId);
                const raw = await native('/snapshot', { documentId: data.documentId, ...(layerId ? { layerId } : {}) });
                const snapshot = snapshotOf(raw), bytes = decodePng(raw.imageBase64, snapshot);
                if (snapshot.documentId !== data.documentId || snapshot.layerId !== layerId) throw new LinkError(502, 'Krita 返回了另一份文档或图层。');
                const directory = join(snapshotsRoot, snapshot.id);
                try { await mkdir(directory); }
                catch (error) { if (error.code === 'EEXIST') throw new LinkError(409, '此快照已存在，请重新手动同步。'); throw error; }
                await writeFile(join(directory, 'image.png'), bytes, { mode: 0o600, flag: 'wx' });
                await atomicJson(join(directory, 'snapshot.json'), snapshot);
                json(response, 201, publicSnapshot(snapshot));
                return true;
            }
            let match = /^\/krita\/snapshots\/([^/]+)\/image$/.exec(path);
            if (request.method === 'GET' && match) {
                const snapshot = await loadSnapshot(match[1]);
                await sendImage(response, join(snapshotsRoot, snapshot.id, 'image.png'), snapshot);
                return true;
            }
            if (request.method === 'POST' && path === '/krita/generations') {
                json(response, 201, publicJob(await startGeneration(await bodyOf(request))));
                return true;
            }
            if (request.method === 'POST' && path === '/krita/generations/external') {
                json(response, 201, publicJob(await importExternal(await bodyOf(request))));
                return true;
            }
            if (request.method === 'GET' && path === '/krita/generations') {
                const jobs = [];
                for (const entry of await readdir(jobsRoot, { withFileTypes: true })) {
                    if (!entry.isDirectory() || entry.isSymbolicLink() || !validId(entry.name)) continue;
                    try { jobs.push(publicJob(await loadJob(entry.name))); }
                    catch (error) { if (!(error instanceof LinkError && error.status === 404)) throw error; }
                }
                json(response, 200, { generations: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
                return true;
            }
            match = /^\/krita\/generations\/([^/]+)$/.exec(path);
            if (request.method === 'GET' && match) {
                json(response, 200, publicJob(await refreshJob(match[1])));
                return true;
            }
            match = /^\/krita\/generations\/([^/]+)\/images\/([^/]+)$/.exec(path);
            if (request.method === 'GET' && match) {
                const job = await loadJob(match[1]);
                if (!validId(match[2])) throw new LinkError(400, '原图编号无效。');
                const image = job.images.find((entry) => entry.id === match[2]);
                if (!image || job.status !== 'succeeded') throw new LinkError(404, '生成原图不存在。');
                await sendImage(response, join(jobsRoot, job.id, 'images', `${image.id}.png`), image);
                return true;
            }
            if (request.method === 'POST' && path === '/krita/returns') {
                json(response, 200, await sendBack(await bodyOf(request)));
                return true;
            }
            throw new LinkError(404, 'Krita 接口不存在。');
        } catch (error) {
            json(response, error instanceof LinkError ? error.status : 500,
                { error: error instanceof LinkError ? error.message : '本机 Krita 记录读写失败，请保留 .local/krita-link 并检查服务状态。' });
        }
        return true;
    } };
}
