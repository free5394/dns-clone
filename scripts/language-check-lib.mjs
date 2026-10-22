const CHECKED_PATTERNS = [
    {
        kind: "测试标题",
        pattern:
            /(?<![\w$.])(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent|fails|sequential)|\.(?:skipIf|runIf)[ \t]*\([^()]*(?:\([^()]*\)[^()]*)*\))*[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dg,
    },
    {
        kind: "测试标题",
        pattern:
            /(?<![\w$.])(?:it|test|describe)(?:\.(?:skip|only|todo|concurrent|fails|sequential)|\.(?:skipIf|runIf)[ \t]*\([^()]*(?:\([^()]*\)[^()]*)*\))*\.(?:each|for)(?:<[^>\r\n]*>)?[ \t\r\n]*(?:\[[\s\S]*?\]|\{[\s\S]*?\}|`[\s\S]*?`|\([\s\S]*?\))[ \t\r\n]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dg,
    },
    {
        kind: "错误消息",
        pattern: /\bthrow[ \t]+new[ \t]+Error[ \t]*\([ \t\r\n]*(["'`])([\s\S]*?)\1/dg,
    },
];
const HAN_PATTERN = /\p{Script=Han}/u;
const CONSOLE_CALL_PATTERN = /\bconsole\??\.[A-Za-z_$][\w$]*[ \t]*\(/dg;
const INLINE_SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/dgi;
const JAVASCRIPT_PREFIX_PATTERN =
    /^(?:["']use strict["'];?\s*)?(?:async\s+function|function|const|let|var|import|export|class|if|for|while|switch|return|throw|console|document|window|\(function|\(\(\)\s*=>)/;
const DIFF_PREFIX_PATTERN = /^diff --git /;

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

function restoreMaskedCode(source, characters, targetStart, options) {
    const maskedSource = maskNonCode(source, options);
    for (let offset = 0; offset < maskedSource.length; offset += 1) {
        characters[targetStart + offset] = maskedSource[offset];
    }
}

function findTemplateExpressionEnd(source, start) {
    let depth = 1;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === "'" || source[index] === '"' || source[index] === "`") {
            index = findQuotedEnd(source, index, source[index]) - 1;
        } else if (source[index] === "/" && source[index + 1] === "/") {
            const end = source.indexOf("\n", index + 2);
            index = end === -1 ? source.length : end;
        } else if (source[index] === "/" && source[index + 1] === "*") {
            const end = source.indexOf("*/", index + 2);
            index = end === -1 ? source.length : end + 1;
        } else if (source[index] === "{") {
            depth += 1;
        } else if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) {
                return index + 1;
            }
        }
    }
    return source.length;
}

function restoreTemplateExpressions(source, characters, start, end, options) {
    for (let index = start; index < end - 1; index += 1) {
        if (source[index] !== "$" || source[index + 1] !== "{" || source[index - 1] === "\\") {
            continue;
        }
        const expressionEnd = findTemplateExpressionEnd(source, index + 2);
        restoreMaskedCode(source.slice(index + 2, expressionEnd - 1), characters, index + 2, options);
        index = expressionEnd - 1;
    }
}

function maskNonCode(source, options = {}) {
    const { allowTemplateCode = true, allowBareScriptTemplate = false } = options;
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
                if (allowTemplateCode && !DIFF_PREFIX_PATTERN.test(templateContent.trimStart())) {
                    for (const match of templateContent.matchAll(INLINE_SCRIPT_PATTERN)) {
                        const [bodyStart, bodyEnd] = match.indices[1];
                        restoreMaskedCode(
                            templateContent.slice(bodyStart, bodyEnd),
                            characters,
                            index + 1 + bodyStart,
                            options
                        );
                    }
                }
                if (
                    allowTemplateCode &&
                    allowBareScriptTemplate &&
                    JAVASCRIPT_PREFIX_PATTERN.test(templateContent.trimStart())
                ) {
                    restoreMaskedCode(templateContent, characters, index + 1, options);
                }
                if (allowTemplateCode) {
                    restoreTemplateExpressions(source, characters, index + 1, next - 1, options);
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

function findClosingParenthesis(source, start) {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === "(") {
            depth += 1;
        } else if (source[index] === ")") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function getLineNumber(source, offset, startLine) {
    return startLine + source.slice(0, offset).split("\n").length - 1;
}

function isTestFile(file) {
    return /(^|[\\/])(?:test|tests)([\\/]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function findHunkViolations(file, lines, addedLineNumbers) {
    const source = lines.map(({ text }) => text).join("\n");
    const allowTemplateCode = !isTestFile(file);
    const options = {
        allowTemplateCode,
        allowBareScriptTemplate: /(^|[\\/])templates\.js$/.test(file),
    };
    const maskedSource = maskNonCode(source, options);
    const startLine = lines[0].line;
    const violations = [];

    const pushViolation = (kind, messageStart, messageEnd) => {
        if (HAN_PATTERN.test(source.slice(messageStart, messageEnd))) {
            return;
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
            return;
        }

        const line = changedLines[0];
        violations.push({
            file,
            line,
            kind,
            text: lines[line - startLine].text,
        });
    };

    for (const { kind, pattern } of CHECKED_PATTERNS) {
        if (kind === "测试标题" && !isTestFile(file)) {
            continue;
        }
        for (const match of maskedSource.matchAll(pattern)) {
            const [messageStart, messageEnd] = match.indices[2];
            pushViolation(kind, messageStart, messageEnd);
        }
    }

    for (const match of maskedSource.matchAll(CONSOLE_CALL_PATTERN)) {
        const openParenthesis = match.index + match[0].lastIndexOf("(");
        const closeParenthesis = findClosingParenthesis(maskedSource, openParenthesis);
        if (closeParenthesis === -1) {
            continue;
        }

        let depth = 0;
        for (let index = openParenthesis + 1; index < closeParenthesis; index += 1) {
            const character = maskedSource[index];
            if ((character === "'" || character === '"' || character === "`") && depth === 0) {
                const end = findQuotedEnd(source, index, character);
                if (character === "`") {
                    let segmentStart = index + 1;
                    for (let cursor = segmentStart; cursor < end - 1; cursor += 1) {
                        if (source[cursor] !== "$" || source[cursor + 1] !== "{" || source[cursor - 1] === "\\") {
                            continue;
                        }
                        pushViolation("日志消息", segmentStart, cursor);
                        const expressionEnd = findTemplateExpressionEnd(source, cursor + 2);
                        cursor = expressionEnd - 1;
                        segmentStart = expressionEnd;
                    }
                    pushViolation("日志消息", segmentStart, end - 1);
                } else {
                    pushViolation("日志消息", index + 1, end - 1);
                }
                index = end - 1;
            } else if (character === "(" || character === "[" || character === "{") {
                depth += 1;
            } else if (character === ")" || character === "]" || character === "}") {
                depth -= 1;
            }
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
