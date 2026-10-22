const TEST_TITLE_PATTERN =
    /^\s*(?:it|test|describe)(?:\.(?:each|skip|only|todo|concurrent|fails))?\s*\(\s*(["'`])(.*?)\1/;
const ERROR_MESSAGE_PATTERN = /^\s*throw\s+new\s+Error\s*\(\s*(["'`])(.*?)\1/;
const LOG_MESSAGE_PATTERN = /^\s*console\.(?:log|info|warn|error|debug)\s*\(\s*(["'`])(.*?)\1/;
const HAN_PATTERN = /\p{Script=Han}/u;

function isComment(line) {
    const trimmed = line.trimStart();
    return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function findViolationKind(line) {
    if (isComment(line)) {
        return null;
    }

    const testTitle = TEST_TITLE_PATTERN.exec(line);
    if (testTitle && !HAN_PATTERN.test(testTitle[2])) {
        return "测试标题";
    }

    const errorMessage = ERROR_MESSAGE_PATTERN.exec(line);
    if (errorMessage && !HAN_PATTERN.test(errorMessage[2])) {
        return "错误消息";
    }

    const logMessage = LOG_MESSAGE_PATTERN.exec(line);
    if (logMessage && !HAN_PATTERN.test(logMessage[2])) {
        return "日志消息";
    }

    return null;
}

export function findLanguageViolations(diff) {
    const violations = [];
    let file = "";
    let nextLine = 0;

    for (const rawLine of diff.split(/\r?\n/)) {
        if (rawLine.startsWith("+++ b/")) {
            file = rawLine.slice("+++ b/".length);
            continue;
        }

        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
        if (hunk) {
            nextLine = Number(hunk[1]);
            continue;
        }

        if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
            const text = rawLine.slice(1);
            const kind = findViolationKind(text);
            if (kind) {
                violations.push({ file, line: nextLine, kind, text });
            }
            nextLine += 1;
            continue;
        }

        if (rawLine.startsWith(" ")) {
            nextLine += 1;
        }
    }

    return violations;
}
