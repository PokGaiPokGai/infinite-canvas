// Run the existing TypeScript tests on the same Node runtime as the local bridge.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '../web/node_modules/typescript/lib/typescript.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!globalThis.localStorage) {
    const values = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key), clear: () => values.clear(),
    } });
}
registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('@/')) specifier = pathToFileURL(resolve(root, 'web/src', specifier.slice(2))).href;
        if (context.parentURL?.startsWith('file:') && (specifier.startsWith('.') || specifier.startsWith('file:'))) {
            const path = fileURLToPath(new URL(specifier, context.parentURL));
            if (!extname(path)) {
                const candidate = ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map(suffix => path + suffix).find(existsSync);
                if (candidate) specifier = pathToFileURL(candidate).href;
            }
        }
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url.startsWith('file:') && /\.tsx?$/.test(url)) {
            const environment = JSON.stringify({ DEV: false, PROD: false, BASE_URL: '/', VITE_LOCAL_SHARED_STORAGE: process.env.CANVAS_TEST_SHARED_STORAGE || '0' });
            const source = readFileSync(fileURLToPath(url), 'utf8').replaceAll('import.meta.env', `(${environment})`);
            return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText };
        }
        return next(url, context);
    },
});
