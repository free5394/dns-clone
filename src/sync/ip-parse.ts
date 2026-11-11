// ip-parse.ts — 统一内容解析层（issue #48）
// 依据 docs/ip-fetch-unification-plan.md §7.2 / §7.4 / §15.1。
// 输入任意响应正文 + 解析配置，输出严格校验后的 { ipv4, ipv6 }：
//   auto        全文提取（HTML / JSON / 纯文本）
//   lines       按行与逗号 / 空白分 token，逐 token 严格校验
//   json_path   JSON 点路径（支持数组索引），取值字符串或字符串数组
//   custom_regex 用户正则，取捕获组 1 或命名组 ip
// 解析层自身不抛错：正文为空、非 JSON、路径不存在、正则不可构造一律按「未匹配」返回空结果；
// 配置错误由 validateParseConfig 在保存 / 探测入口拦截（同一套规则，避免两处漂移）。

import { canonicalizeIpv6, classifyIp, extractIpv4, extractIpv6, sortIpv4, sortIpv6 } from "../util/ip.ts";

/** 解析模式白名单；NULL / 空串 / 未知值在读取侧按 auto 处理 */
export const PARSE_MODES = ["auto", "lines", "json_path", "custom_regex"] as const;
export type ParseMode = (typeof PARSE_MODES)[number];
export const DEFAULT_PARSE_MODE: ParseMode = "auto";

/** json_path 点路径长度上限（与 API 校验矩阵一致） */
export const MAX_JSON_PATH_LENGTH = 512;
/** custom_regex 正则长度上限（§7.4） */
export const MAX_REGEX_LENGTH = 200;
/** 运行期正文截断上限：正则 / JSON 解析的兜底（§7.4，模块内部常量） */
const MAX_PARSE_CONTENT_BYTES = 512 * 1024;

const MODE_ERROR = `解析模式非法：仅支持 ${PARSE_MODES.join("、")}。`;

/** 类型守卫：字符串是否在白名单内 */
function isParseMode(value: string): value is ParseMode {
    return (PARSE_MODES as readonly string[]).includes(value);
}

/** 把任意原始值归一为解析模式：NULL / 空串 / 未知值一律回退 auto */
export function normalizeParseMode(raw: unknown): ParseMode {
    if (typeof raw !== "string") return DEFAULT_PARSE_MODE;
    const trimmed = raw.trim();
    return isParseMode(trimmed) ? trimmed : DEFAULT_PARSE_MODE;
}

/** 校验结果：成功时回传归一后的模式与参数，失败时回传中文文案 */
export type ParseConfigValidation = { ok: true; mode: ParseMode; param: string | null } | { ok: false; error: string };

/**
 * 保存与探测共用的解析配置校验。
 * - 模式必须在白名单内；NULL / 空串按 auto。
 * - json_path 必填点路径、≤512 字符、点号分段不允许空段。
 * - custom_regex 必填、≤200 字符、必须能构造且通过嵌套量词等高风险形态的静态拦截。
 * - auto / lines 不使用参数，残留参数归一为 null（数据模型要求其余模式 parse_param 为 NULL）。
 */
