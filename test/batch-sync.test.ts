// batch-sync.test.ts — M-5：批同步的「单条失败不中断整批」不变量
import { describe, it, expect, vi } from "vitest";
import { forEachIsolated } from "../src/util/batch-sync.ts";

describe("forEachIsolated 批同步编排", () => {
    it("按输入顺序逐条执行", async () => {
        const order: number[] = [];
        await forEachIsolated(
            [1, 2, 3],
            async (item) => {
                order.push(item);
            },
            () => {
                throw new Error("不应有失败");
            }
        );
        expect(order).toEqual([1, 2, 3]);
    });

    it("单条抛错后继续处理后续条目", async () => {
        const done: number[] = [];
        const failed: Array<{ item: number; message: string }> = [];

        await forEachIsolated(
            [1, 2, 3],
            async (item) => {
                if (item === 2) throw new Error(`第 ${item} 条失败`);
                done.push(item);
            },
            (item, e) => failed.push({ item, message: e instanceof Error ? e.message : String(e) })
        );

        expect(done).toEqual([1, 3]);
        expect(failed).toEqual([{ item: 2, message: "第 2 条失败" }]);
    });

    it("连续多条失败也逐条上报，不会提前退出", async () => {
        const onError = vi.fn();
        await forEachIsolated(
            ["a", "b", "c"],
            async () => {
                throw new Error("都失败");
            },
            onError
        );
        expect(onError).toHaveBeenCalledTimes(3);
    });

    it("原样透传非 Error 抛值，交给调用方决定怎么记", async () => {
        const seen: unknown[] = [];
        await forEachIsolated(
            [1],
            async () => {
                throw "字符串异常";
            },
            (_item, e) => seen.push(e)
        );
        expect(seen).toEqual(["字符串异常"]);
    });

    it("空输入不执行任何回调", async () => {
        const run = vi.fn(async () => {});
        const onError = vi.fn();
        await forEachIsolated([], run, onError);
        expect(run).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });
});
