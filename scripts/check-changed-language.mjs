import { spawnSync } from "node:child_process";
import { findLanguageViolations } from "./language-check-lib.mjs";

const base = process.env.LANGUAGE_CHECK_BASE;
const args = [
    "diff",
    "--unified=0",
    "--no-color",
    "--diff-filter=ACMR",
    ...(base ? [`${base}...HEAD`] : ["HEAD"]),
    "--",
    "*.ts",
    "*.js",
    "*.mjs",
    "*.cjs",
];

const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
});

if (result.status !== 0) {
    console.error(`语言检查无法读取 Git 差异：${result.stderr || result.error?.message}`);
    process.exit(2);
}

const violations = findLanguageViolations(result.stdout);
if (violations.length === 0) {
    console.log("语言检查通过");
    process.exit(0);
}

for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.kind}必须包含中文：${violation.text}`);
}
process.exit(1);
