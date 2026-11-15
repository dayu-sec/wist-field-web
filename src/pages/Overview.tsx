import { useEffect, useState } from 'react'
import { getIngestStats, type ConsoleHealth, type IngestChannel } from '../api'
import type { Tab } from '../components/Shell'
import { Badge, Block, ErrorBanner, PageShell, type BadgeTone } from '../components/ui'
import { formatCount, formatDateTime, formatRelativeTime } from '../format'

/**
 * 概览只放两件事：四个域**接没接上**，以及一条接口可用性汇总。
 * 逐条探活（延迟 / 会话可用率 / 验到哪一层）在「接口可用性」页，
 * 这里不再复制一份表格 —— 同一份信息出现两次，只会让两边都看不过来。
 */
const SOURCES: { key: string; tab: Tab; label: string; hint: string }[] = [
  { key: 'evidence', tab: 'evidence', label: '证据', hint: 'wist-evidence · 索引与正文' },
  { key: 'atlas', tab: 'topology', label: '资产拓扑', hint: 'wist-atlas · 主机 / 服务 / 进程' },
  { key: 'metrics', tab: 'metrics', label: '运行指标', hint: 'VictoriaMetrics · 计数与采集健康' },
  { key: 'devices', tab: 'devices', label: '安全设备', hint: '封堵能力与生效验证' },
]

function toneFor(status: string): BadgeTone {
  switch (status) {
    case 'ok':
      return 'green'
    case 'unavailable':
      return 'red'
    case 'not_configured':
      return 'gray'
    default:
      return 'amber'
  }
}

function labelFor(status: string): string {
  switch (status) {
    case 'ok':
      return '可用'
    case 'unavailable':
      return '不可用'
    case 'not_configured':
      return '未接入'
    default:
      return status
  }
}

/** 接收量的统计窗口：与指标页的走势窗口同一套档位。 */
const INGEST_WINDOWS = [
  { seconds: 900, label: '近 15 分钟' },
  { seconds: 3_600, label: '近 1 小时' },
  { seconds: 21_600, label: '近 6 小时' },
]

/** 通道 → 点开去哪一页（和上面四个域同一套导航）。 */
const INGEST_TAB: Record<IngestChannel['id'], Tab> = {
  evidence: 'evidence',
  atlas: 'topology',
  metrics: 'metrics',
}

/** 首次拉取前的占位：先把三条通道摆出来，避免整块先消失再出现。 */
const INGEST_PLACEHOLDER: IngestChannel[] = [
  { id: 'evidence', label: '证据', unit: '条', received: null, last_at_ms: null, note: null },
  { id: 'atlas', label: 'Atlas', unit: '批', received: null, last_at_ms: null, note: null },
  { id: 'metrics', label: '运行指标', unit: '样本', received: null, last_at_ms: null, note: null },
]

/**
 * 新鲜度只看「最后一条有多久」，不只看条数。
 *
 * 三条通道的节奏本来就不同：证据 / Atlas 是**事件型**（没数据是常态），
 * 指标是**心跳型**（断供应就是事故）。所以级色只给「刚刚真的收到过」，
 * 不把「0 条」染成绿色。
 */
function ingestTone(channel: IngestChannel, windowSeconds: number, now: number) {
  if (channel.last_at_ms === null) return 'idle' as const
  const age = now - channel.last_at_ms
  if (age <= 10 * 60_000) return 'live' as const
  if (age <= windowSeconds * 1000) return 'slow' as const
  return 'idle' as const
}

