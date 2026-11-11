// 访问凭据（wist-cred 签发的 `wcr_…` token）。
//
// 浏览器不持有任何服务端会话：token 只放 `sessionStorage`（关标签页就没），
// 每个请求以 `Authorization: Bearer` 发给 BFF，由 BFF 用摘要表验。
//
// 为什么不是 localStorage：关掉页面后不该还在，token 的生命周期由 cred 侧的
// `ttl_seconds` 决定，浏览器不该再延长它。

const STORAGE_KEY = 'wist.field.token'

/** 任何请求返回 401 时广播一次：App 据此弹出令牌输入框。 */
export const UNAUTHORIZED_EVENT = 'wist:unauthorized'

export function getToken(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) {
      window.sessionStorage.setItem(STORAGE_KEY, token)
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // 隐私模式下 sessionStorage 可能不可写：退化成「本次页面有效」也做不到，
    // 那就让请求直接 401，而不是假装已经登录。
  }
}

export function clearToken(): void {
  setToken('')
}

export function notifyUnauthorized(): void {
  clearToken()
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

/**
 * 租户被拒时广播一次：App 据此回到「选客户」页。
 *
 * 两种来源都是“当前选择不可用”，处理一致：
 * - 403 `tenant_not_allowed`（不在可选集合里，例如令牌换了或客户被撤）；
 * - 400 `tenant_required`（多客户站点没带 `?tenant=`）。
 * 清掉本地选择，让用户重新选 —— 不静默改用一个“默认客户”。
 */
export const TENANT_REJECTED_EVENT = 'wist:tenant-rejected'

export function notifyTenantRejected(): void {
  window.dispatchEvent(new Event(TENANT_REJECTED_EVENT))
}
