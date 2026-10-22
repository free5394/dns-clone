const CHECKED_PATTERNS = [
    {
        kind: "测试标题",
        pattern:
            /^[ \t]*(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent|fails))?[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dgm,
    },
    {
        kind: "测试标题",
        pattern:
            /^[ \t]*(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent|fails))?\.each(?:<[^>\r\n]*>)?[ \t]*(?:\([^()\r\n]*(?:\([^()\r\n]*\)[^()\r\n]*)*\)|`[^`\r\n]*`)[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dgm,
    },
    {
        kind: "错误消息",
        pattern: /^[ \t]*throw[ \t]+new[ \t]+Error[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dgm,
    },
    {
        kind: "日志消息",
        pattern: /^[ \t]*console\.[A-Za-z_$][\w$]*[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dgm,
    },
];
const HAN_PATTERN = /\p{Script=Han}/u;

function getLineNumber(source, offset, startLine) {
    return startLine + source.slice(0, offset).split("\n").length - 1;
}

function findHunkViolations(file, lines, addedLineNumbers) {
    const source = lines.map(({ text }) => text).join("\n");
    const startLine = lines[0].line;
    const violations = [];

    for (const { kind, pattern } of CHECKED_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
            if (HAN_PATTERN.test(match[2])) {
                continue;
            }

            const [messageStart, messageEnd] = match.indices[2];
            const firstLine = getLineNumber(source, messageStart, startLine);
            const lastLine = getLineNumber(source, Math.max(messageStart, messageEnd - 1), startLine);
            const changedLines = [];
            for (let line = firstLine; line <= lastLine; line += 1) {
                if (addedLineNumbers.has(line)) {
                    changedLines.push(line);
                }
            }

            if (changedLines.length === 0) {
                continue;
            }

            const line = changedLines[0];
            violations.push({
                file,
                line,
                kind,
                text: lines[line - startLine].text,
            });
        }
    }

    return violations.sort((left, right) => left.line - right.line);
}

export function findLanguageViolations(diff) {
    const violations = [];
    let file = "";
    let nextLine = 0;
    let hunkLines = [];
    let addedLineNumbers = new Set();

    const flushHunk = () => {
        if (hunkLines.length > 0) {
            violations.push(...findHunkViolations(file, hunkLines, addedLineNumbers));
            hunkLines = [];
            addedLineNumbers = new Set();
        }
    };

    for (const rawLine of diff.split(/\r?\n/)) {
        if (rawLine.startsWith("+++ b/")) {
            flushHunk();
            file = rawLine.slice("+++ b/".length);
            continue;
        }

        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
        if (hunk) {
            flushHunk();
            nextLine = Number(hunk[1]);
            continue;
        }

        if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
            hunkLines.push({ line: nextLine, text: rawLine.slice(1) });
            addedLineNumbers.add(nextLine);
            nextLine += 1;
            continue;
        }

        if (rawLine.startsWith(" ")) {
            hunkLines.push({ line: nextLine, text: rawLine.slice(1) });
            nextLine += 1;
        }
    }

    flushHunk();
    return violations;
}
