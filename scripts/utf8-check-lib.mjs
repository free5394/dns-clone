const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function getFilesToCheck(hasStagedChanges, stagedFiles, listedOutput) {
    const listedFiles = listedOutput.split("\0").filter(Boolean);
    return hasStagedChanges ? stagedFiles : listedFiles;
}

export function isProbablyBinary(bytes) {
    return bytes.subarray(0, 8000).includes(0);
}

export function inspectUtf8(bytes) {
    if (bytes.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => bytes[index] === byte)) {
        return "包含 UTF-8 BOM";
    }

    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return "非法 UTF-8";
    }

    return null;
}
