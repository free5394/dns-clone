import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { inspectUtf8 } from "./utf8-check-lib.mjs";

function runGit(args, options = {}) {
    const result = spawnSync("git", args, {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        ...options,
    });

    if (result.status !== 0) {
        const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
        const details = [stderr, result.error instanceof Error ? result.error.stack : result.error]
            .filter(Boolean)
            .join("\n");
        console.error(`UTF-8 检查无法调用 Git：\n${details}`);
        process.exit(2);
    }

    return result.stdout;
}

const stagedFiles = new Set(
    runGit(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--"]).split("\0").filter(Boolean)
);
const listedFiles = runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
const files = stagedFiles.size > 0 ? [...stagedFiles] : listedFiles.split("\0").filter(Boolean);
const attributes = runGit(["check-attr", "-z", ...(stagedFiles.size > 0 ? ["--cached"] : []), "--stdin", "text"], {
    input: `${files.join("\0")}\0`,
});
const attributeParts = attributes.split("\0");
const textFiles = [];

for (let index = 0; index + 2 < attributeParts.length; index += 3) {
    const [file, , value] = attributeParts.slice(index, index + 3);
    if (file && value !== "unset") {
        textFiles.push(file);
    }
}

const failures = [];
for (const file of textFiles) {
    let contents;
    if (stagedFiles.has(file)) {
        contents = runGit(["show", `:${file}`], { encoding: null });
    } else if (existsSync(file)) {
        try {
            contents = readFileSync(file);
        } catch (error) {
            console.error(`UTF-8 检查无法读取工作树文件 ${file}：${error instanceof Error ? error.stack : error}`);
            process.exit(2);
        }
    } else {
        continue;
    }

    const violation = inspectUtf8(contents);
    if (violation) {
        failures.push(`${file}：${violation}`);
    }
}

if (failures.length === 0) {
    console.log("UTF-8 检查通过");
    process.exit(0);
}

console.error([...new Set(failures)].join("\n"));
process.exit(1);
