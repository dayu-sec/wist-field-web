// BFF（`wist-field-api`）的客户端。
//
// 浏览器**只跟 BFF 说话**：证据的 mTLS、租户/敏感度闸、预签名代签都在 BFF 里完成；
// 这个文件不持有任何**服务**凭据（证据服务的证书、COS 的密钥都不在这里）。
// 唯一的凭据是操作员自己的访问令牌（`wcr_…`），由 `auth.ts` 管，进 `Authorization` 头。

import { getToken, notifyUnauthorized } from './auth'

/** 每个数据源的可用状态。`not_configured` 不是错误 —— 是「这个域还没接」。 */
export type SourceStateName = 'ok' | 'unavailable' | 'not_configured'

export interface SourceState {
  status: SourceStateName
  detail?: string
}

export interface ConsoleHealth {
  status: string
  version?: string
  sources: Record<string, SourceState>
  /** 逐条接口探活：BFF 自己看到的那一面。 */
  interfaces?: InterfaceState[]
}

/**
 * 单条接口的可用性。`not_configured` 表示这个地址还没配（不是故障）；
 * `not_configured` 时没有 `url` / 延迟 / 检查时间。
 */
export interface InterfaceState {
  id: string
  label: string
  url?: string
  status: SourceStateName
  detail?: string
  /** 这一次探活到底验到了哪一层（BFF 侧写的，不是前端猜的）。 */
  covers?: string
  latency_ms?: number
  checked_at_ms?: number
}

/** 与 `wist-evidence` 的索引行一致（见 evidence-service.md §5.1）。 */
export interface EvidenceArtifact {
  artifact_id: string
  tenant_id: string
  customer_id: string
  kind: string
  subtype: string | null
  subject_type: string
  subject_id: string
  gateway_id: string | null
  agent_id: string | null
  command_id: string | null
  dedupe_key: string
  schema_id: string
  sensitivity: string
  retention_class: string
  bucket: string
  object_key: string
  size_bytes: number
  sha256: string
  verdict: string
  marker_ids: string[]
  source_ref: string | null
  source_sha256: string | null
  durability: string
  reported_at: string
  stored_at: string
  retention_until: string
  legal_hold: boolean
  state: string
}

export interface EvidenceListPage {
  artifacts: EvidenceArtifact[]
  next_cursor: string | null
}

export interface PresignResult {
  artifact_id: string
  url: string
  expires_in_seconds: number
  expires_at: string
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      credentials: 'same-origin',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError(0, 'network_error', `无法连接计算区 BFF：${message}`)
  }

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string } } | null
    const code = envelope?.error?.code ?? String(response.status)
    if (response.status === 401) {
      // token 没了 / 过期 / 被撤销：清掉本地副本并让 App 弹出输入框。
      notifyUnauthorized()
    }
    throw new ApiError(
      response.status,
      code,
      envelope?.error?.message ?? response.statusText,
    )
  }

  return payload as T
}

export function getHealth(): Promise<ConsoleHealth> {
  return request<ConsoleHealth>('/api/health')
}

/** 登录的结果：把令牌换成「你是谁 + 给了什么角色」。 */
export interface LoginResult {
  credential_id: string
  subject: string
  roles: string[]
  audience: string
  /** Unix 秒。 */
  expires_at: number
}

/**
 * 校验访问令牌（`POST /api/login`，契约由 `wist-cred-peer` 统一）。
 *
 * 以前前端是“拿 `/api/health` 试一下”来验证令牌 —— 那只能知道能不能进，
 * 不知道进来的是谁；失败时也只能按状态码猜原因。
 */
