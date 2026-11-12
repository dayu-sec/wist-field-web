import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  getElasticIps,
  getNetworkDomains,
  type ElasticIpItem,
  type NetworkDomainItem,
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
 * 还在用的地址。列表里仍会显示它，只是不给黄标。
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

function bindingText(ip: ElasticIpItem): string {
  const kind = ip.boundTargetKind ? (TARGET_KINDS[ip.boundTargetKind] ?? ip.boundTargetKind) : null
  const target = ip.boundExternalTargetRef
  if (!kind && !target) return '未绑定'
  return [kind, target].filter(Boolean).join(' · ')
}

function accountShort(account: string | null): string {
  if (!account) return '—'
  const at = account.lastIndexOf(':')
  return at >= 0 ? account.slice(at + 1) : account
}

function domainHosts(domain: NetworkDomainItem): number {
  return domain.segments.reduce((sum, segment) => sum + segment.hostCount, 0)
}

/**
 * 网络资产：VPC → 子网，以及弹性公网 IP。
 *
 * 为什么单独一页而不是塞进「资产拓扑」：画布只能画「被主机用到的网段」，而
 * **地址空间的边界**（VPC 的 CIDR、空子网）和**暴露面**（公网 IP 绑在哪）都是
 * 列表才能回答的问题 —— 画布上再多一层节点只会把主机挤小。
 *
 * 两个产品轴在这里交叉：
 * - 成本：`unbound` 的公网 IP 照样按小时计费，是纯浪费，排最前并标黄；
 * - 暴露面：绑在主机上的地址就是这台机对外的入口，数量本身就是风险信号。
 */
export function NetworkPage() {
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

  const summary = useMemo(() => {
    const segmentCount = domains?.reduce((sum, domain) => sum + domain.segments.length, 0) ?? 0
    const idleCount = ips?.filter(isIdle).length ?? 0
    const boundCount = ips?.filter((ip) => ip.status === 'bound').length ?? 0
    return { segmentCount, idleCount, boundCount }
  }, [domains, ips])

  return (
    <PageShell
      title="网络资产"
      summary="VPC / 子网与弹性公网 IP，来自云账号采集（wist-atlas）。空子网是 CIDR 浪费，闲置公网 IP 照样计费。"
      actions={
        <button type="button" className="button button--ghost button--sm" onClick={() => void load()} disabled={loading}>
          {loading ? '同步中…' : '刷新'}
        </button>
      }
    >
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <Block wide>
        <div className="metrics">
          <Stat label="VPC" value={domains?.length ?? '—'} />
          <Stat label="子网" value={domains ? summary.segmentCount : '—'} />
          <Stat label="公网 IP" value={ips?.length ?? '—'} />
          <Stat
            label="已绑定 / 闲置"
            value={ips ? `${summary.boundCount} / ${summary.idleCount}` : '—'}
            tone={summary.idleCount > 0 ? 'amber' : undefined}
          />
        </div>
      </Block>

      <Block wide>
        <Card
          title="VPC 与子网"
          subtitle="子网按所属 VPC 分组；「主机」是该子网里还挂着的主机数（换过子网的旧关联不算）"
        >
          {domains === null ? (
            <p className="muted">{loading ? '正在读取…' : '尚未读取'}</p>
          ) : domains.length === 0 ? (
            <Empty
              title="还没有采集到 VPC"
              hint="云账号资产由 wist-harvest 采集后写入 atlas；确认采集任务在跑。"
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>VPC / 子网</th>
                    <th>CIDR</th>
                    <th>规模</th>
                    <th>云侧 id</th>
                    <th>账号 / 网关</th>
                  </tr>
                </thead>
                <tbody>
                  {domains.map((domain) => (
                    <DomainRows key={domain.id} domain={domain} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </Block>

      <Block wide>
        <Card
          title="弹性公网 IP"
          subtitle="闲置地址排在最前：云上释放之前，它每小时都在计费；绑在主机上的地址就是这台机对外的入口"
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
                    <th>计费</th>
                    <th>带宽</th>
                    <th>地址 id</th>
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
                            <span className="muted">（非主机资产，仅保留云侧 id）</span>
                          ) : null}
                        </td>
                        <td>
                          {ip.chargeType ? (CHARGE_TYPES[ip.chargeType] ?? ip.chargeType) : '—'}
                        </td>
                        <td>{ip.bandwidthMbps === null ? '—' : `${ip.bandwidthMbps} Mbps`}</td>
                        <td>
                          <Mono>{ip.externalRef}</Mono>
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
 * 两类行共用一套列义：名称 / CIDR / 规模 / 云侧 id / 附加（VPC 是账号，子网是网关）。
 * 混着给两套列义会让人以为第 4 列既是「主机数」又是「子网 id」。
 */
function DomainRows({ domain }: { domain: NetworkDomainItem }) {
  return (
    <>
      <tr>
        <td>
          {domain.name}
          {domain.stale ? (
            <>
              {' '}
              <Badge tone="gray">已退役</Badge>
            </>
          ) : null}
        </td>
        <td>
          <Mono>{domain.cidr ?? '—'}</Mono>
        </td>
        <td>
          {domain.segments.length} 子网 · {domainHosts(domain)} 主机
        </td>
        <td>
          <Mono>{domain.externalRef ?? '—'}</Mono>
        </td>
        <td>{accountShort(domain.cloudAccount)}</td>
      </tr>
      {domain.segments.map((segment) => (
        <tr key={segment.id}>
          <td>
            <span className="muted">└&nbsp;{segment.name}</span>
          </td>
          <td>
            <Mono>{segment.cidr ?? '—'}</Mono>
          </td>
          <td>
            {segment.hostCount === 0 ? (
              <Badge tone="amber">空子网</Badge>
            ) : (
              <span className="muted">{segment.hostCount} 主机</span>
            )}
          </td>
          <td>
            <Mono>{segment.externalRef ?? '—'}</Mono>
          </td>
          <td>
            {segment.gatewayIp ? <Mono>{segment.gatewayIp}</Mono> : <span className="muted">—</span>}
          </td>
        </tr>
      ))}
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: BadgeTone }) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className={`metric__value${tone === 'amber' ? ' metric__value--warn' : ''}`}>
        {value}
      </span>
    </div>
  )
}
