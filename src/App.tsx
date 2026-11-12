import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ApiError, getHealth, getSession, type ConsoleHealth } from './api'
import {
  TENANT_REJECTED_EVENT,
  UNAUTHORIZED_EVENT,
  clearToken,
  getToken,
} from './auth'
import { Shell, type Tab } from './components/Shell'
import { InitGate } from './components/InitGate'
import { TenantGate } from './components/TenantGate'
import { TokenGate } from './components/TokenGate'
import { clearTenant, getTenant } from './tenant'
import { EvidenceDetailPage } from './pages/EvidenceDetailPage'
import { EvidencePage } from './pages/EvidencePage'
import { HealthPage } from './pages/HealthPage'
import { OverviewPage } from './pages/Overview'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { IngestPage } from './pages/IngestPage'
import { MetricsPage } from './pages/MetricsPage'
import { NetworkPage } from './pages/NetworkPage'

// 拓扑画布带 cytoscape（~200KB gzip）：只有进这一页才加载，别拖慢首屏。
const TopologyPage = lazy(() =>
  import('./pages/TopologyPage').then((module) => ({ default: module.TopologyPage })),
)

const TABS: Tab[] = [
  'overview',
  'evidence',
  'topology',
  'network',
  'metrics',
  'health',
  'devices',
  'ingest',
]

interface Route {
  tab: Tab
  segments: string[]
  query: URLSearchParams
}

/** hash 路由：`#/evidence?subject_id=agent-1`、`#/evidence/<cmd_id>`（也接受 `art_…`）。刷新 / 分享都能回到同一页。 */
function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [pathPart, queryPart = ''] = raw.split('?')
  const segments = pathPart.split('/').filter(Boolean)
  const head = segments[0] as Tab | undefined
  const tab = head && TABS.includes(head) ? head : 'overview'
  return {
    tab,
    segments: segments.slice(1),
    query: new URLSearchParams(queryPart),
  }
}

