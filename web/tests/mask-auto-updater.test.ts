import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { CanvasNodeMetadata } from "../src/types/canvas";
import { createMaskAutoUpdater, type MaskUpdateJob } from "../src/lib/canvas/mask-auto-updater.ts";

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const job = (id = "mask", key = "input-a"): MaskUpdateJob => ({ id, key, type: "process:mask-grow", settings: { amount: 4 }, inputs: [{ id: "source", title: "source", kind: "image", content: "/source.png" }] });
const result = (id = "output"): CanvasNodeMetadata => ({ content: `/${id}.png`, storageKey: id, outputKind: "image" });

function fixture(onPublish?: (updater: ReturnType<typeof createMaskAutoUpdater>, job: MaskUpdateJob, patch: CanvasNodeMetadata) => boolean | void) {
    const scheduled: (() => void)[] = [];
    const tasks: { job: MaskUpdateJob; signal: AbortSignal; resolve: (patch: CanvasNodeMetadata) => void; reject: (error: Error) => void }[] = [];
    const published: { job: MaskUpdateJob; patch: CanvasNodeMetadata }[] = [];
    const discarded: CanvasNodeMetadata[] = [];
    const updater = createMaskAutoUpdater({
        schedule: callback => scheduled.push(callback),
        process: (job, signal) => new Promise((resolve, reject) => tasks.push({ job, signal, resolve, reject })),
        publish: (job, patch) => { published.push({ job, patch }); return onPublish?.(updater, job, patch); },
        discard: async patch => { discarded.push(patch); },
    });
    disposers.push(updater.dispose);
    return { updater, tasks, published, discarded, flush: () => scheduled.splice(0).forEach(callback => callback()) };
}

test("coalesces a frame to its latest input and never repeats a completed key during publishing", async () => {
    const state = fixture((updater, current, patch) => { if (patch.status === "success") updater.update([current]); });
    state.updater.update([job()]);
    state.updater.update([job("mask", "input-b")]);
    assert.equal(state.tasks.length, 0);
    state.flush();
    assert.deepEqual(state.tasks.map(task => task.job.key), ["input-b"]);
    assert.equal(state.published[0]?.patch.status, "loading");
    assert.equal(state.published[0]?.patch.processRunKey, "input-b");
    state.tasks[0].resolve(result());
    await settle();
    state.flush();
    state.updater.update([job("mask", "input-b")]);
    state.flush();
    assert.equal(state.tasks.length, 1);
    assert.deepEqual(state.published.at(-1)?.patch, { ...result(), status: "success", processOutputKey: "input-b", processRunKey: undefined, processErrorKey: undefined, errorDetails: undefined });
});

test("deduplicates node ids and runs separate branches one at a time", async () => {
    const state = fixture();
    state.updater.update([job("shared"), job("shared"), job("branch")]);
    state.flush();
    assert.deepEqual(state.tasks.map(task => task.job.id), ["shared"]);
    state.flush();
    assert.equal(state.tasks.length, 1);
    state.tasks[0].resolve(result("shared"));
    await settle();
    state.flush();
    assert.deepEqual(state.tasks.map(task => task.job.id), ["shared", "branch"]);
    state.tasks[1].resolve(result("branch"));
    await settle();
    state.flush();
    assert.equal(state.tasks.length, 2);
});

test("aborts superseded input, waits for settlement and discards its late pixels", async () => {
    const state = fixture();
    state.updater.update([job()]);
    state.flush();
    state.updater.update([job("mask", "input-b")]);
    assert.equal(state.tasks[0].signal.aborted, true);
    state.flush();
    assert.equal(state.tasks.length, 1);
    state.tasks[0].resolve(result("old"));
    await settle();
    state.flush();
    assert.deepEqual(state.discarded, [result("old")]);
    assert.equal(state.tasks[1]?.job.key, "input-b");
    assert.equal(state.published.some(entry => entry.patch.content === "/old.png"), false);
    state.tasks[1].resolve(result("new"));
    await settle();
    assert.equal(state.published.at(-1)?.patch.content, "/new.png");
});

test("dropping a deleted or unready node cancels it without publishing a stale result", async () => {
    const state = fixture();
    state.updater.update([job()]);
    state.flush();
    state.updater.update([]);
    assert.equal(state.tasks[0].signal.aborted, true);
    state.tasks[0].resolve(result("removed"));
    await settle();
    state.flush();
    assert.deepEqual(state.discarded, [result("removed")]);
    assert.deepEqual(state.published.map(entry => entry.patch.status), ["loading"]);
    assert.equal(state.tasks.length, 1);
});

