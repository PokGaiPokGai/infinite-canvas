// Fixed canvas operations over the existing loopback BlenderMCP add-on protocol.
import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = value => typeof value === 'string' && UUID.test(value);
function destinationOf(value) {
    if (value?.kind === 'image' && validId(value.imageId) && typeof value.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(value.expectedRevision)) return { kind: 'image', imageId: value.imageId, expectedRevision: value.expectedRevision };
    if (value?.kind === 'new' && typeof value.name === 'string' && value.name.trim()) return { kind: 'new', name: value.name.trim() };
    if (value?.kind === 'node' && validId(value.targetId) && (value.expectedImageId === null || validId(value.expectedImageId))) return { kind: 'node', targetId: value.targetId, expectedImageId: value.expectedImageId };
    throw new LinkError(400, '写回目标无效。');
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
class LinkError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function sendBlenderCommand(type, params = {}) {
    return new Promise((resolveCommand, reject) => {
        const decoder = new StringDecoder('utf8');
        let text = '', completed = false;
        const socket = createConnection({ host: '127.0.0.1', port: 9876 }, () => socket.write(JSON.stringify({ type, params })));
        const finish = (error, value) => {
            if (completed) return;
            completed = true;
            socket.destroy();
            error ? reject(error) : resolveCommand(value);
        };
        // Same receive timeout as the already installed BlenderMCP client, with no retry.
        socket.setTimeout(180_000, () => finish(new LinkError(504, 'BlenderMCP 等待超时；操作可能已执行，请核对后重试同一指令。')));
        socket.on('data', chunk => {
            text += decoder.write(chunk);
            let response;
            try { response = JSON.parse(text); } catch { return; }
            if (response.status !== 'success') return finish(new LinkError(502, response.message || 'BlenderMCP 拒绝了操作。'));
            finish(null, response.result);
        });
        socket.on('error', () => finish(new LinkError(503, 'BlenderMCP 未连接，请在 Blender 的 MCP for Blender 面板启动服务（9876）。')));
        socket.on('close', () => { if (!completed) finish(new LinkError(502, 'BlenderMCP 连接已中断，未自动重试。')); });
    });
}

function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
}

async function bodyOf(request) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new LinkError(415, '此接口需要 JSON。');
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LinkError(400, 'JSON 数据无效。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LinkError(400, '请求内容必须是对象。');
    return value;
}

function png(value) {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new LinkError(400, 'PNG 编码无效。');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length <= 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new LinkError(400, '图片不是有效 PNG。');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) throw new LinkError(400, 'PNG 尺寸无效。');
    return { bytes, width, height, sha256: digest(bytes) };
}

async function storedJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    await rename(temporary, path);
}