export function validateParseConfig(mode: unknown, param: unknown): ParseConfigValidation {
    if (mode !== undefined && mode !== null) {
        if (typeof mode !== "string") return { ok: false, error: MODE_ERROR };
        const trimmed = mode.trim();
        if (trimmed !== "" && !isParseMode(trimmed)) return { ok: false, error: MODE_ERROR };
    }

    const normalizedMode = normalizeParseMode(mode);

    if (normalizedMode === "json_path") {
        if (typeof param !== "string" || param.trim().length === 0) {
            return { ok: false, error: "json_path 模式必须填写 JSON 点路径。" };
        }
        // 保存值统一去掉首尾空白，避免「能保存、永远取不到」的路径
        const path = param.trim();
        if (path.length > MAX_JSON_PATH_LENGTH) {
            return { ok: false, error: `JSON 点路径长度不能超过 ${MAX_JSON_PATH_LENGTH} 个字符。` };
        }
        if (!isWellFormedJsonPath(path)) {
            return { ok: false, error: "JSON 点路径不能以点开头或结尾，也不能包含连续的点造成空段。" };
        }
        return { ok: true, mode: normalizedMode, param: path };
    }

    if (normalizedMode === "custom_regex") {
        if (typeof param !== "string") {
            return { ok: false, error: "custom_regex 模式必须填写正则表达式。" };
        }
        if (param.length === 0) {
            return { ok: false, error: "custom_regex 模式必须填写正则表达式。" };
        }
        if (param.length > MAX_REGEX_LENGTH) {
            return { ok: false, error: `正则表达式长度不能超过 ${MAX_REGEX_LENGTH} 个字符。` };
        }
        try {
            // 不带 new 调用 RegExp：等价于 new RegExp，仅用于探测可构造性
            RegExp(param);
        } catch {
            // 不拼接底层引擎文案（英文），保持用户可见错误为中文
            return { ok: false, error: "正则表达式无法构造，请检查语法后重试。" };
        }
        if (!isSafeRegexPattern(param)) {
            return { ok: false, error: "正则表达式存在嵌套量词等高风险形态，请简化后重试。" };
        }
        return { ok: true, mode: normalizedMode, param };
    }

    return { ok: true, mode: normalizedMode, param: null };
}

/** 点路径形态：非空、无首尾点、无连续点导致的空段 */
function isWellFormedJsonPath(path: string): boolean {
    if (path.startsWith(".") || path.endsWith(".") || path.includes("..")) return false;
    return path.split(".").every((segment) => segment.length > 0);
}

/**
 * 正则静态防护（§7.4）：在保存 / 探测入口拒绝常见的指数回溯形态。
 * 判定两类：① 被无上界量词包裹的分组内部含无上界量词（`(a+)+`、`(\d+){2,}`）；
 * ② 被无上界量词包裹的交替分支首字符类别重叠（`(a|a)*`、`(a|ab)+`、`(a|.)*`）。
 * 有上界量词（`{3}`、`{2,5}`）不构成嵌套风险，避免误杀 `(\d{1,3}\.){3}\d{1,3}`。
 * 括号不平衡直接视为不安全（不可构造的正则由 validateParseConfig 先拦）。
 */
export function isSafeRegexPattern(pattern: string): boolean {
    const parser = new RegexSafetyParser(pattern);
    return parser.parseAll();
}

const WORD_CHAR_RE = /^\w$/;

/** 首字符类别之间的重叠关系；字符类 `[...]` 保守按 any 处理 */
function classesOverlap(a: string, b: string): boolean {
    if (a === b) return true;
    if (a === "any" || b === "any") return true;
    const literal = (cls: string): string => cls.slice(4); // "lit:" 前缀
    const isLit = (cls: string): boolean => cls.startsWith("lit:");

    if (a === "digit") return b === "word" || (isLit(b) && /[0-9]/.test(literal(b)));
    if (b === "digit") return a === "word" || (isLit(a) && /[0-9]/.test(literal(a)));
    if (a === "word") return isLit(b) && WORD_CHAR_RE.test(literal(b));
    if (b === "word") return isLit(a) && WORD_CHAR_RE.test(literal(a));
    if (a === "space") return isLit(b) && /^\s$/.test(literal(b));
    if (b === "space") return isLit(a) && /^\s$/.test(literal(a));
    return isLit(a) && isLit(b) && literal(a) === literal(b);
}

interface AtomInfo {
    firstClasses: Set<string>;
    nullable: boolean;
    containsUnbounded: boolean;
}

interface AlternationInfo extends AtomInfo {
    alternation: boolean;
    /** 逐分支的首字符类别，用于判断量化交替的回溯歧义 */
    branchFirstClasses: Set<string>[];
}

