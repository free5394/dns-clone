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
        console.error(`UTF-8 检查无法调用 Git：${result.stderr || result.error?.message}`);
        process.exit(2);
    }

    return result.stdout;
}

const listedFiles = runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
const files = listedFiles.split("\0").filter(Boolean);

const attributes = runGit(["check-attr", "-z", "--stdin", "text"], {
    input: `${files.join("\0")}\0`,
});
const parts = attributes.split("\0");
const textFiles = [];

for (let index = 0; index + 2 < parts.length; index += 3) {
    const [file, , value] = parts.slice(index, index + 3);
    if (file && value !== "unset") {
        textFiles.push(file);
    }
}

const failures = [];
for (const file of textFiles) {
    if (!existsSync(file)) {
        continue;
    }

    let bytes;
    try {
        bytes = readFileSync(file);
    } catch (error) {
        console.error(`UTF-8 检查无法读取 ${file}：${error instanceof Error ? error.stack : error}`);
        process.exit(2);
    }

    const violation = inspectUtf8(bytes);
    if (violation) {
        failures.push(`${file}：${violation}`);
    }
}

if (failures.length === 0) {
    console.log("UTF-8 检查通过");
    process.exit(0);
}

console.error(failures.join("\n"));
process.exit(1);
