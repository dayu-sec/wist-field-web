// 当前客户（tenant）。
//
// 为什么放 sessionStorage：与访问令牌同一档 —— 只在本标签页有效，退出即丢。
// **不落 localStorage**：同一台机器换个人、或换一个客户，不该继承上一次的选择。
//
// 语义：BFF 只把「有哪些客户可选」告诉前端（`GET /api/session`），**不给默认客户**。
// 所以这里只存“用户显式选过的那一个”；没选过就是 `null`，由页面强制用户先选。

const KEY = 'wist-field.tenant'

export function getTenant(): string | null {
  const value = sessionStorage.getItem(KEY)
  return value && value.trim() ? value : null
}

export function setTenant(tenant: string): void {
  sessionStorage.setItem(KEY, tenant)
}

export function clearTenant(): void {
  sessionStorage.removeItem(KEY)
}

/**
 * 给 BFF 的路径追加 `?tenant=`。
 *
 * 所有 `/api/*` 都走这一个出口（`api.ts` 的 `request`），所以“选客户”只需要在这里生效一次，
 * 不必让每个页面自己记得带参数（漏一个就是查错客户）。
 */
export function withTenant(path: string): string {
  const tenant = getTenant()
  if (!tenant) return path
  const [base, hash = ''] = path.split('#')
  const separator = base.includes('?') ? '&' : '?'
  const next = `${base}${separator}tenant=${encodeURIComponent(tenant)}`
  return hash ? `${next}#${hash}` : next
}
