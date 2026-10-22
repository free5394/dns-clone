const CHECKED_PATTERNS = [
    {
        kind: "测试标题",
        pattern:
            /(?<![\w$.])(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent|fails)|\.(?:skipIf|runIf)[ \t]*\([^)]*\))*[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dg,
    },
    {
        kind: "测试标题",
        pattern:
            /(?<![\w$.])(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent|fails)|\.(?:skipIf|runIf)[ \t]*\([^)]*\))*\.(?:each|for)(?:<[^>\r\n]*>)?[ \t\r\n]*(?:\[[\s\S]*?\]|\{[\s\S]*?\}|`[\s\S]*?`|\([\s\S]*?\))[ \t\r\n]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dg,
    },
    {
        kind: "错误消息",
        pattern: /\bthrow[ \t]+new[ \t]+Error[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dg,
    },
    {
        kind: "日志消息",
        pattern: /\bconsole\??\.[A-Za-z_$][\w$]*[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dg,
    },
];
const HAN_PATTERN = /\p{Script=Han}/u;
const INLINE_SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/dgi;

function maskRange(characters, start, end) {
    for (let index = start; index < end; index += 1) {
        if (characters[index] !== "\n" && characters[index] !== "\r") {
            characters[index] = " ";
        }
    }
}

function findQuotedEnd(source, start, quote) {
    for (let index = start + 1; index < source.length; index += 1) {
        if (source[index] === "\\") {
            index += 1;
        } else if (source[index] === quote) {
            return index + 1;
        }
    }
    return source.length;
}

function isRegexStart(source, start) {
    let index = start - 1;
    while (index >= 0 && /\s/.test(source[index])) {
        index -= 1;
    }
    if (index < 0 || "([{:;,=!?&|+-*%^~<>".includes(source[index])) {
        return true;
    }
    return /\b(?:case|in|of|return|throw|typeof)\s*$/.test(source.slice(Math.max(0, index - 10), index + 1));
}

function findRegexEnd(source, start) {
    let inCharacterClass = false;
    for (let index = start + 1; index < source.length; index += 1) {
        if (source[index] === "\\") {
            index += 1;
        } else if (source[index] === "[") {
            inCharacterClass = true;
        } else if (source[index] === "]") {
            inCharacterClass = false;
        } else if (source[index] === "/" && !inCharacterClass) {
            index += 1;
            while (index < source.length && /[a-z]/i.test(source[index])) {
                index += 1;
            }
            return index;
        }
    }
    return source.length;
}

function maskNonCode(source) {
    const characters = source.split("");

    for (let index = 0; index < source.length;) {
        if (source[index] === "/" && source[index + 1] === "/") {
            const end = source.indexOf("\n", index + 2);
            const next = end === -1 ? source.length : end;
            maskRange(characters, index, next);
            index = next;
            continue;
        }

        if (source[index] === "/" && source[index + 1] === "*") {
            const end = source.indexOf("*/", index + 2);
            const next = end === -1 ? source.length : end + 2;
            maskRange(characters, index, next);
            index = next;
            continue;
        }

        if (source[index] === "'" || source[index] === '"' || source[index] === "`") {
            const next = findQuotedEnd(source, index, source[index]);
            maskRange(characters, index + 1, next - 1);
            if (source[index] === "`") {
                const templateContent = source.slice(index + 1, next - 1);
                for (const match of templateContent.matchAll(INLINE_SCRIPT_PATTERN)) {
                    const [bodyStart, bodyEnd] = match.indices[1];
                    const scriptBody = templateContent.slice(bodyStart, bodyEnd);
                    const maskedScript = maskNonCode(scriptBody);
                    for (let offset = 0; offset < maskedScript.length; offset += 1) {
                        characters[index + 1 + bodyStart + offset] = maskedScript[offset];
                    }
                }
            }
            index = next;
            continue;
        }

        if (source[index] === "/" && isRegexStart(source, index)) {
            const next = findRegexEnd(source, index);
            maskRange(characters, index, next);
            index = next;
            continue;
        }

        index += 1;
    }

    return characters.join("");
}

function getLineNumber(source, offset, startLine) {
    return startLine + source.slice(0, offset).split("\n").length - 1;
}

function findHunkViolations(file, lines, addedLineNumbers) {
    const source = lines.map(({ text }) => text).join("\n");
    const maskedSource = maskNonCode(source);
    const startLine = lines[0].line;
    const violations = [];

    for (const { kind, pattern } of CHECKED_PATTERNS) {
        for (const match of maskedSource.matchAll(pattern)) {
            const [messageStart, messageEnd] = match.indices[2];
            if (HAN_PATTERN.test(source.slice(messageStart, messageEnd))) {
                continue;
            }

            const firstLine = getLineNumber(maskedSource, messageStart, startLine);
            const lastLine = getLineNumber(maskedSource, Math.max(messageStart, messageEnd - 1), startLine);
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