test("removing and restoring the same key while it runs still discards the aborted request", async () => {
    const state = fixture();
    state.updater.update([job()]);
    state.flush();
    state.updater.update([]);
    state.updater.update([job()]);
    state.tasks[0].resolve(result("aborted"));
    await settle();
    state.flush();
    assert.equal(state.tasks.length, 2);
    assert.deepEqual(state.discarded, [result("aborted")]);
    state.tasks[1].resolve(result("restored"));
    await settle();
    assert.equal(state.published.at(-1)?.patch.content, "/restored.png");
});

test("publishes one failure per key and permits an explicit retry after removal", async () => {
    const state = fixture((updater, current, patch) => { if (patch.status === "error") updater.update([current]); });
    state.updater.update([job()]);
    state.flush();
    state.tasks[0].reject(new Error("输入损坏"));
    await settle();
    state.flush();
    state.updater.update([job()]);
    state.flush();
    assert.equal(state.tasks.length, 1);
    assert.deepEqual(state.published.at(-1)?.patch, { status: "error", processRunKey: undefined, processErrorKey: "input-a", errorDetails: "输入损坏" });
    state.updater.update([]);
    state.updater.update([job()]);
    state.flush();
    assert.equal(state.tasks.length, 2);
    state.tasks[1].resolve(result("retry"));
    await settle();
    assert.equal(state.published.at(-1)?.patch.status, "success");
    assert.equal(state.published.at(-1)?.patch.processOutputKey, "input-a");
    assert.equal(state.published.at(-1)?.patch.processErrorKey, undefined);
});

test("changed input retries after failure without requiring an empty frame", async () => {
    const state = fixture();
    state.updater.update([job()]);
    state.flush();
    state.tasks[0].reject(new Error("bad input"));
    await settle();
    state.updater.update([job("mask", "input-b")]);
    state.flush();
    assert.equal(state.tasks[1]?.job.key, "input-b");
    state.tasks[1].resolve(result());
    await settle();
});

test("an aborted rejection does not report an error or block the replacement", async () => {
    const state = fixture();
    state.updater.update([job()]);
    state.flush();
    state.updater.update([job("mask", "input-b")]);
    state.tasks[0].reject(new DOMException("cancelled", "AbortError"));
    await settle();
    state.flush();
    assert.equal(state.published.some(entry => entry.patch.status === "error"), false);
    assert.equal(state.tasks[1]?.job.key, "input-b");
    state.tasks[1].resolve(result());
    await settle();
});

test("disposing prevents queued work and discards a running result", async () => {
    const queued = fixture();
    queued.updater.update([job()]);
    queued.updater.dispose();
    queued.flush();
    assert.equal(queued.tasks.length, 0);

    const running = fixture();
    running.updater.update([job()]);
    running.flush();
    running.updater.dispose();
    assert.equal(running.tasks[0].signal.aborted, true);
    running.tasks[0].resolve(result("disposed"));
    await settle();
    running.updater.update([job("mask", "input-b")]);
    running.flush();
    assert.deepEqual(running.discarded, [result("disposed")]);
    assert.deepEqual(running.published.map(entry => entry.patch.status), ["loading"]);
    assert.equal(running.tasks.length, 1);
});

test("a rejected success publication recycles its artifact without retrying the same input", async () => {
    const state = fixture((updater, current, patch) => {
        if (patch.status !== "success") return;
        updater.update([current]);
        return false;
    });
    state.updater.update([job()]);
    state.flush();
    state.tasks[0].resolve(result("rejected"));
    await settle();
    state.flush();
    state.updater.update([job()]);
    state.flush();
    assert.deepEqual(state.discarded, [result("rejected")]);
    assert.equal(state.tasks.length, 1);
});

test("rejecting loading skips processing until a different request arrives", async () => {
    const state = fixture((_updater, current) => current.key === "input-a" ? false : undefined);
    state.updater.update([job()]);
    state.flush();
    await settle();
    state.flush();
    assert.equal(state.tasks.length, 0);
    assert.equal(state.published.length, 1);
    state.updater.update([job("mask", "input-b")]);
    state.flush();
    assert.equal(state.tasks[0]?.job.key, "input-b");
    state.tasks[0].resolve(result());
    await settle();
});
