import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getMetrics,
  getMetricsHostsHistory,
  getMetricsMiddleware,
  type MetricsAgent,
  type MetricsBusiness,
  type MetricsCatalogEntry,
  type MetricsHostsHistory,
  type MetricsHostTrend,
  type MetricsOverview,
  type MiddlewareFamily,
  type MiddlewareSample,
} from '../api'
import { formatBytes, formatRelativeTime } from '../format'
import {
  Badge,
  Block,
  Card,
  Empty,
  ErrorBanner,
  InfoBanner,
  PageShell,
  type BadgeTone,
} from '../components/ui'

/** 趋势窗口：只给三档 —— 页面是「现在有没有在跳」，不是长期容量分析。 */
const WINDOWS = [
  { seconds: 900, label: '15 分钟' },
  { seconds: 3_600, label: '1 小时' },
  { seconds: 21_600, label: '6 小时' },
]

const REFRESH_MS = 30_000

/** 中间件层的指标名前缀：有契约（见 `wist-metrics` 的 spec 表），等 agentd 开 provider。 */
const MIDDLEWARE_GROUPS = ['container', 'kafka']

function errorText(err: unknown): string {
  return err instanceof ApiError ? `${err.message}（${err.code}）` : String(err)
}

function formatValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—'
  switch (unit) {
    case 'percent':
      return `${value.toFixed(2)}%`
    case 'bytes':
      return formatBytes(value)
    case 'milliseconds':
      return `${value.toFixed(1)} ms`
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
}

/** 运行时长：`3 天 4 小时` / `4 小时 12 分` / `12 分`。 */
function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分`
}

/**
 * 把若干台的同一个字段加起来。
 *
 * `null` 与 `0` 是两回事：一台都没报这个维度时保持 `null`（页面显示「—」），
 * 而不是伪装成「合计为 0」。
 */
function sumDefined(
  agents: MetricsAgent[],
  pick: (agent: MetricsAgent) => number | null,
): number | null {
  let total: number | null = null
  for (const agent of agents) {
    const value = pick(agent)
    if (value === null || !Number.isFinite(value)) continue
    total = (total ?? 0) + value
  }
  return total
}

/** 采集是否在跳：窗口内一个样本都没有 = 静默（不是「值为 0」）。 */
function reportingState(agent: MetricsAgent): { tone: BadgeTone; label: string } {
  // 角标说的是 **agentd 的采集**，不是主机本身。名字里带「采集」就是为了不被误读成主机状态。
  if (agent.samples > 0) return { tone: 'green', label: '采集在报' }
  // 有序列但窗口内没有新样本：典型是 agent 停了 / 链路断了，老序列还在存储里。
  if (agent.series > 0) return { tone: 'amber', label: '采集已停' }
  return { tone: 'gray', label: '未接入' }
}

/** 三层监控：主机 → 服务 → 中间件，顶部 tab 切换，不堆成一整页。 */
type LayerId = 'hosts' | 'services' | 'middleware'

/** 采集侧的三档（tab 提示与首屏读数共用同一份口径）。 */
function fleetCounts(agents: MetricsAgent[]): {
  reporting: number
  silent: number
  noSeries: number
} {
  return {
    reporting: agents.filter((agent) => agent.samples > 0).length,
    silent: agents.filter((agent) => agent.samples === 0 && agent.series > 0).length,
    noSeries: agents.filter((agent) => agent.series === 0).length,
  }
}

/** 名字前缀分组：目录里 `system_*` 会占掉大半，分组后一眼能看出「哪几类在写」。 */
function CatalogGroup({ group, entries }: { group: string; entries: MetricsCatalogEntry[] }) {
  const series = entries.reduce((total, entry) => total + entry.series, 0)
  return (
    <details className="catalog-group" open={group === 'agent'}>
      <summary>
        <span className="catalog-group__name">{group}_*</span>
        <span className="catalog-group__meta">
          {entries.length} 个指标 · {series} 条序列
        </span>
      </summary>
      <ul className="catalog-list">
        {entries.map((entry) => (
          <li key={entry.name}>
            <code className="mono">{entry.name}</code>
            <span className="catalog-list__series">{entry.series}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

// ── 主机层：一台机一张卡，按严重程度排 ────────────────────────────────────────

type GaugeTone = 'ok' | 'warn' | 'crit' | 'none'

/** 百分比条。负载可以超过 100%（核数被跑满），条夹在 100% 不溢出。 */
function Gauge({ percent, tone }: { percent: number | null; tone: GaugeTone }) {
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  return (
    <span className="gauge" aria-hidden="true">
      {percent !== null && Number.isFinite(percent) ? (
        <span className={`gauge__fill gauge__fill--${tone}`} style={{ width: `${width}%` }} />
      ) : null}
    </span>
  )
}

function percentTone(percent: number | null): GaugeTone {
  if (percent === null || !Number.isFinite(percent)) return 'none'
  if (percent >= 85) return 'crit'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/** 告警参考线的位置与 `percentTone` 共用同一个数字：85% 以上算严重。 */
const CRIT_THRESHOLD = 85

/**
 * 一条读数的走势（代替纯色条）。
 *
 * 形状比分位更早告警：从 40% 爬到 80% 和一直 80% 是两回事。
 * y 轴固定 0~100%，所以「线多高」仍然能当「多满」读，和原来的条是一个量纲。
 * （**不**按数据自适应：自适应会让 88% 的平线和 9% 的平线长得一模一样，主机墙就失去了横比。）
 *
 * 三件套各管一件事（Tufte sparkline + Few bullet graph 的阈值标线）：
 * - 告警参考线 = 阈值，位置与 `percentTone` 同源，「线过没过红线」直接读；
 * - 线 = 形状，它的**高度**就是「多满」（不再画面积：16px 高的框里 87% 的填充就是一块灰砖）；
 * - 末点 = 「现在」，圆点颜色跟着当前严重度走。
 *
 * 为什么不用「定性区间带」（bullet graph 的常用写法）：它把阈值画成**背景色块**，
 * 13 张卡每张都重复同一块色块，就变成了与数据无关的装饰；一根标线只占 1px。
 */
function Spark({
  points,
  tone,
  threshold,
}: {
  points: [number, number][]
  tone: GaugeTone
  /** 告警阈值（0~100），画一根横向参考线。不传就不画。 */
  threshold?: number
}) {
  if (points.length < 2) return null
  const width = 100
  const height = 16
  const values = points.map((point) => Math.max(0, Math.min(100, point[1])))
  const step = width / (values.length - 1)
  const yOf = (value: number) => (height - (value / 100) * height).toFixed(2)
  const line = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(2)},${yOf(value)}`)
    .join(' ')
  const now = yOf(values[values.length - 1])
  return (
    <span className={`spark spark--${tone}`}>
      <svg className="spark__svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        {threshold === undefined ? null : (
          <path
            className="spark__threshold"
            d={`M0,${yOf(threshold)} L${width},${yOf(threshold)}`}
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path className="spark__line" d={line} vectorEffect="non-scaling-stroke" />
        {/* 末点：0.01 长的一段 + 圆头 + non-scaling-stroke，得到不随横向拉伸变形的圆点。 */}
        <path
          className={`spark__now spark__now--${tone}`}
          d={`M${width},${now} L${width - 0.01},${now}`}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  )
}

