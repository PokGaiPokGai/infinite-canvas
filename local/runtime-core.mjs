import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';

export const runtimeProtocol = 1;
export function git(root, ...args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
export function checkout(root) {
    try {
        const head = git(root, 'rev-parse', 'HEAD');
        const name = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
        return { root: realpathSync(root), branch: name === 'HEAD' ? `detached@${head.slice(0, 7)}` : name, head };
    } catch { return { root: resolve(root), branch: '未知分支', head: null }; }
}
export function mainCheckout(root) {
    const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return realpathSync(dirname(common));
}
export function sourceFingerprint(root, paths = ['web', 'local', 'VERSION', 'CHANGELOG.md']) {
    // Hash source bytes, including unstaged/new source files, rather than trusting HEAD alone.
    const files = [...new Set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths).split('\0'))]
        .filter(Boolean).filter(file => !file.endsWith('.test.ts') && !file.endsWith('.test.mjs')).sort();
    const hash = createHash('sha256');
    for (const file of files) { hash.update(file + '\0'); hash.update(existsSync(join(root, file)) ? readFileSync(join(root, file)) : '<deleted>'); }
    return hash.digest('hex');
}
export function verifyDependencies(root) {
    const modules = join(root, 'web/node_modules');
    if (!existsSync(join(modules, 'vite/bin/vite.js'))) throw new Error('缺少依赖，请在此检出的 web 目录执行 pnpm install --frozen-lockfile --ignore-scripts。');
    const target = realpathSync(modules);
    const installedLock = join(target, '.pnpm/lock.yaml');
    const lockText = file => readFileSync(file, 'utf8').replaceAll('\r\n', '\n').trim();
    const expected = lockText(join(root, 'web/pnpm-lock.yaml'));
    // pnpm's installed lock is its own representation. For a junction, also check the owning checkout.
    const ownerLock = join(dirname(target), 'pnpm-lock.yaml');
    if (!existsSync(ownerLock) || lockText(ownerLock) !== expected) throw new Error('依赖目录所属检出的 pnpm 锁文件不同，拒绝复用。请为此 worktree 安装独立依赖。');
    if (!existsSync(installedLock)) throw new Error('依赖缺少 pnpm 安装记录，请重新执行冻结锁文件安装。');
    if (lockText(installedLock) !== expected) throw new Error('已安装依赖的锁文件与当前分支不同，请执行冻结锁文件安装；未修改共享依赖。');
    const manifest = JSON.parse(readFileSync(join(root, 'web/package.json'), 'utf8'));
    const ownerManifest = JSON.parse(readFileSync(join(dirname(target), 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies']) if (JSON.stringify(manifest[field]) !== JSON.stringify(ownerManifest[field])) throw new Error('依赖声明与共享依赖目录不一致，拒绝启动。');
    return target;
}
export function readInstance(root) {
    const file = join(root, '.local/instance.json');
    if (!existsSync(file)) {
        if (checkout(root).branch === 'main') return { port: 3070 };
        throw new Error('此 worktree 尚未配置入口：node local/runtime.mjs init --port <空闲端口>');
    }
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || [3000, 3002, 8188].includes(config.port)) throw new Error('开发端口必须为 1024–65535，且不能占用 3000、3002、8188。');
    return config;
}
export function buildDirectory(root) { return join(root, '.local/builds/shared'); }
export function verifyBuild(root) {
    const directory = buildDirectory(root);
    const file = join(directory, 'canvas-build.json');
    if (!existsSync(file) || !existsSync(join(directory, 'index.html'))) throw new Error('缺少本机共享版构建，请执行 pnpm --dir web run build:local。');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.mode !== 'local-shared' || manifest.head !== checkout(root).head || manifest.fingerprint !== sourceFingerprint(root)) throw new Error('本机共享版构建与当前源码不一致，请执行 pnpm --dir web run build:local 更新后再启动。');
    return manifest;
}
export function within(root, candidate) {
    const path = relative(resolve(root), resolve(candidate));
    return path !== '' && !path.startsWith('..') && !path.includes(':');
}

// The nonce stays in the ignored owner file/environment. It is never returned by identity endpoints.
export function runtimeEndpoint({ root, port, dataRoot, mode, build, stop, active = () => 0, token = process.env.INFINITE_CANVAS_OWNER_TOKEN }) {
    const started = checkout(root);
    const backendFingerprint = mode === 'bridge' ? sourceFingerprint(root, ['local']) : null;
    const startedAt = new Date(performance.timeOrigin).toISOString();
    return (request, response, next) => {
        const path = request.url?.split('?')[0];
        if (path !== '/__canvas' && path !== '/__canvas/stop') return next();
        const origin = `http://127.0.0.1:${port}`;
        const allowed = request.headers.host === `127.0.0.1:${port}` && (!request.headers.origin || request.headers.origin === origin) && (!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin');
        const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); };
        if (!allowed) return send(403, { error: '仅允许本机当前入口访问。' });
        if (path === '/__canvas/stop') {
            if (request.method !== 'POST' || !token || request.headers['x-canvas-owner'] !== token) return send(403, { error: '运行实例所有权不匹配，未停止任何进程。' });
            if (active()) return send(409, { error: '共享后台仍有活动任务，保留运行。' });
            response.once('finish', stop);
            send(200, { stopped: true });
            return;
        }
        if (request.method !== 'GET') return send(405, { error: '只允许读取运行身份。' });
        send(200, { protocol: runtimeProtocol, pid: process.pid, startedAt, mode, port, ...checkout(root), startedHead: started.head, backendFingerprint, dataRoot: resolve(dataRoot), sharedStorage: true, build: build || null, activeJobs: active() });
    };
}
