import { useEffect, useState } from 'react'
import { ApiError, getIntegration, type IntegrationInfo } from '../api'
import { Badge, Block, Card, ErrorBanner, Field, InfoBanner, Mono, PageShell } from '../components/ui'

/**
 * 数据面入湖的**三条独立通道**：证据 / 资产拓扑（atlas）/ 运行指标。
 *
 * 三者各有各的端点与信封（证据三字段、atlas 两字段、指标走 VM 的 JSON line），
 * 所以按 tab 分开，而不是堆在同一页里让人自己挑哪段配置是自己的。
 */
export type IngestChannel = 'evidence' | 'atlas' | 'metrics'

const CHANNELS: { id: IngestChannel; label: string; hint: string }[] = [
  { id: 'evidence', label: '证据', hint: 'cust_id / cmd_id / content' },
  { id: 'atlas', label: 'Atlas', hint: 'cust_id / content（资产快照）' },
  { id: 'metrics', label: '运行指标', hint: 'VictoriaMetrics 计数' },
]

function normalizeChannel(raw: string | undefined): IngestChannel {
  const hit = CHANNELS.find((channel) => channel.id === raw)
  return hit ? hit.id : 'evidence'
}

/** 代码块：用设计令牌里现成的 `.codeblock` 结构（header + 可滚动 pre）。 */
function CodeBlock({
  label,
  hint,
  code,
}: {
  label: string
  hint?: string
  code: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="codeblock">
      <div className="codeblock__header">
        <div>
          <div className="codeblock__label">{label}</div>
          {hint ? <div className="codeblock__hint">{hint}</div> : null}
        </div>
        <div className="codeblock__actions">
          <button type="button" className="button button--ghost button--sm" onClick={() => void copy()}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      <pre className="codeblock__code">
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** 只取这条通道自己的环境变量；一条都没有时返回空串（调用方自行决定要不要显示）。 */
function envLines(env: Record<string, string>, keyPart: string): string {
  return Object.entries(env)
    .filter(([key]) => key.includes(keyPart))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/**
 * 入湖配置只给 **sink 分组**：连接器一律复用 `connectors/sink.d` 里现成的 `http_sink`，
 * 不再为证据 / atlas 各建一个 `[[connectors]]`（那只是把同一份 http 参数拄了两次）。
 * 实例侧只覆盖 `http_sink` 的 allow_override：endpoint / fmt / batch_size / headers。
 */
function httpSinkGroup({
  name,
  oml,
  bizTag,
  sinkName,
  sinkTag,
  endpoint,
}: {
  name: string
  oml: string
  bizTag: string
  sinkName: string
  sinkTag: string
  endpoint: string
}): string {
  return `[sink_group]
name = "${name}"
oml = ["${oml}"]
tags = ["biz:${bizTag}"]
batch_size = 1
batch_timeout_ms = 300

[[sink_group.sinks]]
name = "${sinkName}"
# 现成的 http 连接器（connectors/sink.d 里已有），不新增 connectors。
connect = "http_sink"
tags = ["sink:${sinkTag}"]

[sink_group.sinks.params]
endpoint = "${endpoint}"
fmt = "json"
batch_size = 1
timeout_secs = 5

[sink_group.sinks.params.headers]
Content-Type = "application/json"`
}

/**
 * 运行指标的 sink 分组。
 *
 * 照**生产里已经在跑的那一组**写（`business.d/agent_metrics.toml`：
 * `vm_metrics_sink` = 现成的 http + ndjson 连接器，endpoint 可覆盖），
 * 不是另起一种连法。
 *
 * endpoint 用**真实地址**（BFF 已按配置展开好，含导入路径），不写 `${VAR}` 占位：
 * 这段是给人 copy 到数据面配置里的，占位符还要再找地方定义一次变量，多一道错的机会。
 */
function metricsSinkGroup(endpoint: string): string {
  return `[sink_group]
name = "agent-metrics"
oml = ["agent_uplink_metrics_frame"]
tags = ["biz:agent-metrics"]
batch_size = 1024
batch_timeout_ms = 300

[[sink_group.sinks]]
name = "vm_metrics_console"
# 现成的 vm_metrics_sink（connectors/sink.d 里已有：http + ndjson），不新增 connectors。
connect = "vm_metrics_sink"
tags = ["sink:vmetrics"]

[sink_group.sinks.params]
endpoint = "${endpoint}"`
}

function FailureCard({ dedupe }: { dedupe: string }) {
  return (
    <Card title="失败与重试" subtitle="别把它当“必达”">
      <ul className="bullets">
        <li>非 2xx 会被连接器重试 3 次，仍失败落 rescue 文件（可见、可人工重放）。</li>
        <li>重复投递是安全的：{dedupe}</li>
        <li>400 / 401 / 403 / 413 / 422 是配置或数据问题，重试不会变好。</li>
      </ul>
    </Card>
  )
}

function EvidencePanel({ info }: { info: IntegrationInfo }) {
  const evidenceEnv = envLines(info.warp_parse.env, 'EVIDENCE')
  return (
    <>
      <Card
        title="写端点"
        subtitle="数据面（warp-parse）直投的地址；明文 HTTP，只在同一内网开放"
        aside={<Badge tone="blue">POST</Badge>}
      >
        <div className="kv">
          <Field label="地址">
            <Mono>{info.evidence.write_url}</Mono>
          </Field>
          <Field label="认证">
            无（<Mono>auth = "none"</Mono>，内网可信）；将来换成 HTTPS 双向认证
          </Field>
          <Field label="客户">
            <Mono>{info.evidence.customer}</Mono>
            <span className="muted">（租户就是客户）</span>
          </Field>
          <Field label="允许的 kind">
            <span className="stack-inline">
              {info.evidence.allowed_kinds.map((kind) => (
                <span key={kind} className="badge badge--gray">
                  {kind}
                </span>
              ))}
            </span>
          </Field>
          <Field label="三字段">
            <Mono>cust_id</Mono> / <Mono>cmd_id</Mono> / <Mono>content</Mono>
          </Field>
        </div>
      </Card>

      <InfoBanner>
        <strong>不新建连接器</strong>：直接用现成的 <Mono>http_sink</Mono>（在{' '}
        <Mono>connectors/sink.d</Mono> 里已有），sink 实例只覆盖 endpoint 等参数。
        发出去的就是 OML 的输出（不做字段映射），所以 OML 必须产出 <Mono>cust_id</Mono> /{' '}
        <Mono>cmd_id</Mono> / <Mono>content</Mono>。连接器没有 TLS 参数，写端口只在内网开放。
      </InfoBanner>

      <div className="stack">
        <CodeBlock
          label="topology/sinks/business.d/evidence_uplink.toml"
          hint="sink 分组：复用现成的 http_sink，只覆盖 endpoint / fmt；不用再定义 connectors"
          code={httpSinkGroup({
            name: 'evidence-uplink',
            oml: 'evidence_uplink',
            bizTag: 'evidence',
            sinkName: 'evidence',
            sinkTag: 'evidence',
            endpoint: info.evidence.write_url,
          })}
        />
        {evidenceEnv ? (
          <CodeBlock
            label="环境变量（数据面进程可见）"
            hint="只有写端点地址；auth = none 时不需要 token"
            code={evidenceEnv}
          />
        ) : null}
        <CodeBlock
          label="请求体（三字段）"
          hint="content 给字符串或 JSON 对象都行；cust_id 同时就是分区键"
          code={JSON.stringify(info.evidence.record, null, 2)}
        />
      </div>

      <FailureCard dedupe="同 cust_id + cmd_id 同内容回 200 + 同一个 artifact_id。" />
    </>
  )
}

function AtlasPanel({ info }: { info: IntegrationInfo }) {
  const atlas = info.atlas ?? null
  const atlasEnv = envLines(info.warp_parse.env, 'ATLAS')

  if (!atlas) {
    return (
      <InfoBanner tone="warn">
        BFF 没配 <Mono>atlas.sink_url</Mono>，所以这里拿不到资产拓扑的写地址。
        在计算区的 <Mono>field-api.toml</Mono> 里补上 <Mono>[atlas]</Mono> 段的{' '}
        <Mono>sink_url</Mono>（数据面视角的 <Mono>/internal/atlas</Mono>）后重启 BFF 即可。
      </InfoBanner>
    )
  }

  return (
    <>
      <Card
        title="写端点"
        subtitle="资产快照直投的地址；两字段，没有 cmd_id"
        aside={<Badge tone="blue">POST</Badge>}
      >
        <div className="kv">
          <Field label="地址">
            <Mono>{atlas.write_url}</Mono>
          </Field>
          <Field label="认证">
            无（<Mono>auth = "none"</Mono>，内网可信）；将来换成 HTTPS 双向认证
          </Field>
          <Field label="租户">
            <Mono>{atlas.customer}</Mono>
            <span className="muted">（atlas 租户 UUID，不是客户号）</span>
          </Field>
          <Field label="两字段">
            <Mono>cust_id</Mono> / <Mono>content</Mono>
          </Field>
          <Field label="幂等键">
            快照里的 <Mono>snap_id</Mono>
            <span className="muted">（证据服务的 cmd_id 在这里不存在）</span>
          </Field>
        </div>
      </Card>

      <InfoBanner>
        <Mono>content</Mono> 就是网关 <Mono>agent-discovery.jsonl</Mono> 的一行
        （<Mono>schema</Mono> / <Mono>agent_id</Mono> / <Mono>body</Mono>…）：atlas 用与读文件路径
        <strong>同一个</strong>转换函数，不需要在这里重组。单次最多 64 条，body 上限 16 MB。
      </InfoBanner>

      <div className="stack">
        <CodeBlock
          label="topology/sinks/business.d/atlas_uplink.toml"
          hint="sink 分组：同样复用 http_sink，只覆盖 endpoint；不用再定义 connectors"
          code={httpSinkGroup({
            name: 'atlas-uplink',
            oml: 'atlas_uplink',
            bizTag: 'atlas',
            sinkName: 'atlas',
            sinkTag: 'atlas',
            endpoint: atlas.write_url,
          })}
        />
        {atlasEnv ? (
          <CodeBlock
            label="环境变量（数据面进程可见）"
            hint="只有写端点地址；auth = none 时不需要 token"
            code={atlasEnv}
          />
        ) : null}
        <CodeBlock
          label="请求体（两字段）"
          hint="content 是 DSNAP 记录或记录数组；多传的键会被忽略"
          code={JSON.stringify(atlas.record, null, 2)}
        />
      </div>

      <FailureCard dedupe="同 snap_id 的快照在库里是同一次 upsert。" />
    </>
  )
}

function MetricsPanel({ metrics }: { metrics?: IntegrationInfo['metrics'] }) {
  if (!metrics) {
    return (
      <InfoBanner>
        BFF 没拿到数据面的写入地址（<Mono>[metrics] write_url</Mono>）。
        栈模板里它是由 <Mono>METRICS_SINK_PUBLIC_HOST</Mono> + <Mono>VM_HOST_PORT</Mono> 派生的，
        不需要额外加变量；自定义配置里就自己填一条（数据面视角的 VM 地址）后重启 BFF。
      </InfoBanner>
    )
  }
  return (
    <>
      <Card
        title="上报方式"
        subtitle="不是三字段契约：现成的 vm_metrics_sink 把统计点按 VM 的 JSON line 推进去"
        aside={<Badge tone="blue">VM</Badge>}
      >
        <div className="kv">
          <Field label="写入端点（数据面视角）">
            <Mono>{metrics.write_url}{metrics.import_path}</Mono>
          </Field>
          <Field label="栈内查询入口">
            同栈 <Mono>{metrics.base_url}</Mono>
            <span className="muted">（BFF 探活与指标页用，数据面不要写这里）</span>
          </Field>
          <Field label="同一分组写两份 VM">
            把 endpoint 换成 <Mono>{metrics.env}</Mono>
            <span className="muted">（环境变量由部署注入，仅用于并行双写时切换）</span>
          </Field>
          <Field label="认证">无（内网可信）；没有 token / 证书要配</Field>
          <Field label="数据格式">VM 的 JSON line（计数点），由 sink 自己产出</Field>
          <Field label="探活">数据场「接口可用性」页的「运行指标存储」一行</Field>
        </div>
      </Card>

      <InfoBanner>
        指标与证据 / atlas 的区别：<strong>没有信封</strong>，也不需要 OML 输出契约字段。
        只要一条 <Mono>sink_group</Mono> 把 <Mono>monitor</Mono> 的统计点镜像到 VM。
      </InfoBanner>

      <div className="stack">
        <CodeBlock
          label="topology/sinks/business.d/agent_metrics.toml"
          hint="在 agent-metrics 分组里加一个 VM sink，endpoint 直接写地址"
          code={metricsSinkGroup(`${metrics.write_url}${metrics.import_path}`)}
        />
      </div>

      <Card title="失败与重试" subtitle="指标丢一两拍不影响判断，但别让它悄悄断掉">
        <ul className="bullets">
          <li>连接器重试 3 次，仍失败落 rescue 文件（可见、可人工重放）。</li>
          <li>
            端点写错时「接口可用性」页的「运行指标存储」会变成不可用 —— 先看那条探活，再查数据面。
          </li>
        </ul>
      </Card>
    </>
  )
}

export function IngestPage({
  section,
  onSection,
}: {
  section?: string
  onSection: (channel: IngestChannel) => void
}) {
  const [info, setInfo] = useState<IntegrationInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = normalizeChannel(section)

  useEffect(() => {
    let cancelled = false
    getIntegration()
      .then((value) => {
        if (!cancelled) setInfo(value)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? `${err.message}（${err.code}）` : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PageShell
      title="数据面接入"
      summary="三条通道各自独立：证据（三字段）、Atlas（资产快照，两字段）、运行指标（VM 计数）。各看各的端点与可复制配置。"
    >
      <Block wide>
        <div className="stack">
          <div className="tabs" role="tablist" aria-label="数据面通道">
            {CHANNELS.map((channel) => (
              <button
                key={channel.id}
                type="button"
                role="tab"
                aria-selected={active === channel.id}
                className={`tabs__item${active === channel.id ? ' tabs__item--active' : ''}`}
                onClick={() => onSection(channel.id)}
              >
                <span className="tabs__label">{channel.label}</span>
                <span className="tabs__hint">{channel.hint}</span>
              </button>
            ))}
          </div>

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}

          {info ? (
            <div
              className="stack"
              role="tabpanel"
              aria-label={CHANNELS.find((channel) => channel.id === active)?.label}
            >
              {active === 'evidence' ? <EvidencePanel info={info} /> : null}
              {active === 'atlas' ? <AtlasPanel info={info} /> : null}
              {active === 'metrics' ? <MetricsPanel metrics={info.metrics} /> : null}
            </div>
          ) : null}
        </div>
      </Block>
    </PageShell>
  )
}