/** 卡片里只留整数百分比：272px 宽的卡放不下 `92.00% / 16.00 GB`。 */
function formatPercentCompact(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`
}

/** 负载的参照是核数：1.0 = 刚好跑满，2.0 = 平均每个核排着两个任务。 */
function loadTone(ratio: number | null): GaugeTone {
  if (ratio === null || !Number.isFinite(ratio)) return 'none'
  if (ratio >= 2) return 'crit'
  if (ratio >= 1) return 'warn'
  return 'ok'
}

function hostLabel(agent: MetricsAgent): string {
  return agent.host.hostname ?? agent.host.ip_addresses[0] ?? agent.agent_id
}

/**
 * 摘要卡上的身份：主机名 → IP → agent id。
 *
 * agent id 是关联键（和下面的主机卡对得上），但人认不出它，所以只在
 * 「名字是真的」（有 hostname 或 IP）时才把它放第二行。
 */
function hostIdentity(agent: MetricsAgent): { name: string; sub: string | null } {
  const ip = agent.host.ip_addresses.join(', ')
  if (agent.host.hostname) return { name: agent.host.hostname, sub: ip || agent.agent_id }
  if (ip) return { name: ip, sub: agent.agent_id }
  return { name: agent.agent_id, sub: null }
}

/** 1m 负载 / 核数。核数未知时不拿原始负载假装成利用率。 */
function loadRatio(agent: MetricsAgent): number | null {
  const load = agent.host.load_1m
  const cores = agent.cpu_cores
  if (load === null || cores === null || !Number.isFinite(cores) || cores <= 0) return null
  return load / cores
}

/**
 * 挂载点的说法。
 *
 * agentd 报最紧的文件系统时，`/` 与系统盘是同一个东西 —— 直接画出来就成了「61% / /」。
 * 空字符串同理（不能当 `null` 处理，否则 `??` 不会兜底）。
 */
function mountName(mount: string | null): string {
  const trimmed = (mount ?? '').trim()
  return trimmed && trimmed !== '/' ? trimmed : '系统盘'
}

/** 这台机最坏的一个读数（负载按核数折算成百分比），用于排序与摘要。 */
function hostPressure(agent: MetricsAgent): number | null {
  const ratio = loadRatio(agent)
  const readings = [
    ratio === null ? null : ratio * 100,
    agent.host.memory_usage_percent,
    agent.host.disk_usage_percent,
    agent.host.filesystem_usage_percent,
  ].filter((value): value is number => value !== null && Number.isFinite(value))
  return readings.length === 0 ? null : Math.max(...readings)
}

/**
 * 主机墙的顺序就是严重程度：静默/无序列在前，然后按最坏读数降序。
 *
 * 「有问题的永远在前几台」是这一层的核心承诺 —— 所以不把排序交给用户点。
 */
function sortBySeverity(agents: MetricsAgent[]): MetricsAgent[] {
  const silent = (agent: MetricsAgent) => (agent.samples > 0 ? 1 : 0)
  const score = (agent: MetricsAgent) => hostPressure(agent) ?? -1
  return [...agents].sort(
    (left, right) =>
      silent(left) - silent(right) ||
      score(right) - score(left) ||
      hostLabel(left).localeCompare(hostLabel(right)),
  )
}

/**
 * 一台主机卡：身份（主机名 + IP）+ 三条读数 + 走势。
 *
 * 卡本身不是按钮：它的职责是「一眼看清」，不承担导航。从服务页 / 上方读数卡点过来时，
 * 用 `--selected` 高亮加 `scrollIntoView` 把那张卡带到视野里。
 */
function HostCard({
  agent,
  series,
  selected,
}: {
  agent: MetricsAgent
  /** 这台机的三条走势；取不到时回退成瞬时条。 */
  series?: MetricsHostTrend
  selected: boolean
}) {
  const host = agent.host
  const silent = agent.samples === 0
  const neverReported = agent.series === 0
  const ratio = loadRatio(agent)
  const memory = host.memory_usage_percent
  // 磁盘看「最紧的那个」：系统盘满了是事故，/data 满了也是事故。
  const disk = host.disk_usage_percent
  const filesystem = host.filesystem_usage_percent
  const tightest = Math.max(disk ?? -1, filesystem ?? -1)
  const diskPercent = tightest < 0 ? null : tightest
  const diskHint =
    filesystem !== null && filesystem >= (disk ?? -1) ? mountName(host.filesystem_mount) : '系统盘'
  const hasFacts = host.hostname !== null || host.load_1m !== null || memory !== null
  // 趋势按条上同一个量纲折算：负载 / 核数 → 利用率，内存 / 磁盘 ×100。
  const cores = agent.cpu_cores && agent.cpu_cores > 0 ? agent.cpu_cores : null
  const loadTrend: [number, number][] =
    series?.load_1m.map(([at, value]) => [at, cores ? (value / cores) * 100 : value]) ?? []
  const memoryTrend: [number, number][] =
    series?.memory_usage.map(([at, value]) => [at, value * 100]) ?? []
  const diskTrend: [number, number][] =
    series?.disk_usage.map(([at, value]) => [at, value * 100]) ?? []
  // 主标题给人认的名字（主机名 / IP），agent id 退到右边当关联键（见 `hostIdentity`）。
  const identity = hostIdentity(agent)
  const addr = identity.sub ?? ''
  // 三条读数各自的严重度：图上的末点和右边的读数是同一个颜色，一个语义只给一处颜色。
  const loadLevel = loadTone(ratio)
  const memoryLevel = percentTone(memory)
  const diskLevel = percentTone(diskPercent)

  return (
    <div
      id={`host-card-${agent.agent_id}`}
      className={selected ? 'host-card host-card--selected' : 'host-card'}
    >
      <span className="host-card__head">
        <strong className="host-card__name">{identity.name}</strong>
        {addr ? <span className="host-card__addr mono">{addr}</span> : null}
      </span>

      <span className="host-card__os">
        {[host.os, host.arch, host.kernel].filter(Boolean).join(' / ') || 'OS / 内核未上报'}
      </span>

      {silent && !neverReported ? (
        <span className="host-card__stale">采集已停：下面是最后一次上报的值</span>
      ) : null}

      {hasFacts ? (
        <span className="host-card__rows">
          <span className="host-row">
            <span className="host-row__label">负载 1m</span>
            {loadTrend.length >= 2 ? (
              <Spark points={loadTrend} tone={loadLevel} />
            ) : (
              <Gauge percent={ratio === null ? null : ratio * 100} tone={loadLevel} />
            )}
            <span className={`host-row__num host-row__num--${loadLevel}`}>
              {host.load_1m === null ? '—' : host.load_1m.toFixed(2)}
            </span>
            <span className="host-row__hint">
              {host.load_1m !== null && agent.cpu_cores ? `/ ${Math.round(agent.cpu_cores)} 核` : ''}
            </span>
          </span>
          <span className="host-row">
            <span className="host-row__label">内存</span>
            {memoryTrend.length >= 2 ? (
              <Spark points={memoryTrend} tone={memoryLevel} threshold={CRIT_THRESHOLD} />
            ) : (
              <Gauge percent={memory} tone={memoryLevel} />
            )}
            <span className={`host-row__num host-row__num--${memoryLevel}`}>{formatPercentCompact(memory)}</span>
            <span className="host-row__hint">
              {host.memory_total_bytes === null ? '' : `/ ${formatBytes(host.memory_total_bytes)}`}
            </span>
          </span>
          <span className="host-row">
            <span className="host-row__label">磁盘</span>
            {diskTrend.length >= 2 ? (
              <Spark points={diskTrend} tone={diskLevel} threshold={CRIT_THRESHOLD} />
            ) : (
              <Gauge percent={diskPercent} tone={diskLevel} />
            )}
            <span className={`host-row__num host-row__num--${diskLevel}`}>{formatPercentCompact(diskPercent)}</span>
            <span className="host-row__hint">{diskPercent === null ? '' : `/ ${diskHint}`}</span>
          </span>
        </span>
      ) : (
        <span className="host-card__norows">
          {neverReported
            ? '还没有采到这台机的任何指标（agent 未接入 / 未推数据）。'
            : '只有自观测：这台 agentd 没报宿主侧指标（system_* / process_*）。'}
        </span>
      )}

      <span className="host-card__foot">
        <span>{formatUptime(host.uptime_seconds)}</span>
        <span>{host.processes === null ? '进程数未采集' : `${Math.round(host.processes)} 进程`}</span>
      </span>
    </div>
  )
}

/** 首屏四个读数：全部是运维口径，点一下把那张主机卡滚到视野中央。 */
function FleetSummary({
  agents,
  counts,
  windowMinutes,
  onSelect,
}: {
  agents: MetricsAgent[]
  counts: { reporting: number; silent: number; noSeries: number }
  windowMinutes: number
  onSelect: (agentId: string) => void
}) {
  const { reporting, silent, noSeries } = counts

  const pick = (score: (agent: MetricsAgent) => number | null): MetricsAgent | null => {
    let best: MetricsAgent | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const agent of agents) {
      const value = score(agent)
      if (value === null || !Number.isFinite(value)) continue
      if (value > bestScore) {
        best = agent
        bestScore = value
      }
    }
    return best
  }

  const topLoad = pick(loadRatio)
  const topMemory = pick((agent) => agent.host.memory_usage_percent)
  const topDisk = pick((agent) =>
    Math.max(agent.host.disk_usage_percent ?? -1, agent.host.filesystem_usage_percent ?? -1) < 0
      ? null
      : Math.max(
          agent.host.disk_usage_percent ?? -1,
          agent.host.filesystem_usage_percent ?? -1,
        ),
  )

  const hostCard = (
    label: string,
    agent: MetricsAgent | null,
    detail: (agent: MetricsAgent) => string,
    tone?: 'warn' | 'crit',
  ) => {
    if (!agent) {
      return (
        <div className="metric">
          <span className="metric__label">{label}</span>
          <span className="metric__value">—</span>
          <span className="metric__hint">这一维还没有数据</span>
        </div>
      )
    }
    const identity = hostIdentity(agent)
    return (
      <button type="button" className="metric metric--action" onClick={() => onSelect(agent.agent_id)}>
        <span className="metric__label">{label}</span>
        <span className={`metric__value metric__value--mono${tone ? ` metric__value--${tone}` : ''}`}>
          {identity.name}
        </span>
        {identity.sub ? <span className="metric__sub mono">{identity.sub}</span> : null}
        <span className="metric__hint">{detail(agent)}</span>
      </button>
    )
  }

  const critOrNone = (tone: GaugeTone): 'crit' | undefined => (tone === 'crit' ? 'crit' : undefined)
  const diskPercentOf = (agent: MetricsAgent) => {
    const tightest = Math.max(
      agent.host.disk_usage_percent ?? -1,
      agent.host.filesystem_usage_percent ?? -1,
    )
    return tightest < 0 ? null : tightest
  }

  return (
    <div className="metrics">
      <div className="metric">
        <span className="metric__label">采集状态</span>
        <span className="metric__value">
          {reporting}
          <span className="metric__unit">/ {agents.length} 台在报</span>
        </span>
        <span className="metric__hint">
          静默 {silent} · 无序列 {noSeries} · 采样窗口 {windowMinutes} 分钟（窗口内没有样本 = 断了一块，不是「值为 0」）
        </span>
      </div>
      {hostCard(
        '负载最高',
        topLoad,
        (agent) => {
          const ratio = loadRatio(agent)
          const cores = agent.cpu_cores ? `${Math.round(agent.cpu_cores)} 核` : '核数未知'
          const load = agent.host.load_1m === null ? '—' : agent.host.load_1m.toFixed(2)
          return ratio === null
            ? `1m ${load} · ${cores}`
            : `1m ${load} / ${cores} · ${(ratio * 100).toFixed(0)}%`
        },
        critOrNone(loadTone(topLoad ? loadRatio(topLoad) : null)),
      )}
      {hostCard(
        '内存最紧',
        topMemory,
        (agent) => {
          const used = agent.host.memory_usage_percent
          const total = agent.host.memory_total_bytes
          return total === null
            ? formatValue(used, 'percent')
            : `${formatValue(used, 'percent')} · 共 ${formatBytes(total)}`
        },
        critOrNone(percentTone(topMemory?.host.memory_usage_percent ?? null)),
      )}
      {hostCard(
        '磁盘最紧',
        topDisk,
        (agent) => {
          const disk = agent.host.disk_usage_percent
          const filesystem = agent.host.filesystem_usage_percent
          const where =
            filesystem !== null && filesystem >= (disk ?? -1)
              ? mountName(agent.host.filesystem_mount)
              : '系统盘'
          return `${formatValue(diskPercentOf(agent), 'percent')} · ${where}`
        },
        critOrNone(percentTone(topDisk ? diskPercentOf(topDisk) : null)),
      )}
    </div>
  )
}

/** 服务层的一行：按 `app`（用途）分组后的一组实例。 */
interface ServiceRow {
  app: string
  hosts: number
  reporting: number
  processes: number | null
  cpuPercent: number | null
  memoryBytes: number | null
  series: number
}

/** 服务层：`app` 表达用途，同一用途可能落在多台主机上。 */
function serviceRows(agents: MetricsAgent[]): ServiceRow[] {
  const groups = new Map<string, MetricsAgent[]>()
  for (const agent of agents) {
    const app = agent.labels.app ?? ''
    const bucket = groups.get(app) ?? []
    bucket.push(agent)
    groups.set(app, bucket)
  }
  return [...groups.entries()]
    .map(([app, members]) => ({
      app,
      hosts: members.length,
      reporting: members.filter((agent) => agent.samples > 0).length,
      processes: sumDefined(members, (agent) => agent.host.processes),
      cpuPercent: sumDefined(members, (agent) => agent.cpu_percent),
      memoryBytes: sumDefined(members, (agent) => agent.memory_bytes),
      series: members.reduce((total, agent) => total + agent.series, 0),
    }))
    // 有缺口的排前面：某套服务少了一台在报，比它占多少 CPU 更值得先看。
    .sort(
      (left, right) =>
        left.reporting - left.hosts - (right.reporting - right.hosts) ||
        (right.cpuPercent ?? -1) - (left.cpuPercent ?? -1) ||
        left.app.localeCompare(right.app),
    )
}

/** 中间件层：Kafka 按 broker 画卡，其它家族有数据就列表，没数据就一行说明。 */
function MiddlewarePanel({ families }: { families: MiddlewareFamily[] }) {
  const kafka = families.find((family) => family.kind === 'kafka')
  const others = families.filter((family) => family.kind !== 'kafka')
  const quiet = others.filter((family) => family.metrics.length === 0)
  const noisy = others.filter((family) => family.metrics.length > 0)

  return (
    <div className="stack">
      {kafka && kafka.metrics.length > 0 ? (
        <KafkaPanel rows={kafka.metrics} />
      ) : (
        <Empty
          title="Kafka 还没有数据"
          hint="契约在、采集没开：需要 agentd 开 Kafka provider（协议探针，不依赖 exporter）。"
        />
      )}

      {noisy.map((family) => (
        <div key={family.kind}>
          <h3 className="mw__title">{family.label}</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>指标</th>
                  <th>实例</th>
                  <th>值</th>
                </tr>
              </thead>
              <tbody>
                {family.metrics.map((row, index) => (
                  <tr key={`${row.metric}-${row.labels.instance ?? index}`}>
                    <td>
                      <code className="mono">{row.metric}</code>
                    </td>
                    <td>
                      <code className="mono">{row.labels.instance ?? '—'}</code>
                    </td>
                    <td>{formatNumber(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {quiet.length > 0 ? (
        <p className="muted section-note">
          未采集：{quiet.map((family) => family.label).join(' · ')} ——
          契约（wist-metrics 的 spec 表）已经在，agentd 打开对应 provider 后这里会自动出现。
        </p>
      ) : null}
    </div>
  )
}

/**
 * 一个 Kafka broker 的视图模型。
 *
 * `instance` 有两种形状：broker 级带 broker 号（`kafka:<cluster>:0`），集群级不带
 * （`kafka:<cluster>`，consumer group / 离线分区就长这样）。按 instance 直接分组会把
 * 同一台 broker 拆成两张卡，所以这里按「节点 + 集群」聚合，集群级指标回填到该节点上的
 * 每个 broker。
 */
interface KafkaBroker {
  key: string
  cluster: string
  brokerId: string
  agent: string | null
  values: Map<string, number>
  states: string[]
}

function splitKafkaInstance(instance: string): { cluster: string; brokerId: string | null } {
  const parts = instance.split(':')
  // `kafka:<cluster>:<broker>` → [kafka, cluster, broker]；集群级只有两段。
  const cluster = parts[1] ?? instance
  const brokerId = parts.length > 2 ? (parts[2] ?? '') : null
  return { cluster, brokerId }
}

function kafkaBrokers(rows: MiddlewareSample[]): KafkaBroker[] {
  const brokers = new Map<string, KafkaBroker>()
  const clusterRows: MiddlewareSample[] = []

  for (const row of rows) {
    const instance = row.labels.instance
    if (!instance) continue
    const agent = row.labels.agent ?? null
    const { cluster, brokerId } = splitKafkaInstance(instance)
    if (brokerId === null) {
      // 集群级：先记下，等 broker 都建好再回填。
      clusterRows.push(row)
      continue
    }
    const key = `${agent ?? '?'}|${cluster}|${brokerId}`
    const broker = brokers.get(key) ?? {
      key,
      cluster,
      brokerId,
      agent,
      values: new Map<string, number>(),
      states: [],
    }
    broker.values.set(row.metric, row.value)
    brokers.set(key, broker)
  }

  for (const row of clusterRows) {
    const instance = row.labels.instance as string
    const agent = row.labels.agent ?? null
    const { cluster } = splitKafkaInstance(instance)
    let targets = [...brokers.values()].filter(
      (broker) => broker.cluster === cluster && broker.agent === agent,
    )
    // 没对上任何 broker（只有集群级序列）：造一张「集群」卡，不丢数据。
    if (targets.length === 0) {
      const key = `${agent ?? '?'}|${cluster}|`
      let created = brokers.get(key)
      if (!created) {
        created = {
          key,
          cluster,
          brokerId: '',
          agent,
          values: new Map<string, number>(),
          states: [],
        }
        brokers.set(key, created)
      }
      targets = [created]
    }
    for (const broker of targets) {
      if (row.metric === 'kafka_consumergroup_state') {
        if (row.labels.state && !broker.states.includes(row.labels.state)) {
          broker.states.push(row.labels.state)
        }
      } else {
        broker.values.set(row.metric, row.value)
      }
    }
  }

  return [...brokers.values()].sort((left, right) => left.key.localeCompare(right.key))
}

/** 一个 Kafka broker 的状态卡（按「节点 + 集群」透视，见 `kafkaBrokers`）。 */
function KafkaPanel({ rows }: { rows: MiddlewareSample[] }) {
  const brokers = kafkaBrokers(rows)
  const partitions = brokers.reduce(
    (total, broker) => total + (broker.values.get('kafka_partition_count') ?? 0),
    0,
  )
  const offline = brokers.reduce(
    (total, broker) => total + (broker.values.get('kafka_partition_offline') ?? 0),
    0,
  )
  // 每个集群应当恰好一个 controller。多个集群并列时不能直接数总数（每个集群各有一个）。
  const clusters = new Map<string, number>()
  for (const broker of brokers) {
    const controllers = broker.values.get('kafka_broker_role_is_controller') === 1 ? 1 : 0
    clusters.set(broker.cluster, (clusters.get(broker.cluster) ?? 0) + controllers)
  }
  const blindClusters = [...clusters.values()].filter((count) => count === 0).length

  return (
    <div className="stack">
      <div className="mw__summary">
        <span>
          <strong>{brokers.length}</strong> broker
        </span>
        <span>
          <strong>{clusters.size}</strong> 集群
        </span>
        <span>
          <strong>{formatNumber(partitions)}</strong> 分区
        </span>
        <span className={offline > 0 ? 'mw__bad' : undefined}>
          <strong>{formatNumber(offline)}</strong> 离线分区
        </span>
        {blindClusters > 0 ? (
          <span className="mw__bad">
            <strong>{blindClusters}</strong> 个集群无 controller
          </span>
        ) : null}
      </div>

      <div className="mw-grid">
        {brokers.map((broker) => {
          const up = broker.values.get('kafka_broker_up') === 1
          const controller = broker.values.get('kafka_broker_role_is_controller') === 1
          const urp = broker.values.get('kafka_partition_under_replicated') ?? 0
          const lag = broker.values.get('kafka_consumergroup_lag')
          const size = broker.values.get('kafka_log_dir_size_bytes')
          const usable = broker.values.get('kafka_log_dir_usable_bytes')
          const usedPercent =
            size !== undefined && usable !== undefined && size + usable > 0
              ? (size / (size + usable)) * 100
              : null
          return (
            <div className="mw-card" key={broker.key}>
              <div className="mw-card__head">
                <strong className="mw-card__name">
                  {broker.brokerId ? `broker ${broker.brokerId}` : 'broker'}
                  <span className="mw-card__owner mono">{broker.cluster}</span>
                </strong>
                <span className={up ? 'mw-dot mw-dot--ok' : 'mw-dot mw-dot--crit'}>
                  {up ? '在线' : '离线'}
                </span>
              </div>
              {broker.agent ? (
                <p className="mw-card__agent mono muted">{broker.agent}</p>
              ) : null}
              <div className="mw-card__rows">
                <div className="mw-row">
                  <span>角色</span>
                  <span className={controller ? 'mw__ok' : undefined}>
                    {controller ? 'controller' : 'follower'}
                  </span>
                </div>
                <div className="mw-row">
                  <span>分区</span>
                  <span className="mw-row__parts">
                    <span>{formatNumber(broker.values.get('kafka_partition_count') ?? null)}</span>
                    {urp > 0 ? <em className="mw__bad">副本不足 {formatNumber(urp)}</em> : null}
                  </span>
                </div>
                <div className="mw-row">
                  <span>日志目录</span>
                  {/* 已用 / 可用 分两列：挤成一句右对齐的长串，两个数在卡之间都对不上。 */}
                  <span className="mw-row__parts">
                    <span>{formatBytes(size ?? null)}</span>
                    <span className="muted">可用 {formatBytes(usable ?? null)}</span>
                  </span>
                </div>
                <div className="mw-row">
                  <span>消费积压</span>
                  <span className={lag !== undefined && lag > 10_000 ? 'mw__bad' : undefined}>
                    {formatNumber(lag ?? null)}
                  </span>
                </div>
              </div>
              {usedPercent === null ? null : (
                <span className="gauge" aria-hidden="true">
                  <span
                    className={`gauge__fill gauge__fill--${percentTone(usedPercent)}`}
                    style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }}
                  />
                </span>
              )}
              {broker.states.length > 0 ? (
                <div className="mw-card__states">
                  {broker.states.sort().map((state) => (
                    <Badge key={state} tone={state === 'stable' ? 'green' : 'amber'}>
                      {state}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 大数字：`111889` → `111,889`；小数保留两位。 */
function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2)
}

export function MetricsPage() {
  const [overview, setOverview] = useState<MetricsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [windowSeconds, setWindowSeconds] = useState(3_600)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<LayerId>('hosts')
  const [hostSeries, setHostSeries] = useState<MetricsHostsHistory | null>(null)
  // `undefined` = 首轮还没回来，`null` = 接口失败：两者都不能当成「没采集」。
  const [middleware, setMiddleware] = useState<MiddlewareFamily[] | null | undefined>(undefined)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const value = await getMetrics()
      setOverview(value)
      setError(null)
    } catch (err) {
      setOverview(null)
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // 概览 30 秒一轮：这一页看的是「现在」，手动刷新只是不想等。
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  // 主机墙的排序：静默的、压力最大的排前面。
  const agents = useMemo(() => sortBySeverity(overview?.agents ?? []), [overview])
  // 选中的 agent 可能已经从存储里消失（换了环境 / 改名）：回落最靠前的一台。
  const activeAgentId =
    selected && agents.some((agent) => agent.agent_id === selected)
      ? selected
      : (agents[0]?.agent_id ?? null)

  // 主机卡上的走势：一次拿全队（不是每台一条请求），失败就当没有历史，回退成瞬时条。
  const loadHostSeries = useCallback(async () => {
    try {
      setHostSeries(await getMetricsHostsHistory(windowSeconds))
    } catch {
      setHostSeries(null)
    }
  }, [windowSeconds])

  // 走势只在「主机」页上：别的页没必要每 30 秒拉一次曲线。
  useEffect(() => {
    if (tab !== 'hosts') return
    void loadHostSeries()
    const timer = window.setInterval(() => void loadHostSeries(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [loadHostSeries, tab])

  // 中间件三层的读数都不大（一次几行），跟概览一起轮询：tab 副标题要随时能说“2 broker”。
  const loadMiddleware = useCallback(async () => {
    try {
      const value = await getMetricsMiddleware()
      setMiddleware(value.families)
    } catch {
      setMiddleware(null)
    }
  }, [])

  useEffect(() => {
    void loadMiddleware()
    const timer = window.setInterval(() => void loadMiddleware(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [loadMiddleware])

  // 选中某台机（点上方读数卡 / 服务行）→ 把那张卡滚到视野中间，不然等于没点。
  useEffect(() => {
    if (!selected) return
    document
      .getElementById(`host-card-${selected}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [selected])

  const catalogGroups = new Map<string, MetricsCatalogEntry[]>()
  for (const entry of overview?.catalog ?? []) {
    const bucket = catalogGroups.get(entry.group) ?? []
    bucket.push(entry)
    catalogGroups.set(entry.group, bucket)
  }

  const activeAgent = agents.find((agent) => agent.agent_id === activeAgentId) ?? null

  const business = overview?.business ?? []
  const unassigned = overview?.unassigned_agents ?? []
  const services = serviceRows(agents)
  const counts = useMemo(() => fleetCounts(agents), [agents])
  // tab 副标题用的 catalogue 计数（中间件接口没回来之前也能显示）。
  const middlewareCatalog = (overview?.catalog ?? []).filter((entry) =>
    MIDDLEWARE_GROUPS.includes(entry.group),
  )
  const kafkaBrokersLive = useMemo(() => {
    const kafka = middleware?.find((family) => family.kind === 'kafka')
    return kafka ? kafkaBrokers(kafka.metrics) : null
  }, [middleware])
  const middlewareHint =
    kafkaBrokersLive && kafkaBrokersLive.length > 0
      ? `${kafkaBrokersLive.length} broker${
          kafkaBrokersLive.some(
            (broker) => (broker.values.get('kafka_partition_offline') ?? 0) > 0,
          )
            ? ' · 有离线分区'
            : ''
        }`
      : middlewareCatalog.length > 0
        ? `${middlewareCatalog.length} 个指标`
        : '采集未开'
  const windowMinutes = (overview?.window_seconds ?? 300) / 60

  // 点上方读数卡 / 服务行 → 切回主机页并高亮那台（滚动由 `selected` 的 effect 负责）。
  const selectHost = useCallback((agentId: string) => {
    setTab('hosts')
    setSelected(agentId)
  }, [])

  return (
    <PageShell
      title="运行指标"
      summary="三层看这一片：主机 → 服务 → 中间件。先回答「哪台 / 哪套不对」，指标的原始清单放在最后一节。读数来自计算区自己的 VictoriaMetrics（CONSOLE_VM_ENDPOINT），30 秒刷新一次。"
      actions={
        <>
          <select
            aria-label="走势窗口"
            title="只影响主机卡上的走势，不改读数本身"
            value={windowSeconds}
            onChange={(event) => setWindowSeconds(Number(event.target.value))}
          >
            {WINDOWS.map((option) => (
              <option key={option.seconds} value={option.seconds}>
                近 {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              void load()
              void loadHostSeries()
            }}
            disabled={loading}
          >
            {loading ? '加载中…' : '刷新'}
          </button>
        </>
      }
    >
      <Block wide>
        <div className="stack">
          {error ? (
            <ErrorBanner>
              {error}
              <span className="muted">
                {' '}
                —— 确认计算区的 <code className="mono">metrics</code> 起着，且数据面把
                <code className="mono">CONSOLE_VM_ENDPOINT</code> 指到了它。
              </span>
            </ErrorBanner>
          ) : null}

          {overview && agents.length === 0 ? (
            <Card title="主机">
              <Empty
                title="还没有 agent 指标"
                hint="场是由采样重建的：数据面的 wparse 要把 `agent-metrics` 分组镜像到 `CONSOLE_VM_ENDPOINT`；只写网关栈那份时，这里会一直是空的。"
              />
            </Card>
          ) : null}

          {agents.length > 0 ? (
            <div className="tabs" role="tablist" aria-label="监控分层">
              <button
                type="button"
                role="tab"
                id="layer-tab-hosts"
                aria-selected={tab === 'hosts'}
                aria-controls="layer-panel-hosts"
                className={`tabs__item${tab === 'hosts' ? ' tabs__item--active' : ''}`}
                onClick={() => setTab('hosts')}
              >
                <span className="tabs__label">主机</span>
                <span className="tabs__hint">
                  {agents.length} 台 · 在报 {counts.reporting}
                  {counts.silent > 0 ? ` · 静默 ${counts.silent}` : ''}
                  {counts.noSeries > 0 ? ` · 无序列 ${counts.noSeries}` : ''}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                id="layer-tab-services"
                aria-selected={tab === 'services'}
                aria-controls="layer-panel-services"
                className={`tabs__item${tab === 'services' ? ' tabs__item--active' : ''}`}
                onClick={() => setTab('services')}
              >
                <span className="tabs__label">服务</span>
                <span className="tabs__hint">
                  {services.length} 条
                  {services.some((service) => service.reporting < service.hosts)
                    ? ' · 有主机不在报'
                    : ' · 全部在报'}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                id="layer-tab-middleware"
                aria-selected={tab === 'middleware'}
                aria-controls="layer-panel-middleware"
                className={`tabs__item${tab === 'middleware' ? ' tabs__item--active' : ''}`}
                onClick={() => setTab('middleware')}
              >
                <span className="tabs__label">中间件</span>
                <span className="tabs__hint">{middlewareHint}</span>
              </button>
            </div>
          ) : null}

          {agents.length > 0 && tab === 'hosts' ? (
            <Card
              id="layer-panel-hosts"
              role="tabpanel"
              labelledBy="layer-tab-hosts"
              subtitle="卡里是主机的读数（宿主侧 system_* / process_*）：负载按核数折算（1.0 = 跑满）、内存、最紧的磁盘，每条都带近一段时间的走势；采集停了会多一行提示（读数是最后一次上报的值）。卡片顺序 = 严重程度，压力大的与采集断的永远排在前面。"
            >
              <FleetSummary
                agents={agents}
                counts={counts}
                windowMinutes={windowMinutes}
                onSelect={selectHost}
              />

              <div className="host-grid">
                {agents.map((agent) => (
                  <HostCard
                    key={agent.agent_id}
                    agent={agent}
                    series={hostSeries?.hosts[agent.agent_id]}
                    selected={agent.agent_id === activeAgentId}
                  />
                ))}
              </div>

              {business.length > 0 ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>业务归属</th>
                        <th>主机</th>
                        <th>负载 1m 峰值</th>
                        <th>内存</th>
                        <th>磁盘峰值</th>
                        <th>进程</th>
                        <th>采集目标</th>
                        <th>序列</th>
                      </tr>
                    </thead>
                    <tbody>
                      {business.map((unit) => (
                        <BusinessRowView key={unit.id} unit={unit} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted section-note">
                  还没有业务归属配置：在 <code className="mono">field-api.toml</code> 的{' '}
                  <code className="mono">[[business.units]]</code> 里把主机集合归到业务，就能按业务
                  汇总（不影响上面的读数）。
                </p>
              )}
              {unassigned.length > 0 ? (
                <div className="chips">
                  <span className="chip">
                    未归类 <strong>{unassigned.length}</strong> 台
                  </span>
                  {unassigned.map((agentId) => (
                    <span key={agentId} className="chip">
                      <code className="mono">{agentId}</code>
                    </span>
                  ))}
                </div>
              ) : null}
            </Card>
          ) : null}

          {agents.length > 0 && tab === 'services' ? (
            <Card
              id="layer-panel-services"
              role="tabpanel"
              labelledBy="layer-tab-services"
              subtitle="按 app（用途）分组：一条服务落在几台主机、有几台在报、各占多少 CPU / 内存。有缺口的排在前面。点一行跳到那台主机。"
            >
              <div className="table-wrap">
                <table className="table table--clickable">
                  <thead>
                    <tr>
                      <th>服务（app）</th>
                      <th>主机</th>
                      <th>状态</th>
                      <th>CPU</th>
                      <th>内存</th>
                      <th>进程</th>
                      <th>序列</th>
                    </tr>
                  </thead>
                  <tbody>
                    {services.map((service) => {
                      // 一行可能对应多台机：点它 = 看其中压力最大的那台。
                      const members = agents.filter(
                        (agent) => (agent.labels.app ?? '') === service.app,
                      )
                      const focus = sortBySeverity(members)[0]
                      const tone: BadgeTone =
                        service.reporting === service.hosts
                          ? 'green'
                          : service.reporting === 0
                            ? 'red'
                            : 'amber'
                      return (
                        <tr
                          key={service.app || '(未标注)'}
                          onClick={() => {
                            if (!focus) return
                            // 趋势卡已去掉：点一行 = 切回主机页并高亮那台机。
                            setTab('hosts')
                            setSelected(focus.agent_id)
                          }}
                        >
                          <td>
                            {service.app ? (
                              <code className="mono">{service.app}</code>
                            ) : (
                              <span className="muted">未标注 app</span>
                            )}
                          </td>
                          <td>{service.hosts}</td>
                          <td>
                            <Badge tone={tone}>
                              {service.reporting}/{service.hosts} 在报
                            </Badge>
                          </td>
                          <td>{formatValue(service.cpuPercent, 'percent')}</td>
                          <td>{formatValue(service.memoryBytes, 'bytes')}</td>
                          <td>{service.processes === null ? '—' : Math.round(service.processes)}</td>
                          <td>{service.series}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {agents.length > 0 && tab === 'middleware' ? (
            <Card
              id="layer-panel-middleware"
              role="tabpanel"
              labelledBy="layer-tab-middleware"
              subtitle="消息队列按 broker 画卡（在线、角色、分区、日志盘、消费积压）；数据库类有数据时按实例列出，未采集的家族在最后单列 —— 不假装它不存在。"
            >
              {middleware === null ? (
                <Empty
                  title="中间件读数拿不到"
                  hint="后端 /api/metrics/middleware 没响应；先看下面的指标统计里存储是否正常。"
                />
              ) : middleware === undefined ? (
                <Empty title="正在读取中间件读数" hint="首次加载，通常一秒内回来。" />
              ) : (
                <MiddlewarePanel families={middleware} />
              )}
            </Card>
          ) : null}

          {overview ? (
            <Card
              title="指标统计"
              subtitle="「数据到底写进来了没有」：指标名、序列数、采集侧自己的开销。排查用，不是日常看的读数。"
              aside={<Badge tone="gray">{overview.totals.names} 个指标 · {overview.totals.series} 序列</Badge>}
            >
              <div className="metrics">
                <div className="metric">
                  <span className="metric__label">指标名</span>
                  <span className="metric__value">{overview.totals.names}</span>
                  <span className="metric__hint">存储里出现过的名字总数</span>
                </div>
                <div className="metric">
                  <span className="metric__label">序列</span>
                  <span className="metric__value">{overview.totals.series}</span>
                  <span className="metric__hint">
                    本栈 VM 的全部序列；比网关栈少的那部分是只写那边的引擎统计
                  </span>
                </div>
                <div className="metric">
                  <span className="metric__label">在报 agent</span>
                  <span className="metric__value">{overview.totals.agents}</span>
                  <span className="metric__hint">
                    {`最近一次刷新 ${formatRelativeTime(overview.generated_at_ms)}`}
                  </span>
                </div>
                <div className="metric">
                  <span className="metric__label">采样窗口</span>
                  <span className="metric__value">
                    {windowMinutes}
                    <span className="metric__unit">分钟</span>
                  </span>
                  <span className="metric__hint">判断「在报 / 静默」用的窗口</span>
                </div>
              </div>

              {agents.length > 0 ? (
                <details className="catalog-more">
                  <summary>
                    采集侧（agent 自观测）：{agents.length} 个 agent 的 CPU / 内存 / 管理面时延
                  </summary>
                  <div className="table-wrap">
                    <table className="table table--clickable">
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th>环境</th>
                          <th>CPU</th>
                          <th>内存</th>
                          <th>核数</th>
                          <th>管理面时延</th>
                          <th>采集</th>
                          <th>序列</th>
                          <th>状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agents.map((agent) => {
                          const state = reportingState(agent)
                          return (
                            <tr
                              key={agent.agent_id}
                              className={
                                agent.agent_id === activeAgentId ? 'table__row--selected' : undefined
                              }
                              onClick={() => setSelected(agent.agent_id)}
                            >
                              <td>
                                <code className="mono">{agent.agent_id}</code>
                              </td>
                              <td>
                                {agent.labels.env ? (
                                  <Badge tone="gray">{agent.labels.env}</Badge>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td>{formatValue(agent.cpu_percent, 'percent')}</td>
                              <td>{formatValue(agent.memory_bytes, 'bytes')}</td>
                              <td>{agent.cpu_cores ?? '—'}</td>
                              <td>{formatValue(agent.admin_latency_ms, 'milliseconds')}</td>
                              <td>
                                {agent.samples}
                                <span className="muted"> 样本</span>
                              </td>
                              <td>{agent.series}</td>
                              <td>
                                <Badge tone={state.tone}>{state.label}</Badge>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}

              {overview.catalog.length > 0 ? (
                <details className="catalog-more">
                  <summary>
                    指标目录：{overview.catalog.length} 个指标名 · {overview.totals.series} 条序列（按前缀分组）
                  </summary>
                  <div className="catalog">
                    {[...catalogGroups.entries()].map(([group, entries]) => (
                      <CatalogGroup key={group} group={group} entries={entries} />
                    ))}
                  </div>
                </details>
              ) : null}
            </Card>
          ) : null}

          <InfoBanner tone="info">
            两份 VictoriaMetrics 互不聚合：网关栈那份给控制面观测页（含引擎 / 管道统计
            <code className="mono"> wparse_*</code>），这一份只收数据面临摹的 agent 采集指标。
            所以这里的序列数少于网关栈是正常的，缺的正是引擎统计。
          </InfoBanner>
        </div>
      </Block>
    </PageShell>
  )
}

/** 业务层的一行。`agents_missing` 是有话要说的：配置里有、存储里没有。 */
function BusinessRowView({ unit }: { unit: MetricsBusiness }) {
  return (
    <tr>
      <td>
        <strong>{unit.name}</strong>
        {unit.name !== unit.id ? <div className="table__meta">{unit.id}</div> : null}
      </td>
      <td>
        {unit.agents_present}
        {unit.agents.length > 0 ? <span className="muted">/{unit.agents.length}</span> : null}
        {unit.agents_reporting !== unit.agents_present ? (
          <div className="table__meta">在报 {unit.agents_reporting}</div>
        ) : null}
        {unit.agents_missing.length > 0 ? (
          <div className="table__meta">
            缺 <code className="mono">{unit.agents_missing.join(', ')}</code>
          </div>
        ) : null}
      </td>
      <td>{unit.load_1m_max === null ? '—' : unit.load_1m_max.toFixed(2)}</td>
      <td>
        {formatValue(unit.memory_used_bytes, 'bytes')}
        {unit.memory_total_bytes !== null ? (
          <div className="table__meta">共 {formatBytes(unit.memory_total_bytes)}</div>
        ) : null}
      </td>
      <td>{formatValue(unit.disk_usage_max, 'percent')}</td>
      <td>{unit.processes === null ? '—' : Math.round(unit.processes)}</td>
      <td>
        {unit.collect_targets === null ? '—' : Math.round(unit.collect_targets)}
        {unit.collect_dropped ? (
          <div className="table__meta">丢弃 {Math.round(unit.collect_dropped)}</div>
        ) : null}
      </td>
      <td>{unit.series}</td>
    </tr>
  )
}
