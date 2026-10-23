import type { CanvasNodeMetadata } from "@/types/canvas";
import type { MaskSettings, ProcessResult } from "@/types/canvas-workflow";

export type MaskUpdateJob = { id: string; key: string; type: string; settings: MaskSettings; inputs: ProcessResult[] };

export function createMaskAutoUpdater({ process, publish, discard, schedule = queueMicrotask }: {
    process: (job: MaskUpdateJob, signal: AbortSignal) => Promise<CanvasNodeMetadata>;
    publish: (job: MaskUpdateJob, patch: CanvasNodeMetadata) => boolean | void;
    discard: (patch: CanvasNodeMetadata) => Promise<void>;
    schedule?: (callback: () => void) => void;
}) {
    let jobs = new Map<string, MaskUpdateJob>();
    const settled = new Map<string, string>();
    let running: { job: MaskUpdateJob; controller: AbortController } | null = null;
    let scheduled = false, disposed = false;

    const current = (job: MaskUpdateJob, signal: AbortSignal) => !disposed && !signal.aborted && jobs.get(job.id)?.key === job.key;
    const request = () => {
        if (disposed || scheduled) return;
        scheduled = true;
        schedule(() => {
            scheduled = false;
            if (disposed || running) return;
            const job = [...jobs.values()].find(job => settled.get(job.id) !== job.key);
            if (job) void run(job);
        });
    };
    const run = async (job: MaskUpdateJob) => {
        const controller = new AbortController();
        running = { job, controller };
        try {
            if (publish(job, { status: "loading", processRunKey: job.key, errorDetails: undefined }) === false) {
                settled.set(job.id, job.key);
                return;
            }
            controller.signal.throwIfAborted();
            const patch = await process(job, controller.signal);
            if (!current(job, controller.signal)) {
                await discard(patch);
                return;
            }
            // Keep the key before publishing: React may still report this job until its next render.
            settled.set(job.id, job.key);
            if (publish(job, { ...patch, status: "success", processOutputKey: job.key, processRunKey: undefined, processErrorKey: undefined, errorDetails: undefined }) === false) await discard(patch);
        } catch (error) {
            if (current(job, controller.signal)) {
                settled.set(job.id, job.key);
                publish(job, { status: "error", processRunKey: undefined, processErrorKey: job.key, errorDetails: error instanceof Error ? error.message : "蒙版处理失败。" });
            }
        } finally {
            running = null;
            request();
        }
    };

    return {
        update(next: MaskUpdateJob[]) {
            if (disposed) return;
            jobs = new Map(next.map(job => [job.id, job]));
            for (const [id, key] of settled) if (jobs.get(id)?.key !== key) settled.delete(id);
            if (running && jobs.get(running.job.id)?.key !== running.job.key) running.controller.abort();
            request();
        },
        dispose() {
            disposed = true;
            jobs.clear();
            settled.clear();
            running?.controller.abort();
        },
    };
}
