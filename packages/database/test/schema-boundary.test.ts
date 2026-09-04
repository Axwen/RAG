import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REASON_CODE_PATTERN, auditCategories, auditOutcomes } from '@rag/contracts'
import * as observability from '@rag/observability'
import {
  DATABASE_PACKAGE,
  DATABASE_URL_ENV,
  PRISMA_MIGRATIONS_PATH,
  PRISMA_SCHEMA_PATH,
  requireDatabaseUrl,
} from '../src/index'

const packageRoot = join(__dirname, '..')
const schema = readFileSync(join(packageRoot, PRISMA_SCHEMA_PATH), 'utf8')

/** 枚举体的字面值，按声明顺序。PostgreSQL 的 enum 排序就是声明顺序，所以顺序也是契约。 */
function enumValues(name: string): string[] {
  const match = new RegExp(`^enum ${name} \\{\\n([^}]*)\\n\\}`, 'm').exec(schema)
  if (match?.[1] === undefined) {
    throw new Error(`schema.prisma 里找不到 enum ${name}`)
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
}

const migrationsRoot = join(packageRoot, PRISMA_MIGRATIONS_PATH)
/** 全部迁移 SQL 拼在一起：断言的是「库最终长什么样」，不关心它落在哪个迁移里。 */
const migrations = readdirSync(migrationsRoot)
  .filter((entry) => entry !== 'migration_lock.toml')
  .sort()
  .map((dir) => readFileSync(join(migrationsRoot, dir, 'migration.sql'), 'utf8'))
  .join('\n')

describe('Prisma schema 边界', () => {
  it('包名可用于诊断', () => {
    expect(DATABASE_PACKAGE).toBe('@rag/database')
  })

  it('datasource 是 PostgreSQL', () => {
    expect(schema).toContain('provider = "postgresql"')
  })

  it('schema 内不出现任何连接串（Prisma 7 起 url 只在 prisma.config.ts）', () => {
    // 既排除内联明文，也排除 env() 形式：datasource 块内的 url 在 Prisma 7 已不被支持
    expect(schema).not.toMatch(/^\s*url\s*=/m)
    const config = readFileSync(join(packageRoot, 'prisma.config.ts'), 'utf8')
    expect(config).toContain(`env('${DATABASE_URL_ENV}')`)
    expect(config).not.toMatch(/postgresql:\/\/[^'"\s]*:[^'"\s]+@/)
  })

  it('T1a 领域模型已加入且所有业务表都带 tenantId（§4.1 最高隔离域）', () => {
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1])
    expect(models).toEqual(
      expect.arrayContaining([
        'Tenant',
        'KnowledgeSpace',
        'Document',
        'DocumentVersion',
        'IngestionManifest',
        'RetrievalManifest',
        'AnswerManifest',
        'PipelineManifest',
        'IndexPartition',
        'ReleaseManifest',
      ]),
    )
    for (const model of models) {
      if (model === 'Tenant') {
        continue
      }
      const body = schema.slice(schema.indexOf(`model ${model} {`))
      expect(body.slice(0, body.indexOf('@@')), `model ${model} 缺少 tenantId`).toMatch(
        /tenantId\s+String\s+@db\.Uuid/,
      )
    }
  })

  it('Manifest 内容寻址：(tenantId, contentHash) 唯一，防重复入库', () => {
    for (const model of [
      'IngestionManifest',
      'RetrievalManifest',
      'AnswerManifest',
      'PipelineManifest',
      'ReleaseManifest',
      'DocumentVersion',
    ]) {
      const body = schema.slice(schema.indexOf(`model ${model} {`))
      const modelBody = body.slice(0, body.indexOf('\n}'))
      expect(modelBody).toMatch(/@@unique\(\[tenantId,\s*contentHash\]/)
    }
  })

  it('rerankInputSize 是 RetrievalManifest 必填字段（不带 ? 也无默认值）', () => {
    // 必填且无默认：它必须由注册方显式写入 Manifest，不能退化成隐式配置
    expect(schema).toMatch(/^\s*rerankInputSize\s+Int$/m)
  })

  it('迁移目录固定，且脚本入口只提供 Prisma Migrate', () => {
    expect(PRISMA_MIGRATIONS_PATH).toBe('prisma/migrations')
    const config = readFileSync(join(packageRoot, 'prisma.config.ts'), 'utf8')
    expect(config).toContain(PRISMA_MIGRATIONS_PATH)

    const scripts = (
      JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts['migrate:dev']).toBe('prisma migrate dev')
    expect(scripts['migrate:deploy']).toBe('prisma migrate deploy')
    // db push 会绕过迁移历史，阶段 1 不允许出现在任何脚本入口
    expect(Object.values(scripts).join(' ')).not.toContain('db push')
  })
})

describe('连接串读取', () => {
  it('缺失时明确失败', () => {
    expect(() => requireDatabaseUrl({})).toThrow(DATABASE_URL_ENV)
    expect(() => requireDatabaseUrl({ [DATABASE_URL_ENV]: '   ' })).toThrow(DATABASE_URL_ENV)
  })

  it('存在时原样返回', () => {
    const url = 'postgresql://rag:pw@localhost:5432/rag'
    expect(requireDatabaseUrl({ [DATABASE_URL_ENV]: url })).toBe(url)
  })
})

describe('审计契约与库结构不漂移（ADR-0040 / T11a）', () => {
  it('AuditCategory 七值与契约包的 auditCategories 逐值同序', () => {
    // 契约包故意不 import Prisma 生成类型（领域契约不依赖数据库产物），代价是两处各写一份。
    // 顺序也断言：PostgreSQL 的 enum 排序是声明顺序，读侧 `ORDER BY "category"` 的结果依赖它。
    expect(enumValues('AuditCategory')).toEqual([...auditCategories])
  })

  it('AuditOutcome 四值与契约包的 auditOutcomes 逐值同序', () => {
    expect(enumValues('AuditOutcome')).toEqual([...auditOutcomes])
  })

  it('迁移里的 reasonCode 格式 CHECK 与 REASON_CODE_PATTERN 是同一个正则', () => {
    // 故意留两处：库层那条兜住绕过 TS 的写入路径（裸 SQL、psql），TS 那条兜住往注册表里
    // 新增码时手滑写成 camelCase。同一个正则的两份副本必须逐字符相同，否则「两层都合法」
    // 这个前提就没了——某个码能过编译却被库拒，而那时已经在生产路径上。
    const check =
      /ADD CONSTRAINT "domain_audit_event_reason_code_namespaced"\s*\n\s*CHECK \("reasonCode" ~ '([^']+)'\)/.exec(
        migrations,
      )
    expect(check?.[1]).toBe(REASON_CODE_PATTERN.source)
  })

  it('审计行不可变：迁移里既没有 UPDATE 也没有 DELETE 的授权口子', () => {
    // ADR-0040 决策 5：审计行不可变、且不随业务数据删除而删除。schema 层的落点是
    // domain_audit_event 上没有 onDelete: Cascade 的外键——一条审计不能因为业务行被删就消失。
    const model = schema.slice(schema.indexOf('model DomainAuditEvent {'))
    const body = model.slice(0, model.indexOf('\n}'))
    expect(body).not.toContain('onDelete')
    expect(body).not.toContain('Cascade')
  })

  it('审计表按 (tenantId, category, occurredAt) 建索引：读侧要能按域翻页', () => {
    const model = schema.slice(schema.indexOf('model DomainAuditEvent {'))
    const body = model.slice(0, model.indexOf('\n}'))
    expect(body).toMatch(/@@index\(\[tenantId,\s*category,\s*occurredAt/)
  })

  it('账本状态与池的枚举值与 T12 事务入口契约一致', () => {
    // 四条终态路径的名字写死在这里：改名会让 committedAmounts 的 'RESERVED','SETTLED'
    // 字面量与库对不上，而那是一段裸 SQL，TS 不会报错。
    expect(enumValues('BudgetLedgerStatus')).toEqual(['RESERVED', 'SETTLED', 'RELEASED', 'EXPIRED'])
    expect(enumValues('BudgetPool')).toEqual(['INTERACTIVE', 'EVALUATION', 'RESERVE'])
    expect(enumValues('BudgetCostSource')).toEqual(['PROVIDER', 'ESTIMATED'])
    expect(enumValues('BudgetReleaseReason')).toEqual(['GATED', 'CANCELLED_BEFORE_DISPATCH'])
  })

  it('回收任务要走的索引以 status 开头', () => {
    // expireBudgetLeases 不带 tenantId（回收是全局任务），所以索引第一列必须是 status，
    // 否则它退化成全表扫。
    const model = schema.slice(schema.indexOf('model ModelBudgetLedger {'))
    const body = model.slice(0, model.indexOf('\n}'))
    expect(body).toMatch(/@@index\(\[status,\s*leaseExpiresAt/)
  })
})

describe('审计与遥测的依赖方向（ADR-0040 决策 1）', () => {
  it('@rag/observability 不导出任何审计写入口', () => {
    // 断言的是**构建产物的实际导出面**而不是 index.ts 的文本：`export *` 会把新加的文件
    // 一并带出来，只读 index.ts 看不见。
    const auditish = Object.keys(observability).filter((name) => /audit/i.test(name))
    expect(auditish).toEqual([])
  })

  it('审计写入口只从 @rag/observability 取字段名清单与占位符，不 import 遥测', () => {
    const auditRoot = join(packageRoot, 'src', 'audit')
    const sources = readdirSync(auditRoot)
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => ({ entry, text: readFileSync(join(auditRoot, entry), 'utf8') }))
    expect(sources.length).toBeGreaterThan(0)

    for (const { entry, text } of sources) {
      const specifiers = [
        ...text.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gm),
      ]
      for (const [, names, from] of specifiers) {
        if (from !== '@rag/observability') {
          // 遥测导出器、trace 入口与指标注册都不得出现在审计路径上：审计失败必须炸，
          // 遥测失败必须被吞，两者一旦共用一条代码路径，其中一条的口径就会被另一条带偏。
          expect(from, `${entry} 从 ${from} 取了东西`).not.toMatch(
            /telemetry|otel|opentelemetry|exporter|metrics|tracing/i,
          )
          continue
        }
        const imported = (names ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
          .sort()
        expect(imported, `${entry} 从 @rag/observability 多取了东西`).toEqual([
          'REDACTED',
          'contentFieldNames',
          'secretFieldNames',
        ])
      }
    }
  })

  it('审计原因码的唯一来源是契约包，database 侧不另写一份码表', () => {
    const auditRoot = join(packageRoot, 'src', 'audit')
    const text = readdirSync(auditRoot)
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => readFileSync(join(auditRoot, entry), 'utf8'))
      .join('\n')
    // 出现具体的码字面量就说明码表被抄了一份过来（注释里的示例不算，故意只查代码里的赋值形状）。
    expect(text).not.toMatch(/^\s*'budget\.[a-z_]+':/m)
    expect(text).toContain("from '@rag/contracts'")
  })
})
