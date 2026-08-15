// log.ts — 带北京时区时间戳的日志工具
// 从 index.legacy.js 提取（原 1848 行）

/** 给消息加 [北京时区时间戳] 前缀 */
export const beijingTimeLog = (message: string): string =>
    `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${message}`;

/** 通用日志：带时区时间戳输出到 console */
export function log(message: string): void {
    console.log(beijingTimeLog(message));
}
