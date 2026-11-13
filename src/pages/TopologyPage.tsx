import { useEffect, useMemo, useRef } from 'react'
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
export function TopologyPage({
  networkId,
  hostId,
}: {
  /** 从「网络资产」页跳过来时带的定位目标：网段（看这个子网里有哪些机器）。 */
  networkId?: string
  /** 或者直接定位一台主机。 */
  hostId?: string
} = {}) {
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

  const view = useTopologyView({
    client,
    // 这个页面首屏就是「资产总览」（主机卡 + 共享网段）：不要自动选中第一台主机。
    // 自动选中会让同一张大图被拉两次（先总览、再焦点），而画布本来就是总览。
    autoSelectFirstHost: false,
  })

  // 下钻到网段 / 服务视图时，这台选择器无处可去（它只能选主机）：置灰并说明怎么退。
  const lastLevel = view.path[view.path.length - 1]
  const hostPickerLocked = Boolean(lastLevel && lastLevel.kind !== 'host')

  // 带参进来就定位一次：之后用户自己在画布里点来点去，不该被 query 拽回去。
  const applied = useRef(false)
  useEffect(() => {
    if (applied.current) return
    if (networkId) {
      applied.current = true
      view.openNetwork(networkId)
    } else if (hostId) {
      applied.current = true
      view.setHostId(hostId)
    }
  }, [networkId, hostId, view])

  return (
    // 不再用 PageShell：顶栏面包屑已经写着「计算区 / 资产拓扑」，标题再来一遍是重复，
    // 而且那两行要吃掉一百 px 高度 —— 画布页面把这块全让给图。
    <div className="topology-page">
      <div className="topology-actions">
        <select
          value={view.hostId}
          onChange={(event) => view.setHostId(event.target.value)}
          disabled={view.hosts.length === 0 || hostPickerLocked}
          aria-label="切换主机"
          title={
            hostPickerLocked
              ? '当前在网段 / 服务视图里：点画布左上角的面包屑返回后再切主机'
              : '只看一台主机，或回到全部主机总览'
          }
        >
          <option value="">全部主机（总览）</option>
          {view.hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.hostName}
              {host.stale ? '（已退役）' : ''}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="button button--ghost button--sm"
          onClick={view.refresh}
          disabled={view.loading}
        >
          {view.loading ? '同步中…' : '刷新'}
        </button>
      </div>

      {/* 画布要铺满剩下的高度，所以由 `.topology-page` 把 header 之外的空间全给它。 */}
      <div className="topology-stage">
        <TopologyCanvasView view={view} theme={theme} />
      </div>
    </div>
  )
}
