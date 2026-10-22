import { describe, expect, it } from "vitest";
import { findLanguageViolations } from "../scripts/language-check-lib.mjs";

describe("语言门禁解析", () => {
    it("只报告新增行中的英文测试标题与错误消息", () => {
        const diff = `diff --git a/test/example.test.ts b/test/example.test.ts
--- a/test/example.test.ts
+++ b/test/example.test.ts
@@ -1,2 +1,7 @@
-it("old English title", () => {});
+it("新的中文标题", () => {});
+describe("设置", () => {});
+it("English title", () => {});
+throw new Error("English error");
+throw new Error("中文错误");
+console.warn("English warning");
+console.warn("中文警告");
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "test/example.test.ts",
                line: 3,
                kind: "测试标题",
                text: 'it("English title", () => {});',
            },
            {
                file: "test/example.test.ts",
                line: 4,
                kind: "错误消息",
                text: 'throw new Error("English error");',
            },
            {
                file: "test/example.test.ts",
                line: 6,
                kind: "日志消息",
                text: 'console.warn("English warning");',
            },
        ]);
    });

    it("忽略注释、删除行与不含中文字符的技术术语标题", () => {
        const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,1 +1,5 @@
-it("old English title", () => {});
+// it("English title", () => {});
+it("SSE buffer", () => {});
+it("SSE 缓冲", () => {});
+throw new Error("请求失败");
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "src/example.ts",
                line: 2,
                kind: "测试标题",
                text: 'it("SSE buffer", () => {});',
            },
        ]);
    });

    it("识别跨行的测试标题、日志与错误消息", () => {
        const diff = `diff --git a/test/example.test.ts b/test/example.test.ts
--- a/test/example.test.ts
+++ b/test/example.test.ts
@@ -10,0 +10,9 @@
+it(
+    "English title",
+    () => {},
+);
+console.warn(
+    "English warning",
+);
+throw new Error(
+    "English error",
+);
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "test/example.test.ts",
                line: 10,
                kind: "测试标题",
                text: "it(",
            },
            {
                file: "test/example.test.ts",
                line: 14,
                kind: "日志消息",
                text: "console.warn(",
            },
            {
                file: "test/example.test.ts",
                line: 17,
                kind: "错误消息",
                text: "throw new Error(",
            },
        ]);
    });
});
