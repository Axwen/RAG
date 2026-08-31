export const CONTRACTS_PACKAGE = '@rag/contracts' as const

/** 契约包 schema 版本。任何破坏性契约变更必须同时递增此值并记录 ADR。 */
export const CONTRACTS_SCHEMA_VERSION = 1 as const

export * from './errors'
export * from './manifests'
