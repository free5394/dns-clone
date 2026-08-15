// build-single-file.mjs — 把模块化的 src/index.ts 打包成单文件 Worker bundle
// 用途：网页部署路径（README 第 4 步）用户可直接把 dist/worker.bundle.js 整段粘贴到 Cloudflare Dashboard 编辑器。
// 与 src/index.js（手写单文件版）并存：后者是历史遗留，本脚本输出"模块化源码的构建产物"。

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outFile = resolve(root, "dist/worker.bundle.js");

mkdirSync(dirname(outFile), { recursive: true });

const start = Date.now();

await build({
    entryPoints: [resolve(root, "src/index.ts")],
    outfile: outFile,
    bundle: true,
    format: "esm", // Cloudflare Worker 是 ES Module 入口（export default { fetch, scheduled }），不能用 IIFE 把 export 包掉
    target: "es2022",
    platform: "neutral", // 不注入 node 专属全局
    conditions: ["workerd", "browser"], // 优先 workerd 运行时解析条件导出
    mainFields: ["module", "main"],
    minify: false, // 保留可读性，便于用户复制时人工核对
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    // Worker 全局 API（fetch/Request/Response/URL/caches/crypto/console 等）由运行时注入，不需 bundle 或 external
    banner: {
        js: "/* dns-clone single-file bundle — generated from src/index.ts by scripts/build-single-file.mjs */",
    },
});

const elapsed = Date.now() - start;
console.log(`✔ Built ${outFile} in ${elapsed}ms`);
