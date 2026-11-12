import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getElasticIps,
  getNetworkDomains,
  type ElasticIpItem,
  type NetworkDomainItem,
  type NetworkSegmentItem,
} from '../api'
import {
  Badge,
  Block,
  Card,
  Empty,
  ErrorBanner,
  Mono,
  PageShell,
  type BadgeTone,
} from '../components/ui'

const REFRESH_MS = 60_000

function errorText(err: unknown): string {
  return err instanceof ApiError ? `${err.message}（${err.code}）` : String(err)
}

const CHARGE_TYPES: Record<string, string> = {
  TRAFFIC_POSTPAID_BY_HOUR: '按流量',
  BANDWIDTH_POSTPAID_BY_HOUR: '按带宽',
  BANDWIDTH_PREPAID: '带宽包年包月',
  BANDWIDTH_PACKAGE: '共享带宽包',
}

const TARGET_KINDS: Record<string, string> = {
  host: '主机',
  cvm: '主机',
  nat_gateway: 'NAT 网关',
  clb: '负载均衡',
}

/**
 * 只有 `unbound` 算闲置。
 *
 * `unknown`（云侧状态没归一出来）不算 —— 闲置是要花钱的结论，猜错会让人去删一个
 * 还在用的地址。列表里仍显示它，只是不给黄标。
 */
function isIdle(ip: ElasticIpItem): boolean {
  return ip.status === 'unbound'
}

function statusTone(ip: ElasticIpItem): BadgeTone {
  if (isIdle(ip)) return 'amber'
  if (ip.status === 'bound') return 'green'
  return 'gray'
}

function statusLabel(ip: ElasticIpItem): string {
  switch (ip.status) {
    case 'bound':
      return '已绑定'
    case 'unbound':
      return '闲置'
    default:
      return '状态未知'
  }
}

function targetKindLabel(ip: ElasticIpItem): string | null {
  if (!ip.boundTargetKind) return null
  return TARGET_KINDS[ip.boundTargetKind] ?? ip.boundTargetKind
}

function bindingText(ip: ElasticIpItem): string {
  const kind = targetKindLabel(ip)
  const target = ip.boundExternalTargetRef
  if (!kind && !target) return '未绑定'
  return [kind, target].filter(Boolean).join(' · ')
}

function accountShort(account: string | null): string {
  if (!account) return '—'
  const at = account.lastIndexOf(':')
  return at >= 0 ? account.slice(at + 1) : account
}

/**
 * CIDR 一共多少个地址（IPv4）。
 *
 * 只做量级判断用（「/16 有 6 万多个地址，只用了 3 个子网」这类），所以不扣网络地址
 * 和广播地址 —— 那是地址规划的问题，不是这张页要回答的。
 */
function cidrAddresses(cidr: string | null): number | null {
  if (!cidr) return null
  const slash = cidr.lastIndexOf('/')
  if (slash < 0) return null
  const prefix = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  return 2 ** (32 - prefix)
}

function formatAddresses(count: number | null): string {
  if (count === null) return '—'
  if (count >= 1024) return `${Math.round(count / 1024)}K`
  return String(count)
}

/** 这个 VPC 有没有「东西」：主机或非空子网任一存在。 */
function isUsedDomain(domain: NetworkDomainItem): boolean {
  return domain.segments.some((segment) => segment.hostCount > 0)
}

function domainHosts(domain: NetworkDomainItem): number {
  return domain.segments.reduce((sum, segment) => sum + segment.hostCount, 0)
}

/** 排序：有主机的在前（主机多的更靠前），其次子网多的，最后才是名字。 */
function compareDomains(a: NetworkDomainItem, b: NetworkDomainItem): number {
  const byHosts = domainHosts(b) - domainHosts(a)
  if (byHosts !== 0) return byHosts
  const bySegments = b.segments.length - a.segments.length
  if (bySegments !== 0) return bySegments
  return a.name.localeCompare(b.name)
}

/**
 * 网络资产：VPC → 子网，以及弹性公网 IP。
 *
 * 为什么单独一页而不是塞进「资产拓扑」：画布只能画「被主机用到的网段」，而
 * **地址空间的边界**（VPC 的 CIDR、空子网）和**暴露面**（公网 IP 绑在哪）是
 * 列表才能回答的问题 —— 画布上再加一层节点只会把主机挤小。
 *
 * 这一页刻意不是「把表倒出来」：
 * - **按有用性排序**，空 VPC 折叠：云上自带的 `Default-VPC` 会占掉大半屏；
 * - 每个数字都带「所以呢」（子网 9 / 256、17 个空子网、0 个闲置地址）；
 * - 能从清单**跳到拓扑**：看到可疑的子网/主机，下一步就是去看它连着谁。
 */
