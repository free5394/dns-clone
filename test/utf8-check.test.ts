import { describe, expect, it } from "vitest";
import { getFilesToCheck, getTextFilesToCheck, inspectUtf8, isProbablyBinary } from "../scripts/utf8-check-lib.mjs";

describe("UTF-8 检查", () => {
    it("接受合法 UTF-8 中文", () => {
        expect(inspectUtf8(new TextEncoder().encode("中文"))).toBeNull();
    });

    it("拒绝非法 UTF-8 字节", () => {
        expect(inspectUtf8(new Uint8Array([0xc3, 0x28]))).toBe("非法 UTF-8");
    });

    it("拒绝 UTF-8 BOM", () => {
        expect(inspectUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("包含 UTF-8 BOM");
    });

    it("有暂存内容时只检查暂存文件", () => {
        expect(getFilesToCheck(true, ["staged.ts"], "staged.ts\0unstaged.bin\0")).toEqual(["staged.ts"]);
    });

    it("无暂存内容时检查工作树文件", () => {
        expect(getFilesToCheck(false, [], "staged.ts\0unstaged.ts\0")).toEqual(["staged.ts", "unstaged.ts"]);
    });

    it("将标记为 -text 但非二进制的 patch 当作文本检查", () => {
        const attributes = [
            "change.patch",
            "text",
            "unset",
            "change.patch",
            "binary",
            "unspecified",
            "image.png",
            "text",
            "unset",
            "image.png",
            "binary",
            "set",
            "",
        ].join("\0");

        expect(getTextFilesToCheck(attributes)).toEqual([{ file: "change.patch", usesAutoDetection: false }]);
    });

    it("识别含 NUL 字节的二进制内容", () => {
        expect(isProbablyBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))).toBe(true);
    });

    it("普通 UTF-8 内容不视为二进制", () => {
        expect(isProbablyBinary(new TextEncoder().encode("普通文本"))).toBe(false);
    });
});
