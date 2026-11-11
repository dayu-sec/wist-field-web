import { useEffect, useState, type ReactNode } from 'react'
import { formatRelativeTime } from '../format'
import { toggleAppTheme, useAppTheme } from '../theme'

export type Tab = 'overview' | 'evidence' | 'topology' | 'metrics' | 'health' | 'devices' | 'ingest'

/**
 * 左下角的版本号。CI 传的是 git tag（`v0.2.6-alpha`），本地构建传 `dev` 或 `0.2.6-local`
 * —— 统一去掉前缀 `v` 后只拼一次，否则会渲染成 `vv0.2.6-alpha`。
 */
function versionLabel(): string {
  const version = __APP_VERSION__.replace(/^v/, '')
  return version === '' || version === 'dev' ? 'dev' : `v${version}`
}

const TAB_LABELS: Record<Tab, string> = {
  overview: '概览',
  evidence: '证据',
  topology: '资产拓扑',
  metrics: '运行指标',
  health: '接口可用性',
  devices: '安全设备',
  ingest: '数据面接入',
}

/**
 * 导航是**一条平铺的列表**，只用一条分隔线分成两段：
 *   1. 数据域（概览 + 这个台子读的四类数据）—— 与概览页的四张卡一一对应；
 *   2. 平台自身（接口自检 + 数据面怎么接进来）。
 * 不再分「取证 / 资产 / 运行 / 接入」四组：层名和条名重复，而且会把
 * 概览、安全设备这类不属于该层的东西塞进错的组里。
 */
const NAV_MAIN: { tab: Tab; icon: ReactNode }[] = [
  { tab: 'overview', icon: <IconOverview /> },
  { tab: 'evidence', icon: <IconEvidence /> },
  { tab: 'topology', icon: <IconTopology /> },
  { tab: 'metrics', icon: <IconMetrics /> },
  { tab: 'devices', icon: <IconDevice /> },
]

const NAV_PLATFORM: { tab: Tab; icon: ReactNode }[] = [
  { tab: 'health', icon: <IconHealth /> },
  { tab: 'ingest', icon: <IconIngest /> },
]

function IconOverview() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <rect x="1.6" y="1.6" width="5.2" height="5.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9.2" y="1.6" width="5.2" height="5.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="1.6" y="9.2" width="5.2" height="5.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9.2" y="9.2" width="5.2" height="5.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function NavLink({
  tab,
  icon,
  active,
  onTab,
}: {
  tab: Tab
  icon: ReactNode
  active: boolean
  onTab: (tab: Tab) => void
}) {
  return (
    <button
      type="button"
      className={`nav-link${active ? ' nav-link--active' : ''}`}
      onClick={() => onTab(tab)}
      aria-current={active ? 'page' : undefined}
    >
      <span className="nav-icon">{icon}</span>
      {TAB_LABELS[tab]}
    </button>
  )
}

function IconEvidence() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M4.2 1.8h5.1l2.5 2.5v9.9H4.2Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9.2 1.9v2.5h2.5M6.2 8h3.6M6.2 10.4h3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function IconTopology() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <circle cx="8" cy="2.6" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="3" cy="12.4" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="13" cy="12.4" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7.2 4.2 3.6 10.9M8.8 4.2l3.6 6.7M4.8 12.4h6.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function IconMetrics() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M2.2 13.4h11.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="3.2" y="8.4" width="2.6" height="5" rx="0.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6.9" y="5.4" width="2.6" height="8" rx="0.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10.6" y="2.6" width="2.6" height="10.8" rx="0.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function IconIngest() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M8 1.8v6.4M5.2 5.4 8 8.2l2.8-2.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.6 9.6v2.4a2 2 0 0 0 2 2h6.8a2 2 0 0 0 2-2V9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function IconHealth() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M1.8 8.6h2.6l1.5-3.9 2.2 7 1.6-3.1h4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconDevice() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M8 1.8 13.2 3.8v4.1c0 3.2-2.2 5.5-5.2 6.3-3-.8-5.2-3.1-5.2-6.3V3.8Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="m5.8 8 1.6 1.6 3-3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      {/* 与 favicon 同一套几何：一张证据落进索引（只读、可追溯）。 */}
      <svg viewBox="0 0 20 20" width="17" height="17">
        <g fill="none" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
          <path d="M5.2 2.8h6.6l3.4 3.4v11H5.2Z" />
          <path d="M11.6 2.9v3.5h3.4M7.6 9.4h5M7.6 12.1h5" />
        </g>
      </svg>
    </span>
  )
}

