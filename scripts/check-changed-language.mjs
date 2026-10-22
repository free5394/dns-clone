import { spawnSync } from "node:child_process";
import { findLanguageViolations } from "./language-check-lib.mjs";

const base = process.env.LANGUAGE_CHECK_BASE;
const sourcePatterns = ["*.ts", "*.js", "*.mjs", "*.cjs"];

function runGit(diffArgs) {
    const result = spawnSync(
        "git",
        ["diff", "--unified=0", "--no-color", "--diff-filter=ACMR", ...diffArgs, "--", ...sourcePatterns],
        {
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
        }
    );

    if (result.status !== 0) {
        const details = [result.stderr, result.error instanceof Error ? result.error.stack : result.error]
            .filter(Boolean)
            .join("\n");
        console.error(`语言检查无法读取 Git 差异：\n${details}`);
        process.exit(2);
    }

    return result.stdout;
}

const diffs = base ? [runGit([`${base}...HEAD`])] : [runGit(["--cached"]), runGit([])];
const violationsById = new Map();
for (const diff of diffs) {
    for (const violation of findLanguageViolations(diff)) {
        const id = `${violation.file}:${violation.line}:${violation.kind}:${violation.text}`;
        violationsById.set(id, violation);
    }
}

const violations = [...violationsById.values()];
if (violations.length === 0) {
    console.log("语言检查通过");
    process.exit(0);
}

for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.kind}必须包含中文：${violation.text}`);
}
process.exit(1);
