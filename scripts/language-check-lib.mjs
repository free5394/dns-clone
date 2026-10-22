const CHECKED_PATTERNS = [
    {
        kind: "测试标题",
        pattern:
            /^[ \t]*(?:it|test|describe)(?:\.(?:each|skip|only|todo|concurrent|fails))?[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/gm,
    },
    {
        kind: "错误消息",
        pattern: /^[ \t]*throw[ \t]+new[ \t]+Error[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/gm,
    },
    {
        kind: "日志消息",
        pattern: /^[ \t]*console\.(?:log|info|warn|error|debug)[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/gm,
    },
];
const HAN_PATTERN = /\p{Script=Han}/u;

function findGroupViolations(file, lines) {
    const source = lines.map(({ text }) => text).join("\n");
    const startLine = lines[0].line;
    const violations = [];

    for (const { kind, pattern } of CHECKED_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
            if (HAN_PATTERN.test(match[2])) {
                continue;
            }

            const lineOffset = source.slice(0, match.index).split("\n").length - 1;
            violations.push({
                file,
                line: startLine + lineOffset,
                kind,
                text: lines[lineOffset].text,
            });
        }
    }

    return violations.sort((left, right) => left.line - right.line);
}

export function findLanguageViolations(diff) {
    const violations = [];
    let file = "";
    let nextLine = 0;
    let addedLines = [];

    const flushAddedLines = () => {
        if (addedLines.length > 0) {
            violations.push(...findGroupViolations(file, addedLines));
            addedLines = [];
        }
    };

    for (const rawLine of diff.split(/\r?\n/)) {
        if (rawLine.startsWith("+++ b/")) {
            flushAddedLines();
            file = rawLine.slice("+++ b/".length);
            continue;
        }

        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
        if (hunk) {
            flushAddedLines();
            nextLine = Number(hunk[1]);
            continue;
        }

        if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
            addedLines.push({ line: nextLine, text: rawLine.slice(1) });
            nextLine += 1;
            continue;
        }

        flushAddedLines();
        if (rawLine.startsWith(" ")) {
            nextLine += 1;
        }
    }

    flushAddedLines();
    return violations;
}