export function NetworkPage({ onOpenTopology }: { onOpenTopology: (target: { networkId?: string; hostId?: string }) => void }) {
  const [domains, setDomains] = useState<NetworkDomainItem[] | null>(null)
  const [ips, setIps] = useState<ElasticIpItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 两个接口互不依赖：一个失败不该把另一个也清空。
      const [domainResult, ipResult] = await Promise.allSettled([
        getNetworkDomains(),
        getElasticIps(),
      ])
      const failures: string[] = []
      if (domainResult.status === 'fulfilled') setDomains(domainResult.value)
      else failures.push(`网络：${errorText(domainResult.reason)}`)
      if (ipResult.status === 'fulfilled') setIps(ipResult.value)
      else failures.push(`公网 IP：${errorText(ipResult.reason)}`)
      setError(failures.length > 0 ? failures.join('；') : null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const model = useMemo(() => {
    const sorted = [...(domains ?? [])].sort(compareDomains)
    const used = sorted.filter(isUsedDomain)
    const unused = sorted.filter((domain) => !isUsedDomain(domain))
    const segments = sorted.flatMap((domain) => domain.segments)
    const emptySegments = segments.filter((segment) => segment.hostCount === 0)
    const accounts = [...new Set(sorted.map((domain) => domain.cloudAccount).filter(Boolean))]
    const bindingKinds = new Map<string, number>()
    for (const ip of ips ?? []) {
      const key = ip.boundTargetKind ?? 'none'
      bindingKinds.set(key, (bindingKinds.get(key) ?? 0) + 1)
    }
    return {
      used,
      unused,
      segmentCount: segments.length,
      emptySegments: emptySegments.length,
      accounts,
      bindingKinds,
      idleCount: (ips ?? []).filter(isIdle).length,
      hostTotal: sorted.reduce((sum, domain) => sum + domainHosts(domain), 0),
    }
  }, [domains, ips])

  const boundByHost = model.bindingKinds.get('host') ?? 0
  const boundByNat = model.bindingKinds.get('nat_gateway') ?? 0

  return (
    <PageShell
      title="网络资产"
      summary={
        <>
          VPC / 子网与弹性公网 IP，来自云账号采集（wist-atlas）。{' '}
          <span className="muted">
            空子网是占着不用的 CIDR，闲置公网 IP 照样按小时计费 —— 这两类排在最前。
          </span>
        </>
      }
      actions={
        <button
          type="button"
          className="button button--ghost button--sm"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? '同步中…' : '刷新'}
        </button>
      }
    >
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <Block wide>
        <div className="metrics">
          <Stat
            label="VPC"
            value={domains?.length ?? '—'}
            hint={
              domains
                ? `${model.used.length} 个有主机 · ${model.unused.length} 个空壳`
                : undefined
            }
          />
          <Stat
            label="子网"
            value={domains ? model.segmentCount : '—'}
            hint={
              domains ? `${model.emptySegments} 个没有主机，${model.hostTotal} 台机分布在其余子网` : undefined
            }
            tone={model.emptySegments > 0 ? 'amber' : undefined}
          />
          <Stat
            label="公网 IP"
            value={ips?.length ?? '—'}
            hint={ips ? `${boundByHost} 台主机入口 · ${boundByNat} 个 NAT 网关` : undefined}
          />
          <Stat
            label="闲置地址"
            value={ips ? model.idleCount : '—'}
            hint={ips ? (model.idleCount === 0 ? '没有白付的地址' : '每小时都在计费') : undefined}
            tone={model.idleCount > 0 ? 'amber' : 'green'}
          />
        </div>
      </Block>

      <Block wide>
        <Card
          title="地址空间"
          subtitle={
            domains && domains.length > 0
              ? `按主机数排序${model.unused.length > 0 ? `；${model.unused.length} 个 Default-VPC 是云上自带的空壳，折叠在最后` : ''}。区域暂未采集 —— 同名 VPC 只能靠 CIDR 区分。`
              : '子网按所属 VPC 分组'
          }
          aside={
            model.accounts.length > 0 ? (
              <span className="muted">账号 {model.accounts.map(accountShort).join(' / ')}</span>
            ) : undefined
          }
        >
          {domains === null ? (
            <p className="muted">{loading ? '正在读取…' : '尚未读取'}</p>
          ) : domains.length === 0 ? (
            <Empty
              title="还没有采集到 VPC"
              hint="云账号资产由 wist-harvest 采集后写入 atlas；确认采集任务在跑。"
            />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>VPC / 子网</th>
                      <th>CIDR</th>
                      <th>地址数</th>
                      <th>主机 / 容量</th>
                      <th>云侧 id</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {model.used.map((domain) => (
                      <DomainRows
                        key={domain.id}
                        domain={domain}
                        onOpenTopology={onOpenTopology}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {model.unused.length > 0 ? (
                <details className="details" style={{ marginTop: 12 }}>
                  <summary className="details__summary">
                    还有 {model.unused.length} 个空 VPC（
                    {model.unused.reduce((sum, domain) => sum + domain.segments.length, 0)} 个子网，全部没有主机）
                  </summary>
                  <div className="details__body">
                    <table className="table">
                      <tbody>
                        {model.unused.map((domain) => (
                          <DomainRows
                            key={domain.id}
                            domain={domain}
                            onOpenTopology={onOpenTopology}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}
            </>
          )}
        </Card>
      </Block>

      <Block wide>
        <Card
          title="弹性公网 IP"
          subtitle="闲置的排最前：云上释放之前它每小时都在计费。绑在主机上的地址就是这台机对外的入口。"
        >
          {ips === null ? (
            <p className="muted">{loading ? '正在读取…' : '尚未读取'}</p>
          ) : ips.length === 0 ? (
            <Empty title="还没有采集到公网 IP" hint="确认云账号采集覆盖了 EIP 类型。" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>地址</th>
                    <th>状态</th>
                    <th>绑定目标</th>
                    <th>计费 / 带宽</th>
                    <th>地址 id</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {[...ips]
                    .sort((a, b) => Number(isIdle(b)) - Number(isIdle(a)))
                    .map((ip) => (
                      <tr key={ip.id}>
                        <td>
                          <Mono>{ip.address}</Mono>
                        </td>
                        <td>
                          <Badge tone={statusTone(ip)}>{statusLabel(ip)}</Badge>
                        </td>
                        <td>
                          {bindingText(ip)}
                          {ip.boundTargetKind && !ip.boundHostId ? (
                            <div className="muted">未归集到主机，仅保留云侧 id</div>
                          ) : null}
                        </td>
                        <td>
                          {[
                            ip.chargeType ? (CHARGE_TYPES[ip.chargeType] ?? ip.chargeType) : null,
                            ip.bandwidthMbps === null ? null : `${ip.bandwidthMbps} Mbps`,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                        <td>
                          <Mono>{ip.externalRef}</Mono>
                        </td>
                        <td>
                          {ip.boundHostId ? (
                            <button
                              type="button"
                              className="button button--ghost button--sm"
                              onClick={() => onOpenTopology({ hostId: ip.boundHostId ?? undefined })}
                            >
                              看主机
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Block>
    </PageShell>
  )
}

/**
 * 一个 VPC 一行摘要 + 每个子网一行（缩进，不嵌表格）。
 *
 * 两类行共用一套列义：名称 / CIDR / 容量 / 用掉多少 / 云侧 id。
 * 混着给两套列义会让人以为第 4 列既是「主机数」又是「子网 id」。
 */
function DomainRows({
  domain,
  onOpenTopology,
}: {
  domain: NetworkDomainItem
  onOpenTopology: (target: { networkId?: string; hostId?: string }) => void
}) {
  return (
    <>
      <tr>
        <td>
          <strong>{domain.name}</strong>
          <div className="muted">{domain.segments.length} 个子网</div>
        </td>
        <td>
          <Mono>{domain.cidr ?? '—'}</Mono>
        </td>
        <td>{formatAddresses(cidrAddresses(domain.cidr))}</td>
        <td>{domainHosts(domain)} 台机</td>
        <td>
          <Mono>{domain.externalRef ?? '—'}</Mono>
        </td>
        <td />
      </tr>
      {domain.segments.map((segment) => (
        <SegmentRow key={segment.id} segment={segment} onOpenTopology={onOpenTopology} />
      ))}
    </>
  )
}

function SegmentRow({
  segment,
  onOpenTopology,
}: {
  segment: NetworkSegmentItem
  onOpenTopology: (target: { networkId?: string; hostId?: string }) => void
}) {
  const capacity = cidrAddresses(segment.cidr)
  const ratio = capacity && capacity > 0 ? Math.min(1, segment.hostCount / capacity) : 0
  const empty = segment.hostCount === 0
  return (
    <tr>
      <td>
        <span className="muted">└&nbsp;{segment.name}</span>
      </td>
      <td>
        <Mono>{segment.cidr ?? '—'}</Mono>
      </td>
      <td>{formatAddresses(capacity)}</td>
      <td>
        {empty ? (
          <Badge tone="amber">空子网</Badge>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 44,
                height: 4,
                borderRadius: 2,
                background: 'var(--border)',
              }}
            >
              <span
                style={{
                  display: 'block',
                  // 再小也给 3%：一条看不见的线跟「0」分不出来。
                  width: `${Math.max(3, ratio * 100)}%`,
                  height: '100%',
                  borderRadius: 2,
                  background: 'var(--accent)',
                }}
              />
            </span>
            <span className="muted">
              {segment.hostCount} / {capacity ?? '—'}
            </span>
          </span>
        )}
      </td>
      <td>
        <Mono>{segment.externalRef ?? '—'}</Mono>
      </td>
      <td>
        <button
          type="button"
          className="button button--ghost button--sm"
          onClick={() => onOpenTopology({ networkId: segment.id })}
        >
          看拓扑
        </button>
      </td>
    </tr>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: BadgeTone
}) {
  // 只有「要处理」的才上色：好状态给绿字在深色主题下反而像在报警。
  const toneClass = tone === 'amber' ? ' metric__value--warn' : ''
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className={`metric__value${toneClass}`}>{value}</span>
      {hint ? <span className="metric__hint">{hint}</span> : null}
    </div>
  )
}
