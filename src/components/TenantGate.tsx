// 选客户：多客户 data-field 的**必经一步**。
//
// 为什么不让前端自己挑一个默认值：那类“默认第一个”就是看错客户 / 越权的来源
// （BFF 也故意不返回 default_tenant）。所以：
//   令牌能看 0 或 1 个客户 → 页面不出现这里（单客户站点零打扰）；
//   能看多个 → 必须显式选，选完存 sessionStorage（与令牌同一档，关页即失）。

import { useState } from 'react'
import { setTenant } from '../tenant'

interface Props {
  tenants: string[]
  /** 已经选过但在集合外（例如令牌换了）时的提示。 */
  rejected?: string | null
  onPick: (tenant: string) => void
  /** 退出登录，回到令牌入口。 */
  onSignOut: () => void
}

export function TenantGate({ tenants, rejected, onPick, onSignOut }: Props) {
  const [picked, setPicked] = useState<string | null>(null)

  function choose(tenant: string) {
    setPicked(tenant)
    setTenant(tenant)
    onPick(tenant)
  }

  return (
    <div className="gate">
      <div className="gate__card card">
        <div>
          <h1 className="card__title">选择客户</h1>
          <p className="card__subtitle">
            这块数据场服务多个客户，数据按客户隔离 —— 先选一个，之后所有页面都只看它。
          </p>
        </div>
        {rejected ? (
          <p className="gate__error" role="alert">
            之前选的客户已不可用（{rejected}），请重新选择。
          </p>
        ) : null}
        <div className="tenant-options">
          {tenants.map((tenant) => (
            <button
              key={tenant}
              type="button"
              className="button"
              disabled={picked !== null}
              onClick={() => choose(tenant)}
            >
              {tenant}
              {picked === tenant ? '（进入中…）' : ''}
            </button>
          ))}
        </div>
        <button type="button" className="gate__link" onClick={onSignOut}>
          退出登录
        </button>
      </div>
    </div>
  )
}
