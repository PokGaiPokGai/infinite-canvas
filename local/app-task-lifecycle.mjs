import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Only children spawned by this bridge are eligible for cancellation.
export function appTaskLifecycle() {
    const children = new Set(), tasks = new Set();
    let exiting = false;
    return {
        get exiting() { return exiting; },
        trackChild(child) {
            if (exiting) throw new Error('无限画布正在退出，任务已取消。');
            children.add(child);
            child.once('close', () => children.delete(child));
            return child;
        },
        trackTask(promise) {
            tasks.add(promise);
            void promise.finally(() => tasks.delete(promise)).catch(() => {});
            return promise;
        },
        async exit() {
            exiting = true;
            await Promise.all([...children].map(async child => {
                if (child.exitCode !== null || child.signalCode !== null) return;
                if (process.platform === 'win32') {
                    try { await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
                    catch (error) { if (child.exitCode === null && child.signalCode === null) throw error; }
                } else child.kill('SIGTERM');
            }));
            await Promise.allSettled([...tasks]);
        },
    };
}
