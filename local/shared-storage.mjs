import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGIN = 'http://127.0.0.1:3000';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytesOf = (value) => Buffer.from(JSON.stringify(value));
const jsonOf = (value) => JSON.parse(Buffer.from(value).toString('utf8'));

class StorageError extends Error {
    constructor(status, message, details = {}) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

function namespaceOf(value) {
    let parts;
    try { parts = JSON.parse(value); } catch { /* validated below */ }
    if (!Array.isArray(parts) || parts.length !== 2 || !parts.every((part) => typeof part === 'string' && part)) {
        throw new StorageError(400, '存储命名空间无效。');
    }
    return JSON.stringify(parts);
}

function itemLocation(url) {
    if (!url.searchParams.has('namespace') || !url.searchParams.has('key')) throw new StorageError(400, '缺少存储位置。');
    return { namespace: namespaceOf(url.searchParams.get('namespace')), key: url.searchParams.get('key') };
}

function clientOf(request) {
    const client = request.headers['x-storage-client'];
    if (typeof client !== 'string' || !UUID.test(client)) throw new StorageError(400, '客户端标识无效。');
    return client;
}

function expectedRevision(request) {
    const value = request.headers['if-match'];
    const match = typeof value === 'string' && /^(?:"(\d+)"|(\d+))$/.exec(value);
    const revision = match ? Number(match[1] ?? match[2]) : NaN;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new StorageError(428, '保存必须携带已读取的版本号。');
    return revision;
}

async function readBytes(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function readJson(request) {
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new StorageError(415, '此接口需要 JSON。');
    }
    const body = await readBytes(request);
    try { return { body, value: jsonOf(body) }; }
    catch { throw new StorageError(400, 'JSON 数据无效。'); }
}

async function readItem(request) {
    const kind = request.headers['x-storage-kind'];
    if (kind !== 'json' && kind !== 'blob') throw new StorageError(400, '存储数据类型无效。');
    let body, value, baseValue, context = null;
    let mimeType = request.headers['content-type'] || 'application/octet-stream';
    if (/[\r\n]/.test(mimeType)) throw new StorageError(400, '文件类型无效。');
    const envelope = request.headers['x-storage-envelope'];
    if (envelope !== undefined && envelope !== '1') throw new StorageError(400, '保存封装格式无效。');
    if (kind === 'json') {
        const parsed = await readJson(request);
        body = parsed.body;
        value = parsed.value;
        mimeType = 'application/json';
        if (envelope === '1') {
            if (!object(value) || !own(value, 'value') || !own(value, 'baseValue')) throw new StorageError(400, '保存封装缺少原值或新值。');
            context = body;
            baseValue = value.baseValue;
            value = value.value;
            body = bytesOf(value);
        }
    } else {
        if (envelope) throw new StorageError(400, '二进制文件不使用 JSON 保存封装。');
        body = await readBytes(request);
    }
    return { kind, mimeType, body, value, baseValue, context, envelope: envelope === '1', hash: createHash('sha256').update(body).digest('hex') };
}

function mergeFields(namespace, key) {
    if (namespace !== JSON.stringify(['infinite-canvas', 'app_state'])) return null;
    if (key === 'infinite-canvas:canvas_store') return ['projects', 'deletedProjects'];
    if (key === 'infinite-canvas:asset_store') return ['assets'];
    if (key === 'infinite-canvas:plugin_store') return ['plugins'];
    return null;
}

function canonicalValue(namespace, key, value) {
    if (namespace !== JSON.stringify(['infinite-canvas', 'app_state']) ||
        !['infinite-canvas:canvas_store', 'infinite-canvas:asset_store'].includes(key)) return value;
    const encoded = typeof value === 'string';
    let data = value;
    if (encoded) {
        try { data = JSON.parse(value); } catch { return value; }
    }
    if (!object(data) || !object(data.state)) return value;
    const normalize = (entry) => {
        if (Array.isArray(entry)) return entry.map(normalize);
        if (!object(entry)) return entry;
        const linked = typeof entry.storageKey === 'string' || typeof entry.metadata?.storageKey === 'string' || typeof entry.data?.storageKey === 'string';
        return Object.fromEntries(Object.entries(entry).map(([field, child]) => [field,
            linked && ['url', 'dataUrl', 'content', 'coverUrl'].includes(field) && typeof child === 'string' && child.startsWith('blob:') ? '' : normalize(child)]));
    };
    const normalized = { ...data, state: normalize(data.state) };
    return encoded ? JSON.stringify(normalized) : normalized;
}

function canonicalItem(namespace, key, item) {
    if (item.kind !== 'json') return item;
    const value = canonicalValue(namespace, key, item.value);
    const baseValue = item.envelope ? canonicalValue(namespace, key, item.baseValue) : item.baseValue;
    if (isDeepStrictEqual(value, item.value) && isDeepStrictEqual(baseValue, item.baseValue)) return item;
    const body = bytesOf(value);
    return { ...item, value, baseValue, body, hash: createHash('sha256').update(body).digest('hex'), context: item.context || item.body };
}

function appState(value, fields) {
    const encoded = typeof value === 'string';
    let data = value;
    if (encoded) {
        try { data = JSON.parse(value); } catch { return null; }
    }
    if (!object(data) || !object(data.state)) return null;
    const maps = new Map();
    const lists = new Map();
    const ids = new Set();
    for (const field of fields) {
        const list = data.state[field] ?? [];
        if (!Array.isArray(list)) return null;
        const map = new Map();
        for (const item of list) {
            if (!object(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) return null;
            map.set(item.id, item);
            ids.add(item.id);
        }
        maps.set(field, map);
        lists.set(field, list);
    }
    const extraState = Object.fromEntries(Object.entries(data.state).filter(([key]) => !fields.includes(key)));
    const extra = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'state'));
    return { encoded, data, maps, lists, ids, extra: { extra, extraState } };
}

