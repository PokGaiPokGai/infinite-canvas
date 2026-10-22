import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

// Reuse the user's existing backend launcher; no installation or model downloads.
export function createEnsureComfy(appRoot) {
    let starting;
    async function ready() {
        try {
            const response = await fetch('http://127.0.0.1:8188/system_stats', { redirect: 'error' });
            return response.ok && Boolean((await response.json()).system?.comfyui_version);
        } catch { return false; }
    }
    async function start() {
        if (await ready()) return;
        let script = process.env.COMFYUI_START_SCRIPT;
        if (!script) {
            try { script = JSON.parse(await readFile(join(appRoot, '.local/machine.json'), 'utf8')).comfyStartScript; }
            catch (error) { if (error.code !== 'ENOENT') throw new Error('本机 ComfyUI 启动配置无法读取。'); }
        }
        if (typeof script !== 'string' || extname(script).toLowerCase() !== '.ps1' || !(await stat(script).catch(() => null))?.isFile()) {
            throw new Error('请配置现有 ComfyUI 启动脚本 COMFYUI_START_SCRIPT，或先启动已有 ComfyUI。');
        }
        const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-BackendOnly'], { shell: false, windowsHide: true, stdio: 'ignore' });
        const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
        if (code !== 0 || !(await ready())) throw new Error('已有 ComfyUI 启动器未就绪；画布仍可编辑，请检查其日志后重试。');
    }
    return async () => {
        if (!starting) starting = start().finally(() => { starting = undefined; });
        await starting;
    };
}