interface ShellProps {
  tab: Tab
  onTab: (tab: Tab) => void
  connected: boolean
  syncing: boolean
  lastSyncedAt: number | null
  onRefresh: () => void
  /** 退出：清掉本标签页的访问令牌，回到令牌入口。 */
  onSignOut: () => void
  /** 多客户站点：当前客户（单客户站点为 `null`，不显示任何客户 UI）。 */
  tenant?: string | null
  /** 切换客户：清掉选择，回到选客户页。 */
  onSwitchTenant?: () => void
  children: ReactNode
}

/** 应用外壳：左侧导航 + 顶部常驻状态条 + 内容区（与 ingest-web / gateway-web 同一套结构）。 */
export function Shell({
  tab,
  onTab,
  connected,
  syncing,
  lastSyncedAt,
  onRefresh,
  onSignOut,
  tenant,
  onSwitchTenant,
  children,
}: ShellProps) {
  const theme = useAppTheme()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const statusText = syncing ? '同步中' : connected ? '自动刷新 30s' : 'BFF 不可用'

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <span className="brand-copy">
            <span className="brand-text">数据场</span>
            <span className="brand-sub">现场视图</span>
          </span>
        </div>

        <nav className="nav" aria-label="主导航">
          {NAV_MAIN.map((item) => (
            <NavLink
              key={item.tab}
              tab={item.tab}
              icon={item.icon}
              active={tab === item.tab}
              onTab={onTab}
            />
          ))}
          <div className="nav-divider" role="separator" />
          {NAV_PLATFORM.map((item) => (
            <NavLink
              key={item.tab}
              tab={item.tab}
              icon={item.icon}
              active={tab === item.tab}
              onTab={onTab}
            />
          ))}
        </nav>

        <footer className="sidebar-footer">
          <span className="sidebar-version">{versionLabel()}</span>
          <span className="sidebar-note">wist-field-web · 计算区</span>
        </footer>
      </aside>

      <div className="body">
        <div className="statusbar">
          <nav className="crumbs" aria-label="面包屑">
            <span className="crumb-root">计算区</span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="crumb-current">{TAB_LABELS[tab]}</span>
          </nav>

          <div className="statusbar-right">
            <span
              className={`pill ${connected ? 'pill--live' : 'pill--idle'}`}
              title={
                connected
                  ? `数据来自计算区 BFF：每 30 秒自动拉取；最近同步 ${
                      lastSyncedAt
                        ? new Date(lastSyncedAt).toLocaleTimeString('zh-CN', { hour12: false })
                        : '—'
                    }`
                  : '计算区 BFF 不可达：页面上的数据可能为空或过期'
              }
            >
              <span className={syncing ? 'dot dot--syncing' : 'dot'} aria-hidden="true" />
              {statusText}
              {connected && lastSyncedAt ? (
                <>
                  <span className="pill-divider" aria-hidden="true" />
                  <span className="pill-fresh">{formatRelativeTime(lastSyncedAt, now)}</span>
                </>
              ) : null}
            </span>

            <button
              type="button"
              className="icon-button"
              onClick={() => toggleAppTheme()}
              title={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
              aria-label={theme === 'light' ? '当前浅色主题，点击切换到深色' : '当前深色主题，点击切换到浅色'}
            >
              {theme === 'light' ? (
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                    <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6" />
                    <path d="M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
                  </g>
                </svg>
              )}
            </button>

            <button
              type="button"
              className="icon-button"
              onClick={onRefresh}
              title="刷新"
              aria-label="刷新"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5V5H10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <button
              type="button"
              className="icon-button"
              onClick={onSignOut}
              title="退出（清除本标签页的访问令牌）"
              aria-label="退出登录"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M8 2.2v5.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M4.6 4.4a5 5 0 1 0 6.8 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {/* 多客户站点：当前客户必须一直可见 —— 否则两个客户的界面长得一模一样。 */}
          {tenant ? (
            <button
              type="button"
              className="tenant-chip"
              onClick={onSwitchTenant}
              title="切换客户（数据按客户隔离）"
            >
              <span className="tenant-chip__label">客户</span>
              <span className="tenant-chip__id">{tenant}</span>
            </button>
          ) : null}
        </div>

        <main className="main">{children}</main>
      </div>
    </div>
  )
}
