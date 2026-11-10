#!/usr/bin/env node
// merge-pr.mjs — 放行式合并：head 与放行 hash 一致、且 PR 处于可合状态时才动手。
// 用法：node scripts/merge-pr.mjs <pr-number> <expected-head-sha>
//
// 存在理由（事故记录，勿删）：2026-11-09 一次合并由「已被撤销 attempt 的只读评审成员」执行，
// 好在合入的字节正是评审通过版；若它合并的是别的提交，没人能发现。此后合并只走本脚本：
// 放行方必须给出目标 head，脚本在动手前现查并比对，不一致直接拒绝。

import { execFileSync } from "node:child_process";

/** 调 gh 并返回 stdout；失败直接抛出，由顶层捕获。 */
function gh(args) {
    return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

/** 拒绝合并：打印原因并以非零码退出，不产生任何远端副作用。 */
function fail(message) {
    console.error(`[merge-pr] 拒绝合并：${message}`);
    process.exit(1);
}

const [prArg, expectedArg] = process.argv.slice(2);
if (!prArg || !expectedArg) fail("用法：node scripts/merge-pr.mjs <pr-number> <expected-head-sha>");
if (!/^\d+$/.test(prArg)) fail(`PR 编号必须是数字，收到 ${prArg}`);
if (!/^[0-9a-f]{7,40}$/.test(expectedArg)) {
    fail(`放行 hash 必须是 7-40 位小写十六进制，收到 ${expectedArg}`);
}

const info = JSON.parse(gh(["pr", "view", prArg, "--json", "state,mergeable,mergeStateStatus,headRefOid,baseRefName"]));

// 先核对对象，再谈动作：顺序颠倒就是「先合了再说」。
if (!info.headRefOid.startsWith(expectedArg)) {
    fail(`head 不匹配：PR #${prArg} 当前 ${info.headRefOid}，放行的是 ${expectedArg}`);
}
if (info.state !== "OPEN") fail(`PR #${prArg} 状态是 ${info.state}，不是 OPEN`);
if (info.mergeable !== "MERGEABLE") fail(`PR #${prArg} mergeable=${info.mergeable}`);
if (info.mergeStateStatus !== "CLEAN") fail(`PR #${prArg} mergeStateStatus=${info.mergeStateStatus}`);

gh(["pr", "merge", prArg, "--merge", "--delete-branch"]);

const after = JSON.parse(gh(["pr", "view", prArg, "--json", "state,mergedAt,mergeCommit"]));
if (after.state !== "MERGED") fail(`合并命令执行后状态仍是 ${after.state}，请人工核查`);

// 回执即台账：调用方把这段 JSON 贴回来，不需要再手抄 hash。
console.log(
    JSON.stringify(
        {
            pr: Number(prArg),
            base: info.baseRefName,
            head: info.headRefOid,
            expected: expectedArg,
            state: after.state,
            mergedAt: after.mergedAt,
            mergeCommit: after.mergeCommit?.oid ?? null,
        },
        null,
        2
    )
);