export function login(token: string): Promise<LoginResult> {
  return request<LoginResult>('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

/**
 * 确认这把令牌能进本服务；能拿到身份就返回身份，拿不到就返回 `null`。
 *
 * **为什么要回退**：`/api/login` 是 BFF 0.3 起的端点。
 * - 部署里 web 先升、BFF 还是 0.2.x → 404；
 * - `auth.mode = ingress` 时 BFF 根本没有令牌这回事 → 也没有这个端点。
 * 不回退的话，一次前端更新就会把所有这类部署挡在令牌输入框外面，
 * 而它们本来只需要“发个真请求试试”（旧行为）。
 */
export async function authenticate(token: string): Promise<LoginResult | null> {
  try {
    return await login(token)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      await getHealth()
      return null
    }
    throw err
  }
}

export interface EvidenceCapabilities {
  /** 证据服务的对象后端：`file` / `s3`；老服务不报 `objects` 时为 null。 */
  objects_kind: string | null
  /** 后端是否签发单对象 URL；`file` 为 false（正文只能走 BFF 代理读）。 */
  presign_supported: boolean
}

/**
 * 证据页的正文通路：让后端自己说清楚怎么读，页面不再先发一个必然 501 的签名请求。
 * 探测失败 / 老证据服务不报 `objects` 时 `objects_kind` 为 null，
 * 页面退回到「先试签名、失败再回落」的老行为。
 */
export function getEvidenceCapabilities(): Promise<EvidenceCapabilities> {
  return request<EvidenceCapabilities>('/api/evidence/capabilities')
}

export interface EvidenceQuery {
  /** 调查命令 id：发起调查的人手里只有这个，也是页面上的主筛选位。 */
  cmdId?: string
  subjectId?: string
  kind?: string
  since?: string
  limit?: number
  cursor?: string
}

export function listEvidence(query: EvidenceQuery = {}): Promise<EvidenceListPage> {
  const params = new URLSearchParams()
  if (query.cmdId) params.set('cmd_id', query.cmdId)
  if (query.subjectId) params.set('subject_id', query.subjectId)
  if (query.kind) params.set('kind', query.kind)
  if (query.since) params.set('since', query.since)
  if (query.limit) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  return request<EvidenceListPage>(`/api/evidence${suffix}`)
}

/**
 * 按 id 读一条证据的索引行。
 *
 * `id` 可以是**调查命令 id**（`cmd_id`，发起调查的人手里只有这个），
 * 也可以是列表行里的 `artifact_id`（`art_…`）：证据服务先按后者、再按前者找，
 * 两者指向同一行（定位规则不在前端）。
 */
export function getEvidence(id: string): Promise<EvidenceArtifact> {
  return request<EvidenceArtifact>(`/api/evidence/${encodeURIComponent(id)}`)
}

/** 让 BFF 向证据服务要一个 60s、单对象的 URL（`id` 同上：cmd_id 或 artifact_id）。 */
export function presignEvidence(id: string): Promise<PresignResult> {
  return request<PresignResult>(
    `/api/evidence/${encodeURIComponent(id)}:presign`,
    { method: 'POST' },
  )
}

/**
 * 代理读正文：本地文件存储（`objects.kind = file`）没有预签名 URL，
 * 页面直接开这个地址，由 BFF 带身份去证据服务取原文（`id` 同上）。
 */
export function contentUrl(id: string): string {
  return `/api/evidence/${encodeURIComponent(id)}/content`
}

export interface IntegrationInfo {
  evidence: {
    write_url: string
    /** `none`：现在不校验（内网可信）；将来换成 HTTPS 双向认证。 */
    auth: string
    /** 客户 id —— 租户与客户已经合并成一个维度。 */
    customer: string
    allowed_kinds: string[]
    /** 三字段示例：`cust_id` / `cmd_id` / `content`。 */
    record: Record<string, unknown>
  }
  /**
   * 资产拓扑写端点（两字段：`cust_id` / `content`）。
   * BFF 没配 `atlas.sink_url` 时为 `null` —— 那是「没接入」，不是错误。
   */
  atlas?: {
    write_url: string
    auth: string
    /** atlas 的租户 UUID（不是客户号）：一个 wparse 可以写多个租户。 */
    customer: string
    record: Record<string, unknown>
  } | null
  /**
   * 运行指标写端点（**数据面视角**）。
   * BFF 没配 `[metrics] write_url` 时为 `null` —— 不编造占位地址。
   */
  metrics?: {
    write_url: string
    /** VM 的 JSON line 导入路径（`/api/v1/import`）。 */
    import_path: string
    /** 数据面读地址用的环境变量名（`CONSOLE_VM_ENDPOINT`）。 */
    env: string
    /** BFF 视角的查询入口（栈内），仅用于说明探活归属。 */
    base_url: string
  } | null
  warp_parse: {
    /** 数据面进程要看到的环境变量（写端点地址）。 */
    env: Record<string, string>
    /**
     * 旧的连接器 / sink 分组样板。BFF 不再下发它们（接入页统一复用现有的
     * `http_sink`，不再新建 connectors）；可选只是为了容下老 BFF 的响应。
     */
    connector?: string
    sink_group?: string
  }
}

export function getIntegration(): Promise<IntegrationInfo> {
  return request<IntegrationInfo>('/api/integration')
}

/**
 * 运行指标：**读的是计算区自己那份 VictoriaMetrics**。
 *
 * 数据面（wparse）把 agent 采集指标镜像进来（网关栈的 `CONSOLE_VM_ENDPOINT`）；
 * 网关栈那份 VM 只服务控制面观测页，两份存储互不聚合 —— 所以这里没有引擎/管道统计
 * （`wparse_*` 只写网关栈）。单位由 BFF 换算好（百分比 / 毫秒 / 字节），页面不做算术。
 */
/** 主机侧（`system_*` / `process_*`）：宿主资源，不是 agent 进程自己的。 */
export interface MetricsHost {
  hostname: string | null
  ip_addresses: string[]
  os: string | null
  arch: string | null
  kernel: string | null
  load_1m: number | null
  load_5m: number | null
  load_15m: number | null
  memory_total_bytes: number | null
  memory_available_bytes: number | null
  /** 百分比。 */
  memory_usage_percent: number | null
  /** 系统盘（`disk_role=system`）使用率，百分比。 */
  disk_usage_percent: number | null
  disk_total_bytes: number | null
  disk_available_bytes: number | null
  /** 最紧张的挂载点（可能不是系统盘根分区），百分比。 */
  filesystem_usage_percent: number | null
  filesystem_mount: string | null
  uptime_seconds: number | null
  /** 采集到的进程数。 */
  processes: number | null
}

export interface MetricsAgent {
  agent_id: string
  /** 选择类 label（`env` / `cluster` / …），由网关下发、贴在每条序列上。 */
  labels: Record<string, string>
  /** 这台 agent 在存储里的序列总数（含 `system_*` / `process_*`）。 */
  series: number
  /** 观察窗口内 `agent_cpu_ratio` 的样本数：`0` = 采集静默。 */
  samples: number
  cpu_percent: number | null
  cpu_cores: number | null
  memory_bytes: number | null
  admin_latency_ms: number | null
  /** 采集记账：按 `target_kind` × `outcome` 报的目标数（这里按 outcome 汇总）。 */
  collect_targets: number | null
  collect_dropped: number | null
  uplink_failed_total: number | null
  discovery_policy_version: number | null
  /** 主机侧资源；老 agentd 只报自观测时为空值。 */
  host: MetricsHost
}

export interface MetricsCatalogEntry {
  name: string
  /** 名字前缀（`agent` / `system` / `process` / …）。 */
  group: string
  series: number
}

/**
 * 业务层：一个「命名的逻辑单元」（归属记账，来自 `field-api.toml` 的 `[[business.units]]`）。
 *
 * 与 `app` label 不是一回事：`app` 表达用途，业务单元表达归属，一个业务可以跨多台主机。
 * 聚合口径由 BFF 给出：内存 / 进程 / 采集数求和，负载 / 磁盘取峰值。
 */
export interface MetricsBusiness {
  id: string
  name: string
  /** 配置里声明的归属主机（按配置顺序）。 */
  agents: string[]
  /** 存储里有序列的台数。 */
  agents_present: number
  /** 观察窗口内还在报的台数。 */
  agents_reporting: number
  /** 配置里有、存储里没有：离线 / 从没接入 / id 写错。 */
  agents_missing: string[]
  series: number
  processes: number | null
  cpu_cores: number | null
  load_1m_max: number | null
  memory_used_bytes: number | null
  memory_total_bytes: number | null
  disk_usage_max: number | null
  filesystem_usage_max: number | null
  collect_targets: number | null
  collect_dropped: number | null
}

export interface MetricsOverview {
  generated_at_ms: number
  /** 样本数 / 静默判定的观察窗口（秒）。 */
  window_seconds: number
  source: { base_url: string }
  totals: { names: number; series: number; agents: number }
  /** 业务层（按配置的顺序）。空数组 = 这个计算区还没做归属记账。 */
  business: MetricsBusiness[]
  /** 不在任何业务里的主机：单列出来，不默默漏掉。 */
  unassigned_agents: string[]
  agents: MetricsAgent[]
  catalog: MetricsCatalogEntry[]
}

export interface MetricsHistorySeries {
  /** 规范指标名（`agent_cpu_ratio` …），只用于排查。 */
  metric: string
  /** 页面标题：BFF 按 `wist-metrics` 常量表给出，前端不认名字。 */
  title: string
  unit: 'percent' | 'bytes' | 'count' | 'milliseconds'
  /** `[unix 毫秒, 值]`，按时间升序。 */
  points: [number, number][]
}

export interface MetricsAgentHistory {
  agent_id: string
  window_seconds: number
  step_seconds: number
  labels: Record<string, string>
  series: MetricsHistorySeries[]
}

/**
 * 资产拓扑（`wist-atlas`）自己输出的 OpenAPI 文档。
 *
 * 只取页面要用的子集：路径 / 参数 / 响应 / 被引用的 schema。
 * 经 BFF 拉取（`/api/atlas/openapi.json` → atlas `/api/openapi.json`），
 * 因此令牌校验只看一道门，浏览器不直连 atlas。
 */
export interface OpenApiSchema {
  $ref?: string
  type?: string | string[]
  format?: string
  nullable?: boolean
  enum?: unknown[]
  items?: OpenApiSchema
  properties?: Record<string, OpenApiSchema>
  required?: string[]
  oneOf?: OpenApiSchema[]
  anyOf?: OpenApiSchema[]
}

export interface OpenApiParameter {
  name: string
  in: string
  required?: boolean
  description?: string
  schema?: OpenApiSchema
}

export interface OpenApiResponse {
  description?: string
  content?: Record<string, { schema?: OpenApiSchema }>
}

export interface OpenApiSecurityScheme {
  type?: string
  scheme?: string
  bearerFormat?: string
  in?: string
  name?: string
}

export interface OpenApiOperation {
  summary?: string
  description?: string
  tags?: string[]
  parameters?: OpenApiParameter[]
  responses?: Record<string, OpenApiResponse>
  /** 操作级鉴权（不写就继承文档级 `security`）。 */
  security?: Record<string, string[]>[]
}

export interface OpenApiDocument {
  openapi: string
  info: { title: string; version: string; description?: string }
  /** `{ [path]: { get: OpenApiOperation, … } }` */
  paths: Record<string, Record<string, OpenApiOperation>>
  /** 文档级鉴权：`[{ bearer: [] }]` 表示“所有操作都要这个方案”。 */
  security?: Record<string, string[]>[]
  components?: {
    schemas?: Record<string, OpenApiSchema>
    securitySchemes?: Record<string, OpenApiSecurityScheme>
  }
}

export function getAtlasOpenApi(): Promise<OpenApiDocument> {
  return request<OpenApiDocument>('/api/atlas/openapi.json')
}

/**
 * 证据读取接口的清单（BFF 自己输出的 OpenAPI 3.1）。
 *
 * 与 atlas 那份同一个用法：页面不维护第二份清单。区别在归属 —— atlas 的 spec 由 atlas 出；
 * 浏览器能调的证据读接口就是 BFF 的 `/api/evidence*`（证据服务的 `/internal/*` 浏览器到不了），
 * 所以这份由 BFF 出。
 */
export function getEvidenceOpenApi(): Promise<OpenApiDocument> {
  return request<OpenApiDocument>('/api/evidence/openapi.json')
}

export function getMetrics(): Promise<MetricsOverview> {
  return request<MetricsOverview>('/api/metrics')
}

export function getMetricsHistory(
  agentId: string,
  windowSeconds: number,
): Promise<MetricsAgentHistory> {
  const params = new URLSearchParams({ window_seconds: String(windowSeconds) })
  return request<MetricsAgentHistory>(
    `/api/metrics/agents/${encodeURIComponent(agentId)}/history?${params.toString()}`,
  )
}
