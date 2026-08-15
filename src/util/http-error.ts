// http-error.ts — 携带 HTTP 状态码的错误类（用于替代字符串错误匹配控制流）

/**
 * 携带 HTTP 状态码的错误类，用于替代字符串匹配（如 e.message.includes('404')）。
 * 调用方通过 instanceof + status 字段判断，避免依赖底层错误文案（平台升级可能变更）。
 */
export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'HttpError';
    }
}
