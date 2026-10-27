import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { checkout, mainCheckout, readInstance, verifyBuild, verifyDependencies, runtimeProtocol, sourceFingerprint } from './runtime-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = mainCheckout(root);
const state = join(root, '.local');
const command = process.argv[2] || 'status';
const args = process.argv.slice(3);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const normalized = path => resolve(path).toLowerCase();
async function identity(port) {
    try { const response = await fetch(`http://127.0.0.1:${port}/__canvas`); return response.ok ? await response.json() : null; }
    catch { return null; }
}
async function occupied(port) {
    const { createConnection } = await import('node:net');
    return new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
    });
}
async function startOwned({ source, port, mode, script, parameters = [], environment = {} }) {
    const ownerFile = join(source, '.local', `runtime-${mode}.json`);
    const current = await identity(port);
    if (current) {
        if (!existsSync(ownerFile)) throw new Error(`端口 ${port} 已运行，但没有本入口的所有权记录；未接管。`);
        const owner = json(ownerFile);
        if (current.protocol !== runtimeProtocol || current.pid !== owner.pid || current.startedAt !== owner.startedAt || normalized(current.root) !== normalized(source) || current.mode !== mode || normalized(current.dataRoot) !== normalized(main) || current.startedHead !== checkout(source).head) throw new Error(`端口 ${port} 的运行身份或启动提交与当前检出不同，请核对后停止旧实例再启动。`);
        if (mode === 'bridge' && current.backendFingerprint !== sourceFingerprint(source, ['local'])) throw new Error('后台代码已变化，运行中的实例仍是旧版本；请核对活动任务后显式停止再启动。');
        console.log(JSON.stringify(current, null, 2));
        return current;
    }
    if (await occupied(port)) throw new Error(`端口 ${port} 已被其他或旧版服务占用，未停止任何进程。请先核对其来源。`);
    const directory = join(source, '.local');
    mkdirSync(directory, { recursive: true });
    const token = randomUUID();
    const log = join(directory, `runtime-${mode}-${Date.now()}`);
    const stdout = openSync(`${log}.stdout.log`, 'a'), stderr = openSync(`${log}.stderr.log`, 'a');
    let child;
    try {
        child = spawn(process.execPath, [script, ...parameters], {
            cwd: join(source, mode === 'bridge' ? '.' : 'web'), windowsHide: true, detached: true,
            stdio: ['ignore', stdout, stderr], env: { ...process.env, ...environment, INFINITE_CANVAS_APP_ROOT: main, INFINITE_CANVAS_OWNER_TOKEN: token },
        });
    } finally { closeSync(stdout); closeSync(stderr); }
    let failed;
    child.once('error', error => { failed = error; });
    child.unref();
    for (;;) {
        if (failed || child.exitCode !== null) throw new Error(`启动失败，查看 ${log}.stderr.log：${failed?.message || child.exitCode}`);
        const ready = await identity(port);
        if (ready) {
            if (ready.pid !== child.pid || ready.mode !== mode || normalized(ready.root) !== normalized(source) || ready.protocol !== runtimeProtocol) throw new Error(`端口 ${port} 启动身份异常，未接管其他服务。`);
            writeFileSync(ownerFile, JSON.stringify({ ...ready, token, log }, null, 2));
            console.log(JSON.stringify(ready, null, 2));
            return ready;
        }
        await delay(200); // Retain the existing launcher's readiness polling interval.
    }
}
async function bridge() {
    // A feature checkout may request the shared backend, but never supplies its code or data directory.
    if (!existsSync(join(main, 'local/runtime-core.mjs'))) throw new Error('主检出后台尚未包含统一运行协议；请在获准合并整改后更新主入口，未用功能分支替换共享后台。');
    return startOwned({ source: main, port: 3002, mode: 'bridge', script: join(main, 'local/codex-image-bridge.mjs') });
}
async function frontend(production) {
    const mainFrontend = normalized(root) === normalized(main) && checkout(root).branch === 'main';
    if (production && !mainFrontend) throw new Error('正式本机入口只从 main 主检出运行，请在主目录执行。worktree 使用 start。');
    production ||= mainFrontend;
    verifyDependencies(root);
    const build = production ? verifyBuild(root) : null;
    const port = production ? 3000 : readInstance(root).port;
    await bridge();
    const current = await startOwned({ source: root, port, mode: production ? 'production' : 'development',
        script: join(root, 'web/node_modules/vite/bin/vite.js'),
        parameters: [...(production ? ['preview'] : []), '--config', join(root, 'local/vite.config.ts')],
        environment: { INFINITE_CANVAS_PORT: String(port), INFINITE_CANVAS_MODE: production ? 'production' : 'development' },
    });
    if (build && current.build?.fingerprint !== build.fingerprint) throw new Error('运行中的构建与当前构建不同，请先停止本入口再启动。');
    if (!args.includes('--no-browser')) {
        // The browser is deliberately visible; helper services above are hidden.
        spawn('explorer.exe', [`http://127.0.0.1:${port}/canvas`], { windowsHide: true, stdio: 'ignore' }).unref();
    }
}
async function stop(source, mode, exitApp = false) {
    const file = join(source, '.local', `runtime-${mode}.json`);
    if (!existsSync(file)) { console.log(`${mode}: 没有新版入口的运行记录，未操作旧服务。`); return; }
    const owner = json(file), current = await identity(owner.port);
    if (!current) { console.log(`${mode}: 未找到匹配的运行实例。`); return; }
    if (current.pid !== owner.pid || current.startedAt !== owner.startedAt || current.mode !== mode || normalized(current.root) !== normalized(source)) throw new Error('服务身份与记录不符，拒绝停止。');
    const response = await fetch(`http://127.0.0.1:${owner.port}/__canvas/stop`, { method: 'POST', headers: { 'X-Canvas-Owner': owner.token, ...(exitApp ? { 'X-Canvas-Exit-App': '1' } : {}) } });
    if (!response.ok) throw new Error((await response.json()).error);
    console.log(`${mode}: 已请求停止本入口服务。`);
}

