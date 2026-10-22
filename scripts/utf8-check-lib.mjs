const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function selectFilesToCheck(hasStagedChanges, stagedFiles, listedFiles) {
    return hasStagedChanges ? stagedFiles : listedFiles;
}

export function isProbablyBinary(bytes) {
    return bytes.subarray(0, 8000).includes(0);
}

export function inspectUtf8(bytes) {
    if (bytes.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => bytes[index] === byte)) {
        return "包含 UTF-8 BOM";
    }

    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return "非法 UTF-8";
    }

    if (text.includes("\uFFFD")) {
        return "包含 U+FFFD 替换字符";
    }

    return null;
}
