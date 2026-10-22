import { describe, expect, it } from "vitest";
import { findLanguageViolations, resolveLanguageCheckBase } from "../scripts/language-check-lib.mjs";

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
        const diff = `diff --git a/test/example.test.ts b/test/example.test.ts
--- a/test/example.test.ts
+++ b/test/example.test.ts
@@ -1,1 +1,5 @@
-it("old English title", () => {});
+// it("English title", () => {});
+it("SSE buffer", () => {});
+it("SSE 缓冲", () => {});
+throw new Error("请求失败");
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "test/example.test.ts",
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
                line: 11,
                kind: "测试标题",
                text: '    "English title",',
            },
            {
                file: "test/example.test.ts",
                line: 15,
                kind: "日志消息",
                text: '    "English warning",',
            },
            {
                file: "test/example.test.ts",
                line: 18,
                kind: "错误消息",
                text: '    "English error",',
            },
        ]);
    });

    it("识别只改动多行调用中字符串的英文内容", () => {
        const diff = `diff --git a/test/example.test.ts b/test/example.test.ts
--- a/test/example.test.ts
+++ b/test/example.test.ts
@@ -10,6 +10,14 @@
 it(
+
+
+
+
-    "中文标题",
+    "English title",
     () => {},
 );
 console.warn(
-    "中文警告",
+    "English warning",
 );
 throw new Error(
-    "中文错误",
+    "English error",
 );
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "test/example.test.ts",
                line: 15,
                kind: "测试标题",
                text: '    "English title",',
            },
            {
                file: "test/example.test.ts",
                line: 19,
                kind: "日志消息",
                text: '    "English warning",',
            },
            {
                file: "test/example.test.ts",
                line: 22,
                kind: "错误消息",
                text: '    "English error",',
            },
        ]);
    });

    it("识别任意 console 方法的英文消息", () => {
        const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,0 +1,1 @@
+console.table("English table");
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "src/example.ts",
                line: 1,
                kind: "日志消息",
                text: 'console.table("English table");',
            },
        ]);
    });

    it("识别任意代码位置的英文日志与错误消息", () => {
        const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,0 +1,18 @@
+if (ready) console.warn("English warning");
+if (ready) throw new Error("English error");
+if (ready) { console.warn("English warning with brace"); }
+if (ready) { throw new Error("English error with brace"); }
+const warn = () => console.warn("English arrow");
+void console.error("English void");
+foo(); console.log("English same line");
+const optional = console?.warn("English optional");
+console.log(value, "English second argument");
+hostnamePattern.test("English");
+const warning = "console.warn('English')";
+const error = "throw new Error('English')";
+const pattern = /console\\.warn\\("English"\\)/;
+console.log(getValue(), "English after nested call");
+console.log("中文", "English second argument");
+const sample = \`console.log("English sample")\`;
+console.log("请求完成", t("English payload"));
+console.log("查询结果：", JSON.stringify({ status: "ok" }));
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "src/example.ts",
                line: 1,
                kind: "日志消息",
                text: 'if (ready) console.warn("English warning");',
            },
            {
                file: "src/example.ts",
                line: 2,
                kind: "错误消息",
                text: 'if (ready) throw new Error("English error");',
            },
            {
                file: "src/example.ts",
                line: 3,
                kind: "日志消息",
                text: 'if (ready) { console.warn("English warning with brace"); }',
            },
            {
                file: "src/example.ts",
                line: 4,
                kind: "错误消息",
                text: 'if (ready) { throw new Error("English error with brace"); }',
            },
            {
                file: "src/example.ts",
                line: 5,
                kind: "日志消息",
                text: 'const warn = () => console.warn("English arrow");',
            },
            {
                file: "src/example.ts",
                line: 6,
                kind: "日志消息",
                text: 'void console.error("English void");',
            },
            {
                file: "src/example.ts",
                line: 7,
                kind: "日志消息",
                text: 'foo(); console.log("English same line");',
            },
            {
                file: "src/example.ts",
                line: 8,
                kind: "日志消息",
                text: 'const optional = console?.warn("English optional");',
            },
            {
                file: "src/example.ts",
                line: 9,
                kind: "日志消息",
                text: 'console.log(value, "English second argument");',
            },
            {
                file: "src/example.ts",
                line: 14,
                kind: "日志消息",
                text: 'console.log(getValue(), "English after nested call");',
            },
            {
                file: "src/example.ts",
                line: 15,
                kind: "日志消息",
                text: 'console.log("中文", "English second argument");',
            },
        ]);
    });

    it("识别模板插值中的英文日志", () => {
        const diff = [
            "diff --git a/src/ui/templates.js b/src/ui/templates.js",
            "--- a/src/ui/templates.js",
            "+++ b/src/ui/templates.js",
            "@@ -1,0 +1,1 @@",
            '+const page = `${console.warn("English interpolation")}`;',
            "",
        ].join("\n");

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "src/ui/templates.js",
                line: 1,
                kind: "日志消息",
                text: 'const page = `${console.warn("English interpolation")}`;',
            },
        ]);
    });

    it("识别 each 表格测试的英文标题", () => {
        const diff = `diff --git a/test/example.test.ts b/test/example.test.ts
--- a/test/example.test.ts
+++ b/test/example.test.ts
@@ -1,0 +1,10 @@
+it.each([1, 2])("English title", () => {});
+describe.each([1, 2])("English suite", () => {});
+it.each([
+    [1, "value"],
+])("English multiline", () => {});
+it.concurrent.each([1])("English concurrent", () => {});
+test.skip.each({ a: 1 })("English skipped", () => {});
+it.skipIf(condition)("English skipIf", () => {});
+describe.runIf(condition)("English runIf", () => {});
+describe.for([1])("English for", () => {});
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "test/example.test.ts",
                line: 1,
                kind: "测试标题",
                text: 'it.each([1, 2])("English title", () => {});',
            },
            {
                file: "test/example.test.ts",
                line: 2,
                kind: "测试标题",
                text: 'describe.each([1, 2])("English suite", () => {});',
            },
            {
                file: "test/example.test.ts",
                line: 5,
                kind: "测试标题",
                text: '])("English multiline", () => {});',
            },
            {
                file: "test/example.test.ts",
                line: 6,
                kind: "测试标题",
                text: 'it.concurrent.each([1])("English concurrent", () => {});',
            },
            {
                file: "test/example.test.ts",
                line: 7,
                kind: "测试标题",
                text: 'test.skip.each({ a: 1 })("English skipped", () => {});',
            },
            {
                file: "test/example.test.ts",
                line: 8,
                kind: "测试标题",
                text: 'it.skipIf(condition)("English skipIf", () => {});',
            },
            {
                file: "test/example.test.ts",
                line: 9,
                kind: "测试标题",
                text: 'describe.runIf(condition)("English runIf", () => {});',
            },
            {
                file: "test/example.test.ts",
                line: 10,
                kind: "测试标题",
                text: 'describe.for([1])("English for", () => {});',
            },
        ]);
    });

    it("识别 sequential、test 别名与嵌套条件的测试标题", () => {
        const diff = `diff --git a/test/example.test.ts b/test/example.test.ts
--- a/test/example.test.ts
+++ b/test/example.test.ts
@@ -1,0 +1,3 @@
+it.sequential("English sequential");
+it.skipIf(check())("English nested condition");
+test("English test alias");
`;

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "test/example.test.ts",
                line: 1,
                kind: "测试标题",
                text: 'it.sequential("English sequential");',
            },
            {
                file: "test/example.test.ts",
                line: 2,
                kind: "测试标题",
                text: 'it.skipIf(check())("English nested condition");',
            },
            {
                file: "test/example.test.ts",
                line: 3,
                kind: "测试标题",
                text: 'test("English test alias");',
            },
        ]);
    });

    it("不把业务代码中的同名 it 调用当作测试标题", () => {
        const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,0 +1,1 @@
+it("English business call");
`;

        expect(findLanguageViolations(diff)).toEqual([]);
    });

    it("不报告模板插值前后的空静态段", () => {
        const diff = [
            "diff --git a/src/example.ts b/src/example.ts",
            "--- a/src/example.ts",
            "+++ b/src/example.ts",
            "@@ -1,0 +1,3 @@",
            "+console.log(`请求失败 ${details}`);",
            "+console.log(`${details} 请求失败`);",
            "+console.error(`${file}：${details}`);",
            "",
        ].join("\n");

        expect(findLanguageViolations(diff)).toEqual([]);
    });

    it("识别以双加号开头的新增源码行", () => {
        const diff = [
            "diff --git a/src/example.ts b/src/example.ts",
            "--- a/src/example.ts",
            "+++ b/src/example.ts",
            "@@ -1,0 +1,2 @@",
            '+++counter; console.warn("English warning");',
            "+const next = counter + 1;",
            "",
        ].join("\n");

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "src/example.ts",
                line: 1,
                kind: "日志消息",
                text: '++counter; console.warn("English warning");',
            },
        ]);
    });

    it("首次推送多个提交时从最早提交前开始检查", () => {
        const calls = [];
        const base = resolveLanguageCheckBase("0".repeat(40), "最早提交", (commit) => {
            calls.push(commit);
            return "最早提交 父提交";
        });

        expect(base).toBe("父提交");
        expect(calls).toEqual(["最早提交"]);
    });

    it("识别 HTML 模板内联脚本中的英文日志与错误消息", () => {
        const diff = [
            "diff --git a/src/ui/templates.js b/src/ui/templates.js",
            "--- a/src/ui/templates.js",
            "+++ b/src/ui/templates.js",
            "@@ -1,0 +1,7 @@",
            "+const page = `",
            "+<script>",
            '+console.warn("English inline warning");',
            '+throw new Error("English inline error");',
            "+</script>",
            "+`;",
            "",
        ].join("\n");

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "src/ui/templates.js",
                line: 3,
                kind: "日志消息",
                text: 'console.warn("English inline warning");',
            },
            {
                file: "src/ui/templates.js",
                line: 4,
                kind: "错误消息",
                text: 'throw new Error("English inline error");',
            },
        ]);
    });

    it("识别裸脚本模板中的英文日志与错误消息", () => {
        const diff = [
            "diff --git a/src/ui/templates.js b/src/ui/templates.js",
            "--- a/src/ui/templates.js",
            "+++ b/src/ui/templates.js",
            "@@ -1,0 +1,6 @@",
            "+const script = `",
            '+console.warn("English raw warning");',
            '+throw new Error("English raw error");',
            "+`;",
            "",
        ].join("\n");

        expect(findLanguageViolations(diff)).toEqual([
            {
                file: "src/ui/templates.js",
                line: 2,
                kind: "日志消息",
                text: 'console.warn("English raw warning");',
            },
            {
                file: "src/ui/templates.js",
                line: 3,
                kind: "错误消息",
                text: 'throw new Error("English raw error");',
            },
        ]);
    });

    it("不报告测试 fixture 中 HTML 脚本模板的英文内容", () => {
        const diff = [
            "diff --git a/test/example.test.ts b/test/example.test.ts",
            "--- a/test/example.test.ts",
            "+++ b/test/example.test.ts",
            "@@ -1,0 +1,6 @@",
            "+const fixture = `",
            "+<script>",
            '+console.warn("English fixture");',
            "+</script>",
            "+`;",
            "",
        ].join("\n");

        expect(findLanguageViolations(diff)).toEqual([]);
    });

    it("不报告调用之外改动的存量英文标题", () => {
        const diff = [
            "diff --git a/test/example.test.ts b/test/example.test.ts",
            "--- a/test/example.test.ts",
            "+++ b/test/example.test.ts",
            "@@ -10,6 +10,7 @@",
            " it(",
            '     "Existing English title",',
            "     () => {",
            "+        run();",
            "     },",
            " );",
            "",
        ].join("\n");

        expect(findLanguageViolations(diff)).toEqual([]);
    });
});
