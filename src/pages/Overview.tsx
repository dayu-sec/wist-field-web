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

/**
 * 每条通道「多久没动静算滞后 / 算断供」。
 *
 * 三条通道的节奏本来就不同：指标是**心跳型**（30 秒一次，断了就是事故），
 * 证据与 Atlas 是**事件型**（没数据是常态）。用一套阈值会把「本来没事件」误报成断供。
 */
const INGEST_FRESHNESS: Record<IngestChannel['id'], { live: number; slow: number }> = {
  metrics: { live: 2 * 60_000, slow: 10 * 60_000 },
  evidence: { live: 10 * 60_000, slow: 60 * 60_000 },
  atlas: { live: 10 * 60_000, slow: 60 * 60_000 },
}

/** 通道 → 点开去哪一页（和上面四个域同一套导航）。 */
const INGEST_TAB: Record<IngestChannel['id'], Tab> = {
  evidence: 'evidence',
  atlas: 'topology',
  metrics: 'metrics',
}

/** 首次拉取前的占位：先把三条通道摆出来，避免整块先消失再出现。 */
const INGEST_PLACEHOLDER: IngestChannel[] = [
  { id: 'evidence', label: '证据', unit: '条', total: null, received: null, last_at_ms: null, note: null },
  { id: 'atlas', label: 'Atlas', unit: '条', total: null, received: null, last_at_ms: null, note: null },
  {
    id: 'metrics',
    label: '运行指标',
    unit: '样本',
    total: null,
    received: null,
    last_at_ms: null,
    note: null,
  },
]

/** 看板实时轮询间隔：计数器是 O(1) 的，3 秒只看两个原子量，不碰数据库。 */
const INGEST_REFRESH_MS = 3_000

type IngestTone = { badge: BadgeTone; bar: 'ok' | 'warn' | 'none'; label: string; width: number }

/**
 * 一条通道的新鲜度：标签说「算不算断供」，条的长度说「距离阈值还剩多少」。
 *
 * 两者同源（都从 `age` 算），所以不会出现「绿标签配一根空条」这种自相矛盾的画面。
 * 条到 `slow` 阈值时归零：它不是「多满」，而是「还剩多少新鲜」。
 * 绿只给「刚刚真的收到过」：事件型通道 0 条是常态，不该染成告警色。
 */
function ingestTone(channel: IngestChannel, now: number): IngestTone {
  const rule = INGEST_FRESHNESS[channel.id]
  const age = channel.last_at_ms === null ? Number.POSITIVE_INFINITY : now - channel.last_at_ms
  const width = Number.isFinite(age) ? Math.max(0, Math.min(100, (1 - age / rule.slow) * 100)) : 0
  if (age <= rule.live) return { badge: 'green', bar: 'ok', label: '稳定', width }
  if (age <= rule.slow) return { badge: 'amber', bar: 'warn', label: '滞后', width }
  return { badge: 'gray', bar: 'none', label: '无数据', width: 0 }
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
  // 秒级轮询走 `window_seconds=0`：服务端只回两个原子量（累计 / 最后一次），不做任何 count。
  const [ingest, setIngest] = useState<IngestChannel[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      getIngestStats(0)
        .then((value) => {
          if (!cancelled) setIngest(value.channels)
        })
        .catch(() => {
          if (!cancelled) setIngest(null)
        })
    }
    load()
    const timer = window.setInterval(load, INGEST_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])
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
                上面四个域说的只是「端点通」；这里看真写进来多少。条的长度是新鲜度：满格 = 刚刚写入。
              </span>
              <span className="ingest__pulse">每 3 秒刷新</span>
            </div>

            <div className="ingest__cards">
              {(ingest ?? INGEST_PLACEHOLDER).map((channel) => {
                const tone = ingestTone(channel, now)
                const last = channel.last_at_ms === null ? null : channel.last_at_ms
                // 还没拿到第一份数据时不要说「没有口径」：那时什么都不知道。
                const note =
                  ingest === null
                    ? null
                    : (channel.note ??
                      (channel.total === null ? '这一路没有累计口径，只看最后一次写入' : null))
                return (
                  <button
                    key={channel.id}
                    type="button"
                    className="ingest-card"
                    onClick={() => onNavigate(INGEST_TAB[channel.id])}
                    title={
                      note ??
                      (last === null
                        ? '还没有收到过数据'
                        : `最后一次 ${formatDateTime(new Date(last).toISOString())}`)
                    }
                  >
                    <span className="ingest-card__head">
                      <span className="ingest-card__name">{channel.label}</span>
                      <span className="ingest-card__count">
                        {channel.total === null ? (
                          '—'
                        ) : (
                          <>
                            <em className="ingest-card__caption">累计</em>
                            {formatCount(channel.total)}
                            <em className="ingest-card__unit">{channel.unit}</em>
                          </>
                        )}
                      </span>
                    </span>
                    <span className="gauge gauge--thick" aria-hidden="true">
                      <span
                        className={
                          tone.bar === 'ok' ? 'gauge__fill' : `gauge__fill gauge__fill--${tone.bar}`
                        }
                        style={{ width: `${tone.width}%` }}
                      />
                    </span>
                    <span className="ingest-card__foot">
                      <Badge tone={tone.badge}>{tone.label}</Badge>
                      <span className="ingest-card__last">
                        {ingest === null
                          ? '—'
                          : last === null
                            ? '未收到过'
                            : now - last < 10_000
                              ? '刚刚写入'
                              : `最后一次 ${formatRelativeTime(last, now)}`}
                      </span>
                    </span>
                    {note ? <span className="ingest-card__note">{note}</span> : null}
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
