import { describe, expect, it } from "vitest";
import { inspectUtf8, isProbablyBinary, selectFilesToCheck } from "../scripts/utf8-check-lib.mjs";

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

    it("拒绝 U+FFFD 乱码替换符", () => {
        expect(inspectUtf8(new TextEncoder().encode("损坏 \uFFFD"))).toBe("包含 U+FFFD 替换字符");
    });

    it("有暂存内容时只检查暂存文件", () => {
        expect(selectFilesToCheck(true, ["staged.ts"], ["staged.ts", "unstaged.bin"])).toEqual(["staged.ts"]);
    });

    it("无暂存内容时检查工作树文件", () => {
        expect(selectFilesToCheck(false, [], ["staged.ts", "unstaged.ts"])).toEqual(["staged.ts", "unstaged.ts"]);
    });

    it("识别含 NUL 字节的二进制内容", () => {
        expect(isProbablyBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))).toBe(true);
    });

    it("普通 UTF-8 内容不视为二进制", () => {
        expect(isProbablyBinary(new TextEncoder().encode("普通文本"))).toBe(false);
    });
});