interface QuantifierInfo {
    unbounded: boolean;
    nullable: boolean;
}

class RegexSafetyParser {
    private index = 0;
    private risky = false;
    private validSyntax = true;

    constructor(private readonly pattern: string) {}

    parseAll(): boolean {
        this.parseAlternation();
        if (this.index < this.pattern.length) this.validSyntax = false;
        return this.validSyntax && !this.risky;
    }

    private get done(): boolean {
        return this.index >= this.pattern.length;
    }

    private peek(): string {
        return this.pattern[this.index] ?? "";
    }

    private next(): string {
        return this.pattern[this.index++] ?? "";
    }

    private parseAlternation(): AlternationInfo {
        const branches: AtomInfo[] = [this.parseSequence()];
        while (this.peek() === "|") {
            this.index++;
            branches.push(this.parseSequence());
        }

        const firstClasses = new Set<string>();
        let nullable = false;
        let containsUnbounded = false;
        for (const branch of branches) {
            for (const cls of branch.firstClasses) firstClasses.add(cls);
            nullable ||= branch.nullable;
            containsUnbounded ||= branch.containsUnbounded;
        }
        return {
            firstClasses,
            nullable,
            containsUnbounded,
            alternation: branches.length > 1,
            branchFirstClasses: branches.map((branch) => branch.firstClasses),
        };
    }

    private parseSequence(): AtomInfo {
        const firstClasses = new Set<string>();
        let prefixNullable = true;
        let nullable = true;
        let containsUnbounded = false;

        while (!this.done && this.peek() !== "|" && this.peek() !== ")") {
            const atom = this.parseAtom();
            if (prefixNullable) for (const cls of atom.firstClasses) firstClasses.add(cls);
            prefixNullable &&= atom.nullable;
            nullable &&= atom.nullable;
            containsUnbounded ||= atom.containsUnbounded;
        }

        return { firstClasses, nullable, containsUnbounded };
    }

    private parseAtom(): AtomInfo {
        const ch = this.peek();
        if (ch === "(") return this.parseGroup();
        if (ch === "[") return this.parseCharClass();
        if (ch === "\\") return this.parseEscape();

        this.index++;
        const quantifier = this.parseQuantifier();
        if (ch === "^" || ch === "$") {
            return { firstClasses: new Set(), nullable: true, containsUnbounded: false };
        }
        return {
            // `.` 匹配任意字符；若记成字面量会漏判 `(a|.)*` 这类分支重叠的灾难回溯
            firstClasses: new Set([ch === "." ? "any" : `lit:${ch}`]),
            nullable: quantifier?.nullable ?? false,
            containsUnbounded: quantifier?.unbounded ?? false,
        };
    }

    private parseGroup(): AtomInfo {
        this.index++; // "("

        let zeroWidth = false;
        if (this.peek() === "?") {
            this.index++;
            const kind = this.peek();
            if (kind === ":" || kind === "=" || kind === "!") {
                this.index++;
                zeroWidth = kind !== ":";
            } else if (kind === "<") {
                this.index++;
                const sub = this.peek();
                if (sub === "=" || sub === "!") {
                    this.index++;
                    zeroWidth = true;
                } else {
                    while (!this.done && this.peek() !== ">") this.index++;
                    if (this.peek() !== ">") {
                        this.validSyntax = false;
                        return { firstClasses: new Set(), nullable: true, containsUnbounded: false };
                    }
                    this.index++; // ">"
                }
            } else {
                // 未知分组前缀（如 (?i)）：JS 无法构造，按不安全处理
                this.validSyntax = false;
                return { firstClasses: new Set(), nullable: true, containsUnbounded: false };
            }
        }

        const body = this.parseAlternation();
        if (this.peek() === ")") this.index++;
        else this.validSyntax = false;

        const quantifier = this.parseQuantifier();
        if (quantifier?.unbounded) {
            if (body.containsUnbounded) this.risky = true;
            else if (body.alternation && this.hasOverlappingBranches(body)) this.risky = true;
        }

        return {
            firstClasses: zeroWidth ? new Set() : body.firstClasses,
            nullable: zeroWidth ? true : body.nullable || (quantifier?.nullable ?? false),
            containsUnbounded: body.containsUnbounded || (quantifier?.unbounded ?? false),
        };
    }

