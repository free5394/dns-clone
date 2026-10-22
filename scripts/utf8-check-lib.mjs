const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function getFilesToCheck(hasStagedChanges, stagedFiles, listedOutput) {
    const listedFiles = listedOutput.split("\0").filter(Boolean);
    return hasStagedChanges ? stagedFiles : listedFiles;
}

export function getTextFilesToCheck(attributes) {
    const entries = new Map();
    const parts = attributes.split("\0");

    for (let index = 0; index + 2 < parts.length; index += 3) {
        const [file, attribute, value] = parts.slice(index, index + 3);
        if (!file) {
            continue;
        }
        const entry = entries.get(file) || {};
        entry[attribute] = value;
        entries.set(file, entry);
    }

    return [...entries]
        .filter(([, entry]) => entry.binary !== "set")
        .map(([file, entry]) => ({
            file,
            usesAutoDetection: entry.text === "auto" || entry.text === "unspecified",
        }));
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
