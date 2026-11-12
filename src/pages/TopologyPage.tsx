import { useMemo } from 'react'
import { createAtlasClient } from '@dayu-sec/wist-atlas-graph'
import { TopologyCanvasView, useTopologyView } from '@dayu-sec/wist-atlas-graph/ui'
import '@dayu-sec/wist-atlas-graph/styles.css'
import { getToken } from '../auth'
import { withTenant } from '../tenant'
import { useAppTheme } from '../theme'

/**
 * 资产拓扑：**组件化嵌画布**，不再 iframe 整个 atlas。
 *
 * 主机/服务/进程关系仍由 wist-atlas 的只读 API 提供，但数据走 BFF 的 `/api/atlas/*`
 * （令牌校验只有一道门），画布、工具条、详情抽屉来自 `@dayu-sec/wist-atlas-graph`。
 * 好处：没有第二套顶栏/路由/主题，深浅色与数据场一致，Esc/搜索/缩放都在同一棵 React 树里。
 */
export function TopologyPage() {
  const theme = useAppTheme()

  // 前缀与令牌由宿主注入：BFF 把 `/api/atlas/*` 转给 atlas，浏览器不直连 atlas。
  //
  // `fetchImpl` 是为了补客户：atlas 的画布组件走**自己的** fetch，不经过 `api.ts` 的
  // `request()`，所以 `withTenant` 在这里得再包一层 —— 否则多客户站点上 BFF 收到的是
  // “没选客户”，直接 400；单客户站点不影响。
  const client = useMemo(
    () =>
      createAtlasClient({
        baseUrl: '/api/atlas',
        headers: () => {
          const token = getToken()
          const headers: Record<string, string> = {}
          if (token) headers.Authorization = `Bearer ${token}`
          return headers
        },
        fetchImpl: (input, init) => fetch(withTenant(String(input)), init),
      }),
    [],
  )

  const view = useTopologyView({ client })

  return (
    <div className="topology-page">
      <header className="topology-bar">
        <div className="topology-bar__title">
          <h1 className="page-title">资产拓扑</h1>
          <p className="page-summary">
            主机 / 服务 / 进程关系由 wist-atlas 提供；这里是同一张画布的组件化接入，不是 iframe。
          </p>
        </div>

        <div className="topology-bar__actions">
          <label className="topology-field">
            <span className="field__label">主机</span>
            <select
              value={view.hostId}
              onChange={(event) => view.setHostId(event.target.value)}
              disabled={view.hosts.length === 0}
              aria-label="切换主机"
            >
              <option value="">全部主机（总览）</option>
              {view.hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.hostName}
                  {host.stale ? '（已退役）' : ''}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={view.refresh}
            disabled={view.loading}
          >
            {view.loading ? '同步中…' : '刷新'}
          </button>
        </div>
      </header>

      <TopologyCanvasView view={view} theme={theme} />
    </div>
  )
}