export function OverviewPage({
  health,
  error,
  onNavigate,
}: {
  health: ConsoleHealth | null
  error: string | null
  onNavigate: (tab: Tab) => void
}) {
  const interfaces = health?.interfaces ?? []
  const checked = interfaces.filter((entry) => entry.status !== 'not_configured')
  const available = checked.filter((entry) => entry.status === 'ok').length
  const latestCheck = interfaces.reduce<number | null>((latest, entry) => {
    if (entry.checked_at_ms === undefined) return latest
    return latest === null || entry.checked_at_ms > latest ? entry.checked_at_ms : latest
  }, null)

  // 接收情况：只在这个页面上拉，失败不影响上面的探活视图。
  const [windowSeconds, setWindowSeconds] = useState(INGEST_WINDOWS[1].seconds)
  const [ingest, setIngest] = useState<IngestChannel[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      getIngestStats(windowSeconds)
        .then((value) => {
          if (!cancelled) setIngest(value.channels)
        })
        .catch(() => {
          if (!cancelled) setIngest(null)
        })
    }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [windowSeconds])
  const now = Date.now()

  return (
    <PageShell title="概览" summary="计算区只读视图：四个域各自接没接上；逐条探活看「接口可用性」。">
      <Block wide>
        <div className="stack">
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}

          <div className="tiles">
            {SOURCES.map((source) => {
              const state = health?.sources?.[source.key]
              const status = state?.status ?? (health ? 'unavailable' : 'unknown')
              return (
                <button
                  key={source.key}
                  type="button"
                  className="tile"
                  onClick={() => onNavigate(source.tab)}
                  title={`打开${source.label}`}
                >
                  <span className="tile__head">
                    <span className="tile__label">{source.label}</span>
                    <Badge tone={toneFor(status)}>{labelFor(status)}</Badge>
                  </span>
                  <span className="tile__detail">{state?.detail ?? source.hint}</span>
                </button>
              )
            })}
          </div>

          <div className="ingest">
            <div className="ingest__head">
              <span className="ingest__title">数据进来没有</span>
              <span className="ingest__hint">
                上面四个域说的只是「端点通」；这里看真收到了多少。三条通道的单元本来就不同（条 / 批 / 样本），
                按各自口径看，「最后一次」比条数更早暴露断供。
              </span>
              <select
                aria-label="接收量统计窗口"
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(Number(event.target.value))}
              >
                {INGEST_WINDOWS.map((option) => (
                  <option key={option.seconds} value={option.seconds}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="ingest__rows">
              {(ingest ?? INGEST_PLACEHOLDER).map((channel) => {
                const tone = ingestTone(channel, windowSeconds, now)
                return (
                  <button
                    key={channel.id}
                    type="button"
                    className="ingest-row"
                    onClick={() => onNavigate(INGEST_TAB[channel.id])}
                    title={
                      channel.note ??
                      (channel.last_at_ms === null
                        ? '窗口内没有收到数据'
                        : `最后一次 ${formatDateTime(new Date(channel.last_at_ms).toISOString())}`)
                    }
                  >
                    <span className="ingest-row__name">{channel.label}</span>
                    <span className="ingest-row__count">
                      {channel.received === null ? '—' : formatCount(channel.received)}
                      <span className="ingest-row__unit">
                        {channel.received === null ? '' : ` ${channel.unit}`}
                      </span>
                    </span>
                    <span className="ingest-row__last">
                      {channel.last_at_ms === null
                        ? ingest === null
                          ? '—'
                          : channel.note
                            ? '未提供'
                            : '窗口内无'
                        : formatRelativeTime(channel.last_at_ms, now)}
                    </span>
                    <span className={`ingest-row__dot ingest-row__dot--${tone}`} aria-hidden="true" />
                    {channel.note ? <span className="ingest-row__note">{channel.note}</span> : null}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="statusline">
            <span className="statusline__label">接口可用性</span>
            <Badge tone={health ? (available === checked.length ? 'green' : 'red') : 'gray'}>
              {health ? `${available}/${checked.length} 可用` : '未连上 BFF'}
            </Badge>
            {latestCheck !== null ? (
              <span className="statusline__note">最近检查 {formatRelativeTime(latestCheck)}</span>
            ) : null}
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => onNavigate('health')}
            >
              查看逐条探活
            </button>
          </div>
        </div>
      </Block>
    </PageShell>
  )
}
