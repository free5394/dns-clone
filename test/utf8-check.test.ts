import { describe, expect, it } from "vitest";
import { inspectUtf8 } from "../scripts/utf8-check-lib.mjs";

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
});