    /** 交替分支的首字符类别是否两两重叠；重叠才有回溯歧义 */
    private hasOverlappingBranches(body: AlternationInfo): boolean {
        return body.branchFirstClasses.some((left, i) =>
            body.branchFirstClasses
                .slice(i + 1)
                .some((right) => [...left].some((a) => [...right].some((b) => classesOverlap(a, b))))
        );
    }

    private parseCharClass(): AtomInfo {
        this.index++; // "["
        if (this.peek() === "^") this.index++;
        if (this.peek() === "]") this.index++;
        while (!this.done && this.peek() !== "]") {
            if (this.peek() === "\\") this.index++;
            this.index++;
        }
        if (this.peek() === "]") this.index++;
        else this.validSyntax = false;

        const quantifier = this.parseQuantifier();
        return {
            firstClasses: new Set(["any"]),
            nullable: quantifier?.nullable ?? false,
            containsUnbounded: quantifier?.unbounded ?? false,
        };
    }

    private parseEscape(): AtomInfo {
        this.index++; // "\\"
        if (this.done) {
            this.validSyntax = false;
            return { firstClasses: new Set(), nullable: true, containsUnbounded: false };
        }

        const ch = this.next();
        let cls: string | null = null;
        if (ch === "d") cls = "digit";
        else if (ch === "w") cls = "word";
        else if (ch === "s") cls = "space";
        else if ("DWS".includes(ch)) cls = "any";
        else if (ch === "p" || ch === "P" || ch === "u" || ch === "x") {
            cls = "any";
            if (this.peek() === "{") {
                while (!this.done && this.next() !== "}") {
                    // 跳过属性名 / 码点转义的内容
                }
            }
        } else if ("bB".includes(ch)) {
            cls = null; // 零宽断言
        } else if (/[0-9]/.test(ch)) {
            cls = "any"; // 反向引用：按任意字符保守处理
        } else {
            cls = `lit:${ch}`;
        }

        const quantifier = this.parseQuantifier();
        return {
            firstClasses: cls ? new Set([cls]) : new Set(),
            nullable: cls === null || (quantifier?.nullable ?? false),
            containsUnbounded: quantifier?.unbounded ?? false,
        };
    }

    private parseQuantifier(): QuantifierInfo | null {
        const ch = this.peek();
        if (ch === "*" || ch === "+") {
            this.index++;
            if (this.peek() === "?") this.index++;
            return { unbounded: true, nullable: true };
        }
        if (ch === "?") {
            this.index++;
            if (this.peek() === "?") this.index++;
            return { unbounded: false, nullable: true };
        }
        if (ch === "{") {
            const match = /^\{(\d+)(,(\d*))?\}/.exec(this.pattern.slice(this.index));
            if (!match) return null;
            this.index += match[0].length;
            if (this.peek() === "?") this.index++;
            const unbounded = match[2] !== undefined && match[3] === "";
            return { unbounded, nullable: Number(match[1]) === 0 };
        }
        return null;
    }
}

/** 解析结果：两类地址各自去重并排序 */
export interface ParsedIps {
    ipv4: string[];
    ipv6: string[];
}

/**
 * 统一解析入口（§7.1）：正文 + 配置 → `{ ipv4, ipv6 }`。
 * 配置非法时返回空结果（错误由 validateParseConfig 在保存 / 探测入口返回给用户），
 * 正文为空、无匹配、非 JSON、路径不存在、正则不可构造一律按未匹配处理，不抛错。
 * 结果统一走「严格校验 → 去重 → IPv4 数值升序 / IPv6 规范化字典序」（§7.3）。
 */