async function stopLegacy(includeBridge) {
    const configs = { canvas: 'vite.config.ts', 'canvas-ux': 'vite.canvas-ux.config.ts', 'canvas-ux-next': 'vite.canvas-ux-next.config.ts', 'main-dev': 'vite.main-dev.config.ts', 'image-compare': 'vite.image-compare.config.ts', 'version-stack': 'vite.version-stack.config.ts', 'production-workflows': 'vite.production-workflows.config.ts' };
    if (includeBridge) configs['codex-image'] = 'codex-image-bridge.mjs';
    for (const [name, config] of Object.entries(configs)) {
        const file = join(state, `${name}-owner.json`);
        if (!existsSync(file)) continue;
        const owner = json(file);
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || normalized(owner.config || '') !== normalized(join(root, 'local', config))) throw new Error(`旧入口 ${name} 的记录不匹配，未停止。`);
        // Numeric PID only enters this fixed PowerShell query. Paths and record text are not evaluated as code.
        const query = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $p=Get-Process -Id ${owner.pid} -ErrorAction SilentlyContinue; if($p){$c=Get-CimInstance Win32_Process -Filter 'ProcessId = ${owner.pid}' -ErrorAction Stop; [pscustomobject]@{path=$p.Path;startUtc=$p.StartTime.ToUniversalTime().ToString('o');command=$c.CommandLine}|ConvertTo-Json -Compress}; exit 0`;
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true }).trim();
        if (!output) { console.log(`${name}: 旧实例已停止。`); continue; }
        const actual = JSON.parse(output);
        if (normalized(actual.path || '') !== normalized(owner.executable || '') || Date.parse(actual.startUtc) !== Date.parse(owner.startUtc) || !actual.command?.toLowerCase().includes(normalized(owner.config))) throw new Error(`旧入口 ${name} 的进程归属无法确认，未停止。`);
        if (name === 'codex-image') {
            const response = await fetch('http://127.0.0.1:3002/health');
            const health = await response.json();
            if (!response.ok || health.service !== 'infinite-canvas-codex-image' || !Number.isInteger(health.activeJobs) || health.activeJobs > 0) throw new Error('旧后台仍有任务或无法核对，保留运行。');
        }
        process.kill(owner.pid);
        console.log(`${name}: 已停止身份匹配的旧实例；日志和数据保留。`);
    }
}

try {
    if (command === 'init') {
        if (checkout(root).branch === 'main') throw new Error('main 固定使用 3000 的本机共享版；更新后先构建，再执行 serve，不创建其他开发入口。');
        const port = Number(option('--port'));
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3000, 3002, 8188].includes(port)) throw new Error('请指定有效且未占用的开发端口：init --port <端口>。');
        const file = join(state, 'instance.json');
        if (existsSync(file) && json(file).port !== port) throw new Error('已有不同端口的配置，请先核对当前实例再手动修改 .local/instance.json。');
        mkdirSync(state, { recursive: true });
        writeFileSync(file, JSON.stringify({ port }, null, 2));
        for (const [name, action] of [['启动开发版', 'start'], ['停止开发版', 'stop']]) {
            writeFileSync(join(state, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0..\\local\\runtime.mjs" ${action}\r\nif errorlevel 1 pause\r\n`);
        }
        console.log(`入口已写入 ${state}；端口 ${port}。依赖不会自动联接或下载。`);
    } else if (command === 'start') await frontend(false);
    else if (command === 'serve') await frontend(true);
    else if (command === 'bridge') await bridge();
    else if (command === 'exit-app') {
        if (normalized(root) !== normalized(main)) throw new Error('应用退出只能由主检出调用。');
        await stop(main, 'bridge', true);
        await stop(root, 'production');
    } else if (command === 'stop') {
        if (args.includes('--legacy')) { await stopLegacy(args.includes('--bridge')); }
        await stop(root, 'development');
        if (normalized(root) === normalized(main)) await stop(root, 'production');
        if (args.includes('--bridge')) await stop(main, 'bridge');
    } else if (command === 'status') {
        const ports = [3000, 3002];
        try { ports.push(readInstance(root).port); } catch { /* An unconfigured worktree still reports the shared services. */ }
        for (const port of new Set(ports)) console.log(JSON.stringify({ port, identity: await identity(port), occupied: await occupied(port) }));
    } else throw new Error('支持 init --port、start、serve、bridge、status、stop [--bridge]。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
