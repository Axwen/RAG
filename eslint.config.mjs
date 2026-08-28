import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      'scripts/probes/**',
      'services/parser/**',
      // 未跟踪的外部快照与素材目录（见 .gitignore）：不属于本仓库代码，不参与 lint。
      'references/**',
      'pdf/**',
      '.gstack/**',
      'diagrams/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.config.{ts,mts,mjs,js}', 'infra/**/*.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
  {
    // NestJS 依赖 emitDecoratorMetadata 在运行时读取构造函数参数类型，
    // 把注入类改成 `import type` 会让类型被擦除、DI 解析失败。
    // 该规则与 emitDecoratorMetadata 天然冲突，故在 API 源码内关闭。
    files: ['apps/api/src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  prettier,
)