function entityAt(view, fields, id) {
    return fields.map((field) => view.maps.get(field).get(id));
}

function orderChanged(base, next, retained) {
    return !isDeepStrictEqual(base.filter((id) => retained.has(id)), next.filter((id) => retained.has(id)));
}

function includeMissing(order, other, available) {
    const result = order.filter((id) => available.has(id));
    for (let i = 0; i < other.length; i++) {
        const id = other[i];
        if (!available.has(id) || result.includes(id)) continue;
        const successor = other.slice(i + 1).find((candidate) => result.includes(candidate));
        if (successor !== undefined) result.splice(result.indexOf(successor), 0, id);
        else result.push(id);
    }
    for (const id of available) if (!result.includes(id)) result.push(id);
    return result;
}

function composeState(current, fields, maps, orders) {
    const state = { ...current.data.state };
    for (const field of fields) state[field] = orders.get(field).map((id) => maps.get(field).get(id));
    const value = { ...current.data, state };
    return current.encoded ? JSON.stringify(value) : value;
}

// Only IDs changed between the client's last local view and its new view are writable.
function threeWay(namespace, key, baseValue, nextValue, currentValue) {
    const fields = mergeFields(namespace, key);
    if (!fields) return null;
    const base = appState(canonicalValue(namespace, key, baseValue), fields);
    const next = appState(canonicalValue(namespace, key, nextValue), fields);
    const current = appState(canonicalValue(namespace, key, currentValue), fields);
    if (!base || !next || !current || base.encoded !== next.encoded || next.encoded !== current.encoded ||
        !isDeepStrictEqual(base.extra, next.extra) || !isDeepStrictEqual(base.extra, current.extra)) return null;
    const maps = new Map(fields.map((field) => [field, new Map(current.maps.get(field))]));
    const ids = new Set([...base.ids, ...next.ids]);
    for (const id of ids) {
        const before = entityAt(base, fields, id), after = entityAt(next, fields, id), remote = entityAt(current, fields, id);
        if (isDeepStrictEqual(before, after)) continue;
        if (!isDeepStrictEqual(before, remote) && !isDeepStrictEqual(after, remote)) return null;
        fields.forEach((field, index) => {
            if (after[index] === undefined) maps.get(field).delete(id);
            else maps.get(field).set(id, after[index]);
        });
    }
    const orders = new Map();
    for (const field of fields) {
        const baseIds = base.lists.get(field).map(({ id }) => id);
        const nextIds = next.lists.get(field).map(({ id }) => id);
        const currentIds = current.lists.get(field).map(({ id }) => id);
        const retained = new Set(baseIds.filter((id) => next.maps.get(field).has(id) && current.maps.get(field).has(id)));
        const localOrder = orderChanged(baseIds, nextIds, retained);
        const remoteOrder = orderChanged(baseIds, currentIds, retained);
        if (localOrder && remoteOrder && !isDeepStrictEqual(nextIds.filter((id) => retained.has(id)), currentIds.filter((id) => retained.has(id)))) return null;
        orders.set(field, includeMissing(localOrder ? nextIds : currentIds, localOrder ? currentIds : nextIds, new Set(maps.get(field).keys())));
    }
    return { value: composeState(current, fields, maps, orders) };
}

