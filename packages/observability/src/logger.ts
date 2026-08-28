import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino'
import { REDACTED, defaultRedactPaths } from './redaction'

/** 结构化日志基础字段。runId 用于把日志、SSE 事件与快照关联起来。 */
export interface LogBindings {
  readonly service: string
  readonly profile?: string
  readonly tenantId?: string
  readonly runId?: string
}

export interface CreateLoggerOptions {
  readonly bindings: LogBindings
  /** 默认取 `LOG_LEVEL`，缺省 `info`。 */
  readonly level?: string
  /** 追加的 redact 路径，与默认脱敏路径合并。 */
  readonly extraRedactPaths?: readonly string[]
  /** 仅供测试注入目标流；生产不传，走 stdout。 */
  readonly destination?: DestinationStream
}

/**
 * 创建服务级 logger。
 *
 * 默认强制脱敏，调用方不能关闭：日志目的地是运维排查，不是内容留存。
 * 长期内容副本只存在于对象存储快照（ADR-0030）。
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info'
  const loggerOptions: LoggerOptions = {
    level,
    base: { ...options.bindings },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [...defaultRedactPaths, ...(options.extraRedactPaths ?? [])],
      censor: REDACTED,
      remove: false,
    },
  }
  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions)
}

export type { Logger }
