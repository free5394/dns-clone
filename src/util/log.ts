// log.ts — 带北京时区时间戳的日志工具
// 从 index.legacy.js 提取（原 1848 行）

/** 给消息加 [北京时区时间戳] 前缀 */
export const beijingTimeLog = (message: string): string =>
    `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${message}`;