// Import adds missing IDs. A differing existing ID stays on the server and the full source remains archived.
function unionImport(namespace, key, sourceValue, currentValue) {
    const fields = mergeFields(namespace, key);
    if (!fields) return null;
    const source = appState(canonicalValue(namespace, key, sourceValue), fields);
    const current = appState(canonicalValue(namespace, key, currentValue), fields);
    if (!source || !current || source.encoded !== current.encoded) return null;
    let conflict = !isDeepStrictEqual(source.extra, current.extra);
    const maps = new Map(fields.map((field) => [field, new Map(current.maps.get(field))]));
    for (const id of source.ids) {
        if (current.ids.has(id)) {
            if (!isDeepStrictEqual(entityAt(source, fields, id), entityAt(current, fields, id))) conflict = true;
            continue;
        }
        for (const field of fields) {
            const item = source.maps.get(field).get(id);
            if (item !== undefined) maps.get(field).set(id, item);
        }
    }
    const orders = new Map(fields.map((field) => [field, includeMissing(current.lists.get(field).map(({ id }) => id), source.lists.get(field).map(({ id }) => id), new Set(maps.get(field).keys()))]));
    return { value: composeState(current, fields, maps, orders), conflict };
}

/**
 * Final location: <fork>/local/shared-storage.mjs. No listener or external service is started.
 * Usage: const shared = createSharedStorage();
 *   if (await shared.handle(request, response, path)) return;
 * The existing bridge should keep its Host/Origin guard before this call and proxy /storage unchanged.
 * Tests may pass { dataDirectory: scratchPath }; close() closes SSE connections and SQLite.
 */
