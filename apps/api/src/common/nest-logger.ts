import type { LoggerService } from '@nestjs/common'
import type { Logger } from '@rag/observability'

/**
 * 把 NestJS 框架自身的日志接到 pino。
 *
 * 为什么必须接：`NestFactory.create` 默认用 ConsoleLogger 输出带颜色的纯文本
 * （`[Nest] 123 - ... LOG [NestFactory] ...`）。那条通路完全绕过
 * `@rag/observability` 的 redact 配置——框架级错误（含连接串、鉴权头的异常栈）
 * 会原样进 stdout，而进程输出正是日志采集的唯一入口。同时纯文本行让"每行都是
 * 结构化 JSON"这一条日志契约无法成立，采集侧只能靠正则猜。
 *
 * 约定：Nest 把 context（`NestFactory`、`RoutesResolver` 等）作为最后一个可选参数
 * 传入，这里提取为 `context` 字段；其余参数放进 `details`，不做字符串拼接，
 * 交给 pino 的 redact 处理。
 */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private emit(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    params: unknown[],
  ): void {
    const rest = [...params]
    const last = rest[rest.length - 1]
    const context = typeof last === 'string' ? (rest.pop() as string) : undefined
    const bindings: Record<string, unknown> = { nest: true }
    if (context !== undefined) bindings.context = context
    if (rest.length > 0) bindings.details = rest
    if (message instanceof Error) {
      bindings.err = { name: message.name, message: message.message, stack: message.stack }
      this.logger[level](bindings, message.message)
      return
    }
    if (typeof message === 'string') {
      this.logger[level](bindings, message)
      return
    }
    // 非字符串消息不能 JSON.stringify 进 msg：redact 只作用于对象字段，
    // 一旦拼成字符串就永久绕过脱敏。放进字段让 `*.password` 一类路径生效。
    bindings.payload = message
    this.logger[level](bindings, 'nest log payload')
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params)
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params)
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params)
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params)
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('trace', message, params)
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params)
  }
}
