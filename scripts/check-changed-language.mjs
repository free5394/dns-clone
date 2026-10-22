import { spawnSync } from "node:child_process";
import { findLanguageViolations } from "./language-check-lib.mjs";

const base = process.env.LANGUAGE_CHECK_BASE;
const sourcePatterns = ["*.ts", "*.js", "*.mjs", "*.cjs"];
const WHOLE_FILE_CONTEXT_LINES = 1_000_000;

function runGit(args) {
    const result = spawnSync("git", args, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
    });

    if (result.status !== 0) {
        const details = [result.stderr, result.error instanceof Error ? result.error.stack : result.error]
            .filter(Boolean)
            .join("\n");
        console.error(`语言检查无法读取 Git 差异：\n${details}`);
        process.exit(2);
    }

    return result.stdout;
}

function runGitDiff(diffArgs) {
    return runGit([
        "diff",
        `--unified=${WHOLE_FILE_CONTEXT_LINES}`,
        "--no-color",
        "--diff-filter=ACMR",
        ...diffArgs,
        "--",
        ...sourcePatterns,
    ]);
}

const hasStagedChanges = runGit(["diff", "--cached", "--name-only", "-z", "--"]).length > 0;
const diff = base ? runGitDiff([`${base}...HEAD`]) : hasStagedChanges ? runGitDiff(["--cached"]) : runGitDiff([]);
const violations = findLanguageViolations(diff);
if (violations.length === 0) {
    console.log("语言检查通过");
    process.exit(0);
}

for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.kind}必须包含中文：${violation.text}`);
}
process.exit(1);
