/**
 * 预算窗口（T12 Ledger 最小数据模型）。
 *
 * 账本里没有 `period` 列，这是刻意的：一行预扣同时算进当日与当月两个窗口，单值填不了；
 * 一行一窗口又会让账本翻倍。所以窗口是**查询侧**的概念，由这里按 `createdAt` 范围算出来，
 * 走索引 `(tenantId, pool, status, createdAt)`。
 *
 * 现在按 UTC 切。预算日的时区归 T12b 运行配置，不进 schema，也不在这里读环境变量：
 * 边界计算是纯函数，T12b 只要换掉这两个函数的入参（加一个时区），CAS 那一层不用动。
 * 上界一律开区间（`start <= createdAt < end`），避免跨零点那一毫秒被两个窗口都算一次。
 */

export interface BudgetWindow {
  /** 闭下界。 */
  start: Date
  /** 开上界。 */
  end: Date
}

/** 含 `now` 的那一个 UTC 日。 */
export function dayWindow(now: Date): BudgetWindow {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  )
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  )
  return { start, end }
}

/** 含 `now` 的那一个 UTC 月。`Date.UTC` 的月份溢出自然进位，12 月不用特判。 */
export function monthWindow(now: Date): BudgetWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return { start, end }
}