export function createSharedStorage({ dataDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'app-data') } = {}) {
    mkdirSync(dataDirectory, { recursive: true });
    const database = new DatabaseSync(join(dataDirectory, 'canvas.sqlite'));
    const schema = database.prepare('PRAGMA user_version').get().user_version;
    if (schema !== 0 && schema !== 1) {
        database.close();
        throw new Error('共享存储版本未知；未覆盖现有数据库。');
    }
    if (schema === 0 && database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().count !== 0) {
        database.close();
        throw new Error('共享数据库没有可识别的版本；未修改原有数据。');
    }
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO storage_meta VALUES ('revision', 0);
        CREATE TABLE IF NOT EXISTS storage_items (
            namespace TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('json', 'blob')), mime_type TEXT NOT NULL,
            body BLOB, hash TEXT, deleted INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (namespace, key)
        );
        CREATE TABLE IF NOT EXISTS storage_versions (
            id TEXT PRIMARY KEY, namespace TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER,
            kind TEXT NOT NULL, mime_type TEXT NOT NULL, body BLOB, hash TEXT,
            deleted INTEGER NOT NULL, event_kind TEXT NOT NULL, client_id TEXT NOT NULL,
            created_at TEXT NOT NULL, source_id TEXT, context BLOB
        );
        CREATE INDEX IF NOT EXISTS storage_versions_item ON storage_versions(namespace, key, revision);
        CREATE TABLE IF NOT EXISTS storage_imports (
            id TEXT PRIMARY KEY, client_id TEXT NOT NULL, status TEXT NOT NULL,
            created_at TEXT NOT NULL, source BLOB NOT NULL, result TEXT
        );
        CREATE TABLE IF NOT EXISTS storage_import_items (
            import_id TEXT NOT NULL REFERENCES storage_imports(id), namespace TEXT NOT NULL, key TEXT NOT NULL,
            kind TEXT NOT NULL, mime_type TEXT NOT NULL, body BLOB NOT NULL, hash TEXT NOT NULL,
            context BLOB, created_at TEXT NOT NULL,
            PRIMARY KEY (import_id, namespace, key)
        );
        PRAGMA user_version = 1;
        COMMIT;
    `);
    const subscribers = new Set();
    let closed = false;
    const revision = () => database.prepare("SELECT value FROM storage_meta WHERE key = 'revision'").get().value;
    const rowAt = (namespace, key) => database.prepare('SELECT * FROM storage_items WHERE namespace = ? AND key = ?').get(namespace, key);

    function transaction(action) {
        database.exec('BEGIN IMMEDIATE');
        try {
            const result = action();
            database.exec('COMMIT');
            return result;
        } catch (error) {
            database.exec('ROLLBACK');
            throw error;
        }
    }

    function archive(namespace, key, item, clientId, eventKind, version = null, sourceId = null) {
        const id = randomUUID();
        database.prepare(`INSERT INTO storage_versions
            (id, namespace, key, revision, kind, mime_type, body, hash, deleted, event_kind, client_id, created_at, source_id, context)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, namespace, key, version, item.kind, item.mimeType, item.body, item.hash, item.deleted ? 1 : 0,
                eventKind, clientId, new Date().toISOString(), sourceId, item.context || null);
        return id;
    }

    function write(namespace, key, item, clientId, eventKind = 'write', sourceId = null) {
        database.prepare("UPDATE storage_meta SET value = value + 1 WHERE key = 'revision'").run();
        const nextRevision = revision();
        archive(namespace, key, item, clientId, eventKind, nextRevision, sourceId);
        database.prepare(`INSERT INTO storage_items (namespace, key, revision, kind, mime_type, body, hash, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(namespace, key) DO UPDATE SET revision=excluded.revision, kind=excluded.kind,
                mime_type=excluded.mime_type, body=excluded.body, hash=excluded.hash, deleted=excluded.deleted`)
            .run(namespace, key, nextRevision, item.kind, item.mimeType, item.body, item.hash, item.deleted ? 1 : 0);
        return { namespace, key, revision: nextRevision, clientId, globalRevision: nextRevision };
    }

    function same(item, row) {
        if (!row || row.deleted || item.kind !== row.kind || item.mimeType !== row.mime_type) return false;
        if (item.hash === row.hash) return true;
        return item.kind === 'json' && isDeepStrictEqual(jsonOf(item.body), jsonOf(row.body));
    }

    function broadcast(events) {
        for (const event of events) {
            for (const subscriber of subscribers) {
                if (subscriber.destroyed) { subscribers.delete(subscriber); continue; }
                subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
            }
        }
    }

    function respond(response, status, value, headers = {}) {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', ...headers });
        response.end(JSON.stringify(value));
    }

    function rejectCandidate(namespace, key, item, clientId, currentRevision) {
        const conflictId = archive(namespace, key, item, clientId, 'conflict');
        return { conflict: true, currentRevision, conflictId };
    }

    function saveItem(namespace, key, item, expected, clientId) {
        item = canonicalItem(namespace, key, item);
        const canonicalNext = item.value;
        return transaction(() => {
            const current = rowAt(namespace, key);
            const currentRevision = current?.revision || 0;
            const fields = item.kind === 'json' && mergeFields(namespace, key);
            let merged = false;
            if (fields && item.envelope) {
                if (item.baseValue === null) {
                    if ((current && !current.deleted) || expected !== currentRevision) return rejectCandidate(namespace, key, item, clientId, currentRevision);
                } else {
                    if (!current || current.deleted || current.kind !== 'json') return rejectCandidate(namespace, key, item, clientId, currentRevision);
                    const result = threeWay(namespace, key, item.baseValue, item.value, jsonOf(current.body));
                    if (!result) return rejectCandidate(namespace, key, item, clientId, currentRevision);
                    item = { ...item, value: result.value, body: bytesOf(result.value) };
                    item.hash = createHash('sha256').update(item.body).digest('hex');
                    merged = !isDeepStrictEqual(result.value, canonicalNext) || expected !== currentRevision;
                }
            } else if (expected !== currentRevision) {
                const base = fields && current && !current.deleted && database.prepare(`SELECT * FROM storage_versions
                    WHERE namespace = ? AND key = ? AND revision = ? AND deleted = 0 AND kind = 'json'`).get(namespace, key, expected);
                const result = base && threeWay(namespace, key, jsonOf(base.body), item.value, jsonOf(current.body));
                if (!result) return rejectCandidate(namespace, key, item, clientId, currentRevision);
                item = { ...item, value: result.value, body: bytesOf(result.value) };
                item.hash = createHash('sha256').update(item.body).digest('hex');
                merged = true;
            }
            if (same(item, current)) return { revision: currentRevision, merged, value: item.kind === 'json' && merged ? item.value : undefined, events: [] };
            const event = write(namespace, key, item, clientId);
            return { revision: event.revision, merged, value: item.kind === 'json' && merged ? item.value : undefined, events: [event] };
        });
    }

    function importFor(id, clientId) {
        const session = database.prepare('SELECT * FROM storage_imports WHERE id = ?').get(id);
        if (!session) throw new StorageError(404, '未找到迁移会话。');
        if (session.client_id !== clientId) throw new StorageError(403, '迁移会话属于另一客户端。');
        return session;
    }

    function stageImport(id, namespace, key, item, clientId) {
        return transaction(() => {
            if (importFor(id, clientId).status !== 'staged') throw new StorageError(409, '迁移会话已经提交；未更改原备份。');
            const previous = database.prepare('SELECT * FROM storage_import_items WHERE import_id = ? AND namespace = ? AND key = ?').get(id, namespace, key);
            if (previous) {
                if (same(item, previous)) return { staged: true };
                const conflictId = archive(namespace, key, item, clientId, 'import-stage-conflict', null, id);
                return { conflict: true, conflictId };
            }
            database.prepare(`INSERT INTO storage_import_items
                (import_id, namespace, key, kind, mime_type, body, hash, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, namespace, key, item.kind, item.mimeType, item.body, item.hash, item.context, new Date().toISOString());
            return { staged: true };
        });
    }

    function commitImport(id, clientId) {
        return transaction(() => {
            const session = importFor(id, clientId);
            if (session.status === 'committed') return { ...JSON.parse(session.result), events: [] };
            const result = { imported: 0, identical: 0, conflicts: [], events: [] };
            for (const source of database.prepare('SELECT * FROM storage_import_items WHERE import_id = ? ORDER BY namespace, key').all(id)) {
                const { namespace, key } = source;
                let item = { kind: source.kind, mimeType: source.mime_type, body: source.body, hash: source.hash, context: source.context,
                    value: source.kind === 'json' ? jsonOf(source.body) : undefined };
                item = canonicalItem(namespace, key, item);
                const current = rowAt(namespace, key);
                if (!current) {
                    result.events.push(write(namespace, key, item, clientId, 'import', id));
                    result.imported++;
                    continue;
                }
                if (same(item, current)) { result.identical++; continue; }
                const merged = !current.deleted && item.kind === 'json' && current.kind === 'json' && unionImport(namespace, key, jsonOf(item.body), jsonOf(current.body));
                if (merged) {
                    item = { ...item, value: merged.value, body: bytesOf(merged.value) };
                    item.hash = createHash('sha256').update(item.body).digest('hex');
                    if (!same(item, current)) {
                        result.events.push(write(namespace, key, item, clientId, 'import-merge', id));
                        result.imported++;
                    } else if (!merged.conflict) result.identical++;
                    if (!merged.conflict) continue;
                }
                result.conflicts.push({ namespace, key });
            }
            const { events, ...publicResult } = result;
            database.prepare("UPDATE storage_imports SET status = 'committed', result = ? WHERE id = ?").run(JSON.stringify(publicResult), id);
            return result;
        });
    }

    async function handle(request, response, path) {
        if (path !== '/storage' && !path.startsWith('/storage/')) return false;
        try {
            if (closed) throw new StorageError(503, '共享存储已关闭。');
            const url = new URL(request.url, 'http://127.0.0.1:3002');
            const isEvents = path === '/storage/events' && request.method === 'GET';
            const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
            if ((origin && origin !== ORIGIN) || (site && site !== 'same-origin')) throw new StorageError(403, '拒绝跨站访问共享数据。');
            if (isEvents) {
                if (origin !== ORIGIN && site !== 'same-origin') throw new StorageError(403, '请从本机画布订阅数据变更。');
            } else if (request.headers['x-infinite-canvas-storage'] !== '1') throw new StorageError(403, '请从本机画布访问共享数据。');
            if (request.method !== 'GET' && origin !== ORIGIN) throw new StorageError(403, '共享数据只能由本机画布修改。');

            if (request.method === 'GET' && path === '/storage/meta') {
                respond(response, 200, { schemaVersion: 1, revision: revision(), migrationCount: database.prepare("SELECT count(*) AS count FROM storage_imports WHERE status = 'committed'").get().count });
            } else if (request.method === 'GET' && path === '/storage/items') {
                const namespace = namespaceOf(url.searchParams.get('namespace'));
                const items = database.prepare(`SELECT key, revision, kind, mime_type AS mimeType, length(body) AS bytes
                    FROM storage_items WHERE namespace = ? AND deleted = 0 ORDER BY key`).all(namespace);
                respond(response, 200, { items });
            } else if (request.method === 'GET' && path === '/storage/item') {
                const { namespace, key } = itemLocation(url);
                const item = rowAt(namespace, key);
                const headers = { 'X-Storage-Revision': String(item?.revision || 0) };
                if (!item || item.deleted) respond(response, 404, { error: '未找到存储项目。' }, headers);
                else {
                    response.writeHead(200, { ...headers, 'X-Storage-Kind': item.kind, 'Content-Type': item.mime_type,
                        'Content-Length': item.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                        'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "sandbox; default-src 'none'" });
                    response.end(Buffer.from(item.body));
                }
            } else if (request.method === 'PUT' && path === '/storage/item') {
                const { namespace, key } = itemLocation(url);
                const clientId = clientOf(request), expected = expectedRevision(request);
                const result = saveItem(namespace, key, await readItem(request), expected, clientId);
                if (result.conflict) respond(response, 409, { error: '另一窗口已修改相同内容；当前提交已完整备份，未覆盖共享版本。', currentRevision: result.currentRevision, conflictId: result.conflictId });
                else {
                    const { events, ...value } = result;
                    respond(response, 200, value, { 'X-Storage-Revision': String(result.revision) });
                    broadcast(events);
                }
            } else if (request.method === 'DELETE' && path === '/storage/item') {
                const { namespace, key } = itemLocation(url);
                const clientId = clientOf(request), expected = expectedRevision(request);
                const result = transaction(() => {
                    const current = rowAt(namespace, key), currentRevision = current?.revision || 0;
                    const item = { kind: current?.kind || 'json', mimeType: current?.mime_type || 'application/json', body: null, hash: null, deleted: true };
                    if (expected !== currentRevision) return rejectCandidate(namespace, key, item, clientId, currentRevision);
                    if (current?.deleted) return { revision: currentRevision, events: [] };
                    const event = write(namespace, key, item, clientId, 'delete');
                    return { revision: event.revision, events: [event] };
                });
                if (result.conflict) respond(response, 409, { error: '另一窗口已修改此项目；删除意图已备份，未删除共享内容。', currentRevision: result.currentRevision, conflictId: result.conflictId });
                else {
                    respond(response, 200, { revision: result.revision }, { 'X-Storage-Revision': String(result.revision) });
                    broadcast(result.events);
                }
            } else if (isEvents) {
                if (!UUID.test(url.searchParams.get('client') || '')) throw new StorageError(400, '客户端标识无效。');
                response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
                    Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
                response.write(': connected\n\n');
                subscribers.add(response);
                response.once('close', () => subscribers.delete(response));
            } else if (request.method === 'GET' && path === '/storage/stats') {
                const current = database.prepare('SELECT count(*) AS items, coalesce(sum(length(body)), 0) AS bytes FROM storage_items WHERE deleted = 0').get();
                const historical = database.prepare('SELECT count(*) AS versions, coalesce(sum(coalesce(length(body), 0) + coalesce(length(context), 0)), 0) AS bytes FROM storage_versions').get();
                const stages = database.prepare('SELECT coalesce(sum(length(body) + coalesce(length(context), 0)), 0) AS bytes FROM storage_import_items').get();
                const manifests = database.prepare('SELECT coalesce(sum(length(source)), 0) AS bytes FROM storage_imports').get();
                respond(response, 200, { ...current, versions: historical.versions, backupBytes: historical.bytes + stages.bytes + manifests.bytes });
            } else if (request.method === 'POST' && path === '/storage/imports') {
                const clientId = clientOf(request), source = await readJson(request), id = randomUUID();
                transaction(() => database.prepare("INSERT INTO storage_imports (id, client_id, status, created_at, source) VALUES (?, ?, 'staged', ?, ?)")
                    .run(id, clientId, new Date().toISOString(), source.body));
                respond(response, 201, { id });
            } else {
                const match = /^\/storage\/imports\/([^/]+)\/(item|commit)$/.exec(path);
                if (!match || !UUID.test(match[1])) throw new StorageError(404, '未找到共享存储接口。');
                const clientId = clientOf(request);
                if (request.method === 'PUT' && match[2] === 'item') {
                    const { namespace, key } = itemLocation(url);
                    const result = stageImport(match[1], namespace, key, await readItem(request), clientId);
                    if (result.conflict) respond(response, 409, { error: '此迁移项目已有不同原值；新旧候选均已保留，未替换原备份。', conflictId: result.conflictId });
                    else respond(response, 200, result);
                } else if (request.method === 'POST' && match[2] === 'commit') {
                    await readJson(request);
                    const { events, ...result } = commitImport(match[1], clientId);
                    respond(response, 200, result);
                    broadcast(events);
                } else throw new StorageError(405, '此共享存储接口不支持该操作。');
            }
        } catch (error) {
            if (response.headersSent) response.destroy();
            else if (error instanceof StorageError) respond(response, error.status, { error: error.message, ...error.details });
            else {
                console.error('Shared storage operation failed:', error.code || error.name || 'unknown');
                respond(response, 500, { error: '共享存储操作失败；未自动重试或覆盖其他版本，请查看本机服务日志。' });
            }
        }
        return true;
    }

    function close() {
        if (closed) return;
        closed = true;
        for (const response of subscribers) response.end();
        subscribers.clear();
        database.close();
    }
    return { handle, close };
}