export function parseContent(text: string, mode: unknown, param?: unknown): ParsedIps {
    const config = validateParseConfig(mode, param);
    if (!config.ok) return { ipv4: [], ipv6: [] };

    const content = truncateContent(typeof text === "string" ? text : "");
    if (content.length === 0) return { ipv4: [], ipv6: [] };

    const ips: ParsedIps = { ipv4: [], ipv6: [] };

    switch (config.mode) {
        case "auto":
            ips.ipv4.push(...extractIpv4(content));
            ips.ipv6.push(...extractIpv6(content));
            break;
        case "lines":
            for (const token of content.split(/[\s,]+/)) addClassifiedToken(token, ips);
            break;
        case "json_path":
            collectJsonPathValues(content, config.param ?? "", ips);
            break;
        case "custom_regex":
            collectCustomRegexValues(content, config.param ?? "", ips);
            break;
    }

    // IPv6 先规范化为 RFC 5952 写法再去重：等价地址（压缩写法 / 全零段写法）只保留一条
    const ipv6 = [...new Set(ips.ipv6.map((value) => canonicalizeIpv6(value) ?? value))];
    return { ipv4: sortIpv4([...new Set(ips.ipv4)]), ipv6: sortIpv6(ipv6) };
}

/**
 * 运行期正文按 UTF-8 字节截断，避免超长正文把正则 / JSON 解析拖进长尾（§7.4 的兜底要求）。
 * 四种模式统一生效：截断是确定性安全边界，不因模式切换而失效；json_path 下被截断的 JSON
 * 按「未匹配」处理，与其它解析失败路径一致。
 */
function truncateContent(text: string): string {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= MAX_PARSE_CONTENT_BYTES) return text;
    return new TextDecoder().decode(bytes.slice(0, MAX_PARSE_CONTENT_BYTES));
}

/** 单 token 严格校验后按类型入桶；伪地址直接丢弃 */
function addClassifiedToken(token: string, ips: ParsedIps): void {
    const classified = classifyIp(token);
    if (classified === null) return;
    ips[classified.type].push(classified.value);
}

function collectJsonPathValues(content: string, path: string, ips: ParsedIps): void {
    let root: unknown;
    try {
        root = JSON.parse(content);
    } catch {
        return; // 正文不是 JSON：按未匹配处理
    }

    const value = readJsonPath(root, path);
    if (typeof value === "string") {
        addClassifiedToken(value, ips);
    } else if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === "string") addClassifiedToken(item, ips);
        }
    }
}

/** 按点路径逐段下钻：数组用数字索引，对象只认自有属性（挡住 constructor / __proto__） */
function readJsonPath(root: unknown, path: string): unknown {
    let current: unknown = root;
    for (const segment of path.split(".")) {
        if (Array.isArray(current)) {
            if (!/^\d+$/.test(segment)) return undefined;
            current = current[Number(segment)];
        } else if (current !== null && typeof current === "object") {
            if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
            current = (current as Record<string, unknown>)[segment];
        } else {
            return undefined;
        }
        if (current === undefined) return undefined;
    }
    return current;
}

function collectCustomRegexValues(content: string, pattern: string, ips: ParsedIps): void {
    // 配置已校验，这里只做运行期兜底：构造失败或未过静态防护都按未匹配处理
    if (!isSafeRegexPattern(pattern)) return;
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, "g");
    } catch {
        return;
    }

    for (const match of content.matchAll(regex)) {
        // 命名组 ip 优先，其次捕获组 1；都没有捕获值视为未匹配（不做 match[0] 兜底）
        const captured = match.groups?.ip ?? match[1];
        if (typeof captured === "string" && captured.length > 0) {
            addClassifiedToken(captured, ips);
        }
    }
}
