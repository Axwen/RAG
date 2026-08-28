import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DATABASE_PACKAGE,
  DATABASE_URL_ENV,
  PRISMA_MIGRATIONS_PATH,
  PRISMA_SCHEMA_PATH,
  requireDatabaseUrl,
} from '../src/index'

const packageRoot = join(__dirname, '..')
const schema = readFileSync(join(packageRoot, PRISMA_SCHEMA_PATH), 'utf8')

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

  it('T0 不引入领域模型', () => {
    expect(schema).not.toMatch(/^\s*model\s+\w+/m)
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