function navigate(path: string): void {
  const normalized = path.replace(/^#?\/?/, '')
  window.location.hash = `#/${normalized}`
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  const [health, setHealth] = useState<ConsoleHealth | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  // 没有令牌就不进界面：任何 401 都会把这里重置成 true（见 `auth.ts` 的广播）。
  const [needToken, setNeedToken] = useState(() => !getToken())
  // 还没接入凭据中心：BFF 对 `/api/*` 回 503 `peer_not_initialized`。
  // 这一档要排在令牌之前 —— 没材料时拿着令牌也什么都进不去。
  const [initRequired, setInitRequired] = useState(false)
  const [initDetail, setInitDetail] = useState<string | null>(null)
  // 多客户：本令牌能看的客户集合（BFF 只给集合，**不给默认客户**）。
  const [tenants, setTenants] = useState<string[]>([])
  const [tenantRejected, setTenantRejected] = useState<string | null>(null)
  // 当前客户；没选时为 null。`sessionStorage` 是唯一来源（不在这里另存一份 state）。
  const [tenant, setTenantState] = useState<string | null>(() => getTenant())

  useEffect(() => {
    const onUnauthorized = () => setNeedToken(true)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    // 客户被拒（403 越界 / 400 未指定）：清掉选择，回到选客户页。
    const onTenantRejected = () => {
      const previous = getTenant()
      clearTenant()
      setTenantState(null)
      setTenantRejected(previous)
    }
    window.addEventListener(TENANT_REJECTED_EVENT, onTenantRejected)
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
      window.removeEventListener(TENANT_REJECTED_EVENT, onTenantRejected)
    }
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const refresh = useCallback(async () => {
    setSyncing(true)
    try {
      const value = await getHealth()
      setHealth(value)
      setHealthError(null)
      setInitRequired(false)
      setInitDetail(null)
      setLastSyncedAt(Date.now())
    } catch (err) {
      setHealth(null)
      const notInitialized = err instanceof ApiError && err.code === 'peer_not_initialized'
      setInitRequired(notInitialized)
      setInitDetail(notInitialized && err instanceof ApiError ? err.message : null)
      setHealthError(err instanceof ApiError ? `${err.message}（${err.code}）` : String(err))
    } finally {
      setSyncing(false)
    }
  }, [])

  // 登录后拉一次“能看哪些客户”：单客户站点永远只有 0/1 项，不会弹选择页。
  // 拉失败不阻断（例如老版本 BFF 没有 `/api/session`）—— 按单客户站点跑。
  useEffect(() => {
    if (needToken) return
    let alive = true
    void getSession()
      .then((value) => {
        if (!alive) return
        setTenants(value.tenants)
        // 已选的客户不在集合里（令牌换了 / 客户被撤）→ 旧选择作废。
        const current = getTenant()
        if (current && !value.tenants.includes(current)) {
          clearTenant()
          setTenantState(null)
          setTenantRejected(current)
        }
      })
      .catch(() => {
        if (alive) setTenants([])
      })
    return () => {
      alive = false
    }
  }, [needToken])

  // 健康状态 30 秒拉一次：页面数据本身由各页自己按需拉，不在这里做全量轮询。
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const connected = health !== null

  // 退出：令牌只在本标签页的 sessionStorage 里，清掉就回到入口。
  // 先确认一手 —— 重新进入要再粘一次 `wcr_…`。
  const signOut = useCallback(() => {
    if (!window.confirm('退出并清除本标签页的访问令牌？\n重新进入需要再粘贴一次。')) return
    clearToken()
    setNeedToken(true)
    setHealth(null)
    setHealthError(null)
    setLastSyncedAt(null)
  }, [])

  if (initRequired) {
    return (
      <InitGate
        onRetry={() => void refresh()}
        retrying={syncing}
        detail={initDetail}
      />
    )
  }

  if (needToken) {
    return (
      <TokenGate
        onAuthenticated={() => {
          setNeedToken(false)
          void refresh()
        }}
      />
    )
  }

  // 多客户站点：没选客户（或刚被拒）之前不进主界面 —— 所有页面都按客户取数，
  // 用错客户看到的是一整套错数据，比“多一步”贵得多。
  const mustPickTenant = tenants.length > 1 && (tenant === null || !tenants.includes(tenant))
  if (mustPickTenant) {
    return (
      <TenantGate
        tenants={tenants}
        rejected={tenantRejected}
        onPick={(picked) => {
          setTenantState(picked)
          setTenantRejected(null)
          void refresh()
        }}
        onSignOut={signOut}
      />
    )
  }

  return (
    <Shell
      tab={route.tab}
      // 顶部/侧栏只在多客户时显示当前客户与切换入口。
      tenant={tenants.length > 1 ? tenant : null}
      onSwitchTenant={() => {
        clearTenant()
        setTenantState(null)
        setTenantRejected(null)
      }}
      onTab={(tab) => navigate(tab === 'overview' ? '/overview' : `/${tab}`)}
      connected={connected}
      syncing={syncing}
      lastSyncedAt={lastSyncedAt}
      onRefresh={() => void refresh()}
      onSignOut={signOut}
    >
      {route.tab === 'overview' ? (
        <OverviewPage health={health} error={healthError} onNavigate={(tab) => navigate(`/${tab}`)} />
      ) : null}

      {route.tab === 'evidence' && route.segments[0] ? (
        <EvidenceDetailPage
          evidenceId={route.segments[0]}
          onBack={() => navigate('/evidence')}
        />
      ) : null}

      {route.tab === 'evidence' && !route.segments[0] ? (
        <EvidencePage
          commandId={route.query.get('cmd_id') ?? ''}
          subjectId={route.query.get('subject_id') ?? ''}
          kind={route.query.get('kind') ?? ''}
          onOpen={(evidenceId) => navigate(`/evidence/${evidenceId}`)}
          onQuery={({ cmdId, subjectId, kind }) => {
            const params = new URLSearchParams()
            if (cmdId) params.set('cmd_id', cmdId)
            if (subjectId) params.set('subject_id', subjectId)
            if (kind) params.set('kind', kind)
            const suffix = params.size > 0 ? `?${params.toString()}` : ''
            navigate(`/evidence${suffix}`)
          }}
        />
      ) : null}

      {route.tab === 'topology' ? (
        <Suspense
          fallback={
            <div className="page-shell">
              <div className="page-header">
                <h1 className="page-title">资产拓扑</h1>
              </div>
              <main className="page-main">
                <section className="block">
                  <div className="empty">
                    <strong className="empty__title">正在装载画布…</strong>
                  </div>
                </section>
              </main>
            </div>
          }
        >
          <TopologyPage />
        </Suspense>
      ) : null}

      {route.tab === 'network' ? <NetworkPage /> : null}

      {route.tab === 'health' ? (
        <HealthPage
          health={health}
          error={healthError}
          syncing={syncing}
          lastSyncedAt={lastSyncedAt}
          onRefresh={() => void refresh()}
          section={route.segments[0]}
          onSection={(section) =>
            // 探活结果是默认视图，留在 `#/health` 上；两张接口清单各有独立地址，可分享。
            navigate(section === 'probes' ? '/health' : `/health/${section}`)
          }
        />
      ) : null}

      {route.tab === 'metrics' ? <MetricsPage /> : null}

      {route.tab === 'ingest' ? (
        <IngestPage
          section={route.segments[0]}
          onSection={(channel) =>
            // 证据是默认 tab，留在 `#/ingest` 上；其余两个各自有独立地址，可分享。
            navigate(channel === 'evidence' ? '/ingest' : `/ingest/${channel}`)
          }
        />
      ) : null}

      {route.tab === 'devices' ? (
        <PlaceholderPage
          title="安全设备"
          summary="网关暴露的安全能力、当前封堵项与生效验证（readback）结果。"
          missing={[
            'containment_capabilities 能力广告还只在设计稿里（gateway-capability-contract.md），网关不上报。',
            '「设备状态」的数据模型未定：是设备在线 + 能力清单，还是封堵规则的当前生效情况。',
            '中心侧没有设备/封堵状态表，也没有 readback 结果的落点。',
          ]}
          plan={[
            '先落网关能力广告（随 ReportGatewayStatus 加性字段，老网关不报 = 无能力）。',
            '再落 center 的设备状态查询（C2 读），只读，不做下发。',
            '最后接 /api/devices 与页面；写操作（封堵/解封）走 security-containment-actions.md 的六道闸，不在本台直接发。',
          ]}
        />
      ) : null}
    </Shell>
  )
}