export function createBlenderBridge({ appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), commandImpl = sendBlenderCommand, canvasOrigin = 'http://127.0.0.1:3000' } = {}) {
    const root = join(appRoot, '.local', 'blender-link');
    let queue = Promise.resolve();
    const serialize = action => {
        const next = queue.catch(() => {}).then(action);
        queue = next;
        return next;
    };
    const execute = async payload => {
        const script = await readFile(new URL('./blender-commands.py', import.meta.url), 'utf8');
        // Only validated data is inserted as base64. Browsers cannot supply Python.
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
        const code = `${script}\nprint('__IC_BLENDER__' + json.dumps(run(json.loads(base64.b64decode('${encoded}'))), ensure_ascii=True))`;
        const response = await commandImpl('execute_code', { code });
        let result;
        try { result = JSON.parse(response.result.split('__IC_BLENDER__').at(-1)); }
        catch { throw new LinkError(502, 'BlenderMCP 返回的数据无效。'); }
        if (result.error) throw new LinkError(result.status || 502, result.error);
        return result;
    };

    return { async handle(request, response, path) {
        if (path !== '/blender' && !path.startsWith('/blender/')) return false;
        try {
            if (![new URL(canvasOrigin).host, '127.0.0.1:3002'].includes(request.headers.host) ||
                (request.headers.origin && request.headers.origin !== canvasOrigin) ||
                (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') ||
                request.headers['x-infinite-canvas-blender-ui'] !== '1') throw new LinkError(403, '仅允许本机画布访问。');
            await serialize(async () => {
                if (request.method === 'GET' && path === '/blender/status') {
                    try { json(response, 200, await execute({ operation: 'status' })); }
                    catch (error) { if (error.status !== 503) throw error; json(response, 200, { connected: false, version: 1, sources: [], targets: [], images: [], error: error.message }); }
                    return;
                }
                if (request.method === 'POST' && path === '/blender/image-preview') {
                    const data = await bodyOf(request);
                    if (!validId(data.sessionId) || !validId(data.imageId)) throw new LinkError(400, '贴图绑定无效。');
                    const result = await execute({ operation: 'image-preview', sessionId: data.sessionId, imageId: data.imageId });
                    const image = png(result.imageBase64);
                    if (result.sessionId !== data.sessionId || result.imageId !== data.imageId || !/^[a-f0-9]{64}$/.test(result.revision) || result.width !== image.width || result.height !== image.height) throw new LinkError(502, '贴图预览校验失败。');
                    json(response, 200, result);
                    return;
                }
                const match = path.match(/^\/blender\/snapshots\/([0-9a-f-]+)\/image$/i);
                if (request.method === 'GET' && match && validId(match[1])) {
                    let bytes;
                    try { bytes = await readFile(join(root, 'snapshots', `${match[1]}.png`)); } catch (error) { if (error.code === 'ENOENT') throw new LinkError(404, '快照不存在。'); throw error; }
                    response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(bytes);
                    return;
                }
                if (request.method === 'POST' && path === '/blender/snapshots') {
                    const data = await bodyOf(request);
                    if (!validId(data.sessionId) || !validId(data.sourceId)) throw new LinkError(400, '读取绑定无效。');
                    const result = await execute({ operation: 'snapshot', sessionId: data.sessionId, sourceId: data.sourceId });
                    const image = png(result.imageBase64);
                    if (image.sha256 !== result.sha256 || image.width !== result.width || image.height !== result.height || result.sessionId !== data.sessionId || result.sourceId !== data.sourceId) throw new LinkError(502, 'Blender 快照校验失败。');
                    const id = randomUUID();
                    await mkdir(join(root, 'snapshots'), { recursive: true });
                    await writeFile(join(root, 'snapshots', `${id}.png`), image.bytes, { flag: 'wx' });
                    const { imageBase64, ...metadata } = result;
                    const snapshot = { ...metadata, id, createdAt: new Date().toISOString(), imageUrl: `/blender-link/snapshots/${id}/image` };
                    await atomicJson(join(root, 'snapshots', `${id}.json`), snapshot);
                    json(response, 201, snapshot);
                    return;
                }
                if (request.method === 'POST' && path === '/blender/returns') {
                    const data = await bodyOf(request);
                    if (![data.sessionId, data.commandId].every(validId) || !['sRGB', 'Non-Color'].includes(data.colorSpace)) throw new LinkError(400, '写回目标或色彩用途无效。');
                    const destination = destinationOf(data.destination);
                    const image = png(data.imageBase64);
                    const payload = { operation: 'write', commandId: data.commandId, sessionId: data.sessionId, destination, colorSpace: data.colorSpace, imageBase64: data.imageBase64, width: image.width, height: image.height, sha256: image.sha256 };
                    const fingerprint = digest(JSON.stringify(payload));
                    const folder = join(root, 'returns'), recordPath = join(folder, `${data.commandId}.json`);
                    await mkdir(folder, { recursive: true });
                    const record = await storedJson(recordPath);
                    if (record && record.fingerprint !== fingerprint) throw new LinkError(409, '同一写回指令不能更换图片或目标。');
                    if (record?.result) { json(response, 200, record.result); return; }
                    if (!record) {
                        await writeFile(join(folder, `${data.commandId}.png`), image.bytes, { flag: 'wx' });
                        await atomicJson(recordPath, { fingerprint, sessionId: data.sessionId, destination, createdAt: new Date().toISOString() });
                    }
                    const result = await execute(payload);
                    if (result.commandId !== data.commandId || result.sessionId !== data.sessionId || JSON.stringify(result.destination) !== JSON.stringify(destination) || result.sha256 !== image.sha256 || !validId(result.imageId)) throw new LinkError(502, '写回回执无效；请检查 Blender 后重试同一指令。');
                    const receipt = { ...result, returnedAt: new Date().toISOString() };
                    await atomicJson(recordPath, { fingerprint, result: receipt });
                    json(response, 200, receipt);
                    return;
                }
                throw new LinkError(404, 'Blender Link 接口不存在。');
            });
        } catch (error) { json(response, error.status || 500, { error: error.status ? error.message : 'Blender Link 无法完成操作，未自动重试。' }); }
        return true;
    } };
}
