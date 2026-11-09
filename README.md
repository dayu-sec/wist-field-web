# wist-field-web（数据场 · 现场视图）

计算区**只读**界面：**证据 / 资产拓扑 / 运行指标 / 接口可用性 / 安全设备** 一个入口。

> 展示名「**数据场 · 现场视图**」：现场由三类信号构成 —— 发生过什么（证据）、由什么构成（资产）、
> 现在跑得怎样（指标）。场是由采样重建的，所以“静默”与“少了几条序列”是同一件事：场缺一块。
> 只读，不动手（不重启、不发布、不处置）。
> 技术名 `wist-field-web`（仓名 / 镜像名 / 服务名同步改）。

- 后端：`wist-field-api`（BFF），浏览器只跟它说话
- 部署：`wist-field-stack`（计算区，经 VPN / 堡垒机进入）
- 设计：`wist-design/doc/design/console/console-architecture.md`

## 为什么不在接入区

证据正文只在计算区与 COS 之间流动。把浏览界面放在接入区（`wist-center-web` 所在处）等于
让正文和预签名 URL 穿过 DMZ，也违背「center 零 COS 凭据、接入区被攻破拿不到正文」的初衷。
所以本台与 `wist-evidence`、`wist-atlas` 同区（计算区）。

## 页面

| 页面 | 状态 | 数据源 |
|---|---|---|
| 概览 | 可用 | `GET /api/health`（各数据源就绪度 + 接口可用性摘要） |
| 证据 | 可用 | `GET /api/evidence?cmd_id=`（主筛选位）、`GET /api/evidence/{cmd_id}`（`cmd_id` 或 `art_…`）、`GET /api/evidence/capabilities`（选正文通路）、`POST /api/evidence/{cmd_id}:presign`；列表显示命令 id |
| 资产拓扑 | 可用 | `GET /api/atlas/*`（wist-atlas 只读 API，经 BFF 转；画布来自 `@dayu-sec/wist-atlas-graph`） |
| 运行指标 | 占位 | 平台侧尚无聚合（现网的 VM 在各网关栈里） |
| 接口可用性 | 可用 | 三个 tab：探活结果（`GET /api/health.interfaces[]` + 本次会话可用率）/ 证据读取 API（`GET /api/evidence/openapi.json`）/ 资产拓扑 API（`GET /api/atlas/openapi.json`）。tab 走路由：`#/health`、`#/health/evidence`、`#/health/atlas` |
| 安全设备 | 占位 | `containment_capabilities` 尚未上报 |

**占位页不是"待美化"，是"没数据源"**：缺什么、按什么顺序接，页面上都写出来了。

## 与 BFF 的契约

```text
GET  /api/health
     → { status, version?, sources: { evidence|atlas|metrics|devices: { status, detail? } },
         interfaces: [{ id, label, covers, url?, status, detail?, latency_ms?, checked_at_ms? }] }

GET  /api/evidence?subject_id=&kind=&since=&limit=&cursor=
     → { artifacts: [EvidenceArtifact], next_cursor }

GET  /api/evidence/{cmd_id}
     → EvidenceArtifact
       path 里的 id 优先是**调查命令 id**；列表行里的 `artifact_id` 也接受（服务端自己定位）。

GET  /api/evidence/capabilities
     → { objects_kind: "file"|"s3"|null, presign_supported: bool }

GET  /api/evidence/openapi.json
     → OpenAPI 3.1：浏览器能调的证据读接口（路径 / 参数 / 响应）
       「接口可用性」页拿它渲染「证据读取 API」tab；页面不维护第二份清单。

POST /api/evidence/{cmd_id}:presign
     → { artifact_id, url, expires_in_seconds, expires_at }
```

- 浏览器**不持有**任何凭据；BFF 负责到证据服务的 mTLS 与 scope；
- 正文通路看 `capabilities.presign_supported`：`false`（`objects.kind = file`）直接走
  `GET /api/evidence/{id}/content` 由 BFF 代理读，不用先撞一次 501；
  后端不报 `objects`（老实例）时保留「先试签名、失败再回落」；
- 预签名 60s、单对象，BFF 不缓存 URL；
- 租户与敏感度由证据服务裁决，BFF 只透传 `404`（不区分「不存在」和「无权看」）。

`EvidenceArtifact` 的字段与 `wist-evidence` 索引行一致（见
`design/center/evidence-service.md` §5.1）。

## 资产拓扑（组件化，不是 iframe）

画布、工具条、详情抽屉来自共享包
[`@dayu-sec/wist-atlas-graph`](https://github.com/dayu-sec/wist-atlas-graph)（`./ui` 子入口 + 自带样式）：

- 数据和 `wist-atlas` 独立部署时完全一样，只是**走 BFF 的 `/api/atlas/*`**（令牌校验只有一道门）；
- 前缀与令牌由本页注入（`createAtlasClient({ baseUrl, headers })`），浏览器不直连 atlas；
- 主题用数据场自己的 `useAppTheme()`，画布跟随深浅色，没有第二套顶栏/路由；
- 画布代码按需加载（`React.lazy`），首屏不带 cytoscape。

早先的 `/atlas/` 静态托管 + iframe 方案已经删除（含 nginx 的 `location /atlas/` 与
`location /atlas/api/`）。`wist-atlas-web` 仍可独立部署，但它不再是本站的运行时依赖。

## 开发

```bash
npm ci
npm run dev        # http://127.0.0.1:5175
```

本机另起 BFF 时用环境变量覆盖代理目标：

```bash
VITE_CONSOLE_API_TARGET=http://127.0.0.1:19201 npm run dev
```

## 构建与镜像

```bash
npm run build      # tsc --noEmit + vite build
docker build -t wist-field-web:dev .
```

镜像契约与同级前端一致：`ARG APP_VERSION` → `VITE_APP_VERSION`（页面左下角版本号）。
发版 `v*.*.*` 由 `.github/workflows/release.yml` 推 ghcr + TCR。
