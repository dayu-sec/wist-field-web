import { useCallback, useEffect, useState } from 'react'
import { ApiError, getEvidenceCapabilities, listEvidence, type EvidenceArtifact, type EvidenceCapabilities } from '../api'
import { evidenceBodyHint, formatBytes, formatDateTime } from '../format'
import { Badge, Block, Empty, ErrorBanner, PageShell, type BadgeTone } from '../components/ui'

const KINDS = [
  { value: '', label: '全部类型' },
  { value: 'investigation_report', label: '调查报告' },
  { value: 'diagnose_report', label: '体检报告' },
  { value: 'command_log', label: '命令日志' },
  { value: 'action_output', label: '动作输出' },
]

export function verdictTone(verdict: string): BadgeTone {
  switch (verdict) {
    case 'ok':
      return 'green'
    case 'warn':
      return 'amber'
    case 'fail':
      return 'red'
    default:
      return 'gray'
  }
}

export function EvidencePage({
  subjectId,
  kind,
  commandId,
  onOpen,
  onQuery,
}: {
  subjectId: string
  kind: string
  /** 调查命令 id（`cmd_id`）：页面上最常用的筛选，也是发起调查的人手里唯一有的。 */
  commandId: string
  onOpen: (evidenceId: string) => void
  onQuery: (query: { cmdId: string; subjectId: string; kind: string }) => void
}) {
  const [command, setCommand] = useState(commandId)
  const [subject, setSubject] = useState(subjectId)
  const [selectedKind, setSelectedKind] = useState(kind)
  const [artifacts, setArtifacts] = useState<EvidenceArtifact[] | null>(null)
  const [capabilities, setCapabilities] = useState<EvidenceCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await listEvidence({
        cmdId: commandId || undefined,
        subjectId: subjectId || undefined,
        kind: kind || undefined,
        limit: 50,
      })
      setArtifacts(page.artifacts)
    } catch (err) {
      setArtifacts(null)
      setError(err instanceof ApiError ? `${err.message}（${err.code}）` : String(err))
    } finally {
      setLoading(false)
    }
  }, [commandId, subjectId, kind])

  useEffect(() => {
    void load()
  }, [load])

  // 正文通路由证据服务自述（file / s3）—— 列表页只拿它写一句准确的说明。
  // 取不到不影响列表：文案退回到「按后端自动选」。
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

  return (
    <PageShell
      title="证据"
      summary={`按命令 id / 主机 / 类型筛；点一行看元数据。命令 id 就是发起调查时拿到的那个。${evidenceBodyHint(capabilities)}`}
      actions={
        <button type="button" className="button button--ghost" onClick={() => void load()} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
      }
    >
      <Block wide>
      <div className="stack">
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          onQuery({ cmdId: command.trim(), subjectId: subject.trim(), kind: selectedKind })
        }}
      >
        <label className="filter-field">
          <span className="field__label">调查命令 id</span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="cmd_...，留空为全部"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="filter-field">
          <span className="field__label">主机 / 主体</span>
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="agent-7f3，留空为全部"
          />
        </label>
        <label className="filter-field">
          <span className="field__label">类型</span>
          <select
            value={selectedKind}
            onChange={(event) => setSelectedKind(event.target.value)}
          >
            {KINDS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="filter-field">
          <span className="field__label">操作</span>
          <button type="submit" className="button button--primary">
            查询
          </button>
        </div>
      </form>

      {error ? (
        <ErrorBanner>
          {error}
          <span className="muted">
            {' '}
            —— 确认 <code className="mono">wist-field-api</code>（BFF）已启动，且能连到证据服务。
          </span>
        </ErrorBanner>
      ) : null}

      {artifacts === null && !error ? (
        <Empty title="还没有数据" hint="证据服务接上后，这里按时间倒序列出可读的产物。" />
      ) : null}

      {artifacts && artifacts.length === 0 ? (
        <Empty title="没有匹配的证据" hint="换个命令 id / 主机或类型再试；也可能是保留期已过（被清理作业删除）。" />
      ) : null}

      {artifacts && artifacts.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>观测时间</th>
                <th>类型</th>
                <th>命令 id</th>
                <th>主体</th>
                <th>结论</th>
                <th>敏感度</th>
                <th>大小</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {artifacts.map((artifact) => (
                <tr key={artifact.artifact_id}>
                  <td>{formatDateTime(artifact.reported_at)}</td>
                  <td>
                    {artifact.kind}
                    {artifact.subtype ? <span className="muted"> / {artifact.subtype}</span> : null}
                  </td>
                  <td>
                    {artifact.command_id ? (
                      <code className="mono">{artifact.command_id}</code>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <code className="mono">{artifact.subject_id}</code>
                  </td>
                  <td>
                    <Badge tone={verdictTone(artifact.verdict)}>{artifact.verdict}</Badge>
                  </td>
                  <td>{artifact.sensitivity}</td>
                  <td>{formatBytes(artifact.size_bytes)}</td>
                  <td>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => onOpen(artifact.artifact_id)}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      </div>
      </Block>
    </PageShell>
  )
}
