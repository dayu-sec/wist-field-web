import { useEffect, useState } from 'react'
import {
  ApiError,
  contentUrl,
  getEvidence,
  getEvidenceCapabilities,
  presignEvidence,
  type EvidenceArtifact,
  type EvidenceCapabilities,
  type PresignResult,
} from '../api'
import { evidenceBodyHint, formatBytes, formatCountdown, formatDateTime } from '../format'
import { Badge, ErrorBanner, Field, InfoBanner, Mono, PageShell } from '../components/ui'
import { verdictTone } from './EvidencePage'

/** 详情页：`evidenceId` 可以是调查命令 id（`cmd_…`）或列表行里的证据 id（`art_…`）。 */
export function EvidenceDetailPage({ evidenceId, onBack }: { evidenceId: string; onBack: () => void }) {
  const [artifact, setArtifact] = useState<EvidenceArtifact | null>(null)
  const [capabilities, setCapabilities] = useState<EvidenceCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signed, setSigned] = useState<PresignResult | null>(null)
  const [proxied, setProxied] = useState(false)
  const [signError, setSignError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    setArtifact(null)
    setError(null)
    setSigned(null)
    setProxied(false)
    setSignError(null)
    getEvidence(evidenceId)
      .then((value) => {
        if (!cancelled) setArtifact(value)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? `${err.message}（${err.code}）` : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [evidenceId])

  useEffect(() => {
    if (!signed) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [signed])

  // 正文通路：证据服务自述的对象后端。取不到就按老行为（先试签名、失败再回落）。
  useEffect(() => {
    let cancelled = false
    getEvidenceCapabilities()
      .then((value) => {
        if (!cancelled) setCapabilities(value)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const openBody = async () => {
    setSignError(null)
    // `objects.kind = file`：根本没有签名 URL，直接走代理读 ——
    // 不用先发一个必然 501 的签名请求。
    if (capabilities && !capabilities.presign_supported) {
      setSigned(null)
      setProxied(true)
      window.open(contentUrl(evidenceId), '_blank', 'noopener,noreferrer')
      return
    }
    setBusy(true)
    try {
      const result = await presignEvidence(evidenceId)
      setSigned(result)
      setProxied(false)
      setNow(Date.now())
      window.open(result.url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      // 本地文件存储（objects.kind = file）不签发预签名 URL：改走 BFF 代理读。
      if (err instanceof ApiError && err.code === 'evidence_presign_unsupported') {
        setSigned(null)
        setProxied(true)
        window.open(contentUrl(evidenceId), '_blank', 'noopener,noreferrer')
        return
      }
      setSignError(err instanceof ApiError ? `${err.message}（${err.code}）` : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell
      title="证据详情"
      summary={`元数据来自索引；${evidenceBodyHint(capabilities)}`}
      actions={
        <div className="page-actions">
          <button type="button" className="button button--ghost" onClick={onBack}>
            返回列表
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void openBody()}
            disabled={!artifact || busy}
          >
            {busy ? '签发中…' : '打开正文'}
          </button>
        </div>
      }
    >
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {signError ? <ErrorBanner>{signError}</ErrorBanner> : null}

      {signed ? (
        <InfoBanner>
          已签发，{formatCountdown(signed.expires_at, now)} 内有效（单对象）。再次打开请重新点按钮。
        </InfoBanner>
      ) : null}

      {proxied && capabilities?.presign_supported !== false ? (
        <InfoBanner>
          当前部署不签发预签名 URL（证据服务 <code className="mono">objects.kind = file</code>）：
          正文改由 BFF 代理读取，浏览器仍不持任何凭据。
        </InfoBanner>
      ) : null}

      {artifact ? (
        <>
          <section className="block block--narrow">
            <div className="kv">
              <Field label="结论">
                <Badge tone={verdictTone(artifact.verdict)}>{artifact.verdict}</Badge>
              </Field>
              <Field label="类型">
                {artifact.kind}
                {artifact.subtype ? <span className="muted"> / {artifact.subtype}</span> : null}
              </Field>
              <Field label="主体">
                <Mono>{artifact.subject_id}</Mono>
                {artifact.gateway_id ? <span className="muted"> · 网关 {artifact.gateway_id}</span> : null}
              </Field>
              <Field label="命令">
                {artifact.command_id ? <Mono>{artifact.command_id}</Mono> : <span className="muted">—</span>}
              </Field>
              <Field label="契约">
                <Mono>{artifact.schema_id}</Mono>
              </Field>
              <Field label="标记">
                {artifact.marker_ids.length > 0 ? (
                  <span>
                    {artifact.marker_ids.map((marker) => (
                      <span key={marker} className="badge badge--gray">
                        {marker}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </Field>
            </div>
          </section>

          <section className="block block--narrow">
            <div className="kv">
              <Field label="产物 id">
                <Mono>{artifact.artifact_id}</Mono>
              </Field>
              <Field label="租户 / 客户">
                <Mono>{artifact.tenant_id}</Mono> <span className="muted">/</span>{' '}
                <Mono>{artifact.customer_id}</Mono>
              </Field>
              <Field label="敏感度 / 保留档">
                {artifact.sensitivity} <span className="muted">/</span> {artifact.retention_class}
              </Field>
              <Field label="观测 / 入库">
                {formatDateTime(artifact.reported_at)} <span className="muted">/</span>{' '}
                {formatDateTime(artifact.stored_at)}
              </Field>
              <Field label="保留至">
                {formatDateTime(artifact.retention_until)}
                {artifact.legal_hold ? <Badge tone="amber">legal hold</Badge> : null}
              </Field>
              <Field label="大小 / 兜底">
                {formatBytes(artifact.size_bytes)} <span className="muted">/</span> {artifact.durability}
              </Field>
              <Field label="状态">{artifact.state}</Field>
              <Field label="sha256">
                <Mono title={artifact.sha256}>{artifact.sha256.slice(0, 16)}…</Mono>
              </Field>
              <Field label="对象键">
                <Mono title={artifact.object_key}>{artifact.object_key}</Mono>
              </Field>
            </div>
          </section>

          <section className="block block--narrow">
            <InfoBanner tone="info">
              {capabilities?.objects_kind === 'file' ? (
                <>
                  正文是 zstd 压缩的 JSON，读的时候已解压。当前部署是本地文件存储（
                  <code className="mono">objects.kind = file</code>），没有签名 URL：点「打开正文」
                  由 BFF 代理读（<code className="mono">/api/evidence/{'{id}'}/content</code>），
                  浏览器不持任何凭据。
                </>
              ) : capabilities?.objects_kind === 's3' ? (
                <>
                  正文是 zstd 压缩的 JSON，读的时候已解压。当前部署是对象存储（
                  <code className="mono">objects.kind = s3</code>）：点「打开正文」签发一个 60s、
                  单对象的 URL，浏览器直连对象存储，BFF 不转存。
                </>
              ) : (
                <>
                  正文是 zstd 压缩的 JSON，读的时候已解压。通路按证据服务的存储后端自动选：
                  <code className="mono">s3</code> 是一次 60s 单对象签名，本地文件存储（
                  <code className="mono">file</code>）则由 BFF 代理读（
                  <code className="mono">/api/evidence/{'{id}'}/content</code>）。
                </>
              )}
            </InfoBanner>
          </section>
        </>
      ) : null}
    </PageShell>
  )
}
