# insta-cli

InstaCloud CLI (`insta`) — a thin client of the [platform](../platform) control-plane API.
管理 project / branch / secrets / deploy / governance，面向开发者与 agent。

技术栈：Node 20 + TypeScript（ESM）+ commander。所有命令都是平台 API 的封装。

## 安装

**一键装（原生二进制，无需 node）** — macOS / Linux / WSL：

```bash
curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh
#   装到 ~/.insta/bin/insta（可 INSTA_INSTALL_DIR 覆盖）；校验 SHA256SUMS。
#   固定版本：curl -fsSL .../install.sh | INSTA_VERSION=v0.1.0 sh
# Windows：从 releases 页下载 insta-windows-x64.exe。
```

**从源码构建（需 node）：**

```bash
npm install
npm run build         # -> dist/index.js（bin: insta；纯 JS，运行需 node）
node dist/index.js --help
```

### 自己出二进制（Bun 交叉编译）

`install.sh` 装的二进制由 CI（tag `v*` → `.github/workflows/release.yml`）用 Bun 交叉编译并发到 GitHub
releases。本地也可出：需 [Bun](https://bun.sh)。npm 包仍发布 JS（`dist/index.js`）——二进制是另一条渠道。

```bash
npm run compile            # 只编译当前平台 -> dist/bin/insta
npm run build:binaries     # 交叉编译全平台 -> dist/bin/insta-<os>-<arch>(.exe) + SHA256SUMS
#   版本号（baked 进 `insta --version`）默认取 package.json，也可传参：bash scripts/build-binaries.sh 1.2.3
```

产物形如 `insta-darwin-arm64` / `insta-linux-x64` / `insta-windows-x64.exe`（`file` 显示 Mach-O/ELF/PE 原生可执行）。
`dist/` 已 gitignore；二进制不入库，交给 CI 发到 releases。

## Quickstart

```bash
# 指向控制面（默认 http://localhost:8080，可用 $INSTA_API_URL 或 --api-url 覆盖）
insta login --email you@example.com --password ****** --api-url http://localhost:8080
insta project create my-app          # provision DB+storage+compute，并 link 当前目录
insta secrets                        # 把当前 branch 的凭证写入 ./.env（secret seam）
insta deploy --image <registry/img>  # 部署容器镜像到当前 branch 的 compute
insta status                         # 登录态 + 已 link 的 project/branch
```

## 命令

| 命令 | 说明 |
|------|------|
| `insta login [--email --password --api-url]` | 登录（email/password；token 自动 refresh） |
| `insta login --oauth <github\|google>` | 浏览器 OAuth 登录（启本地回环端口，浏览器授权后自动带回 token） |
| `insta logout` / `insta status [--json]` | 登出 / 查看状态 |
| `insta org list [--json]` / `org create <name>` | 组织 |
| `insta project create <name> [--org]` | provision 新 project 并 link |
| `insta project list [--org] [--json]` / `link <id>` / `delete` | 项目管理 |
| `insta branch create <name> [--from]` | 新建分支环境（克隆 DB/storage/compute） |
| `insta branch list [--json]` / `switch <name>` / `delete <name>` | 分支管理 |
| `insta secrets [--branch -o --print --json]` | secret seam：凭证写入 `.env` |
| `insta secrets list [--branch]` | 仅列出 secret 名 |
| `insta deploy --image <url> [--branch --group --port]` | 部署镜像 |
| `insta manifest [--json]` | agent 可读的环境清单 |
| `insta metrics <db\|compute> [group] [--branch --from --to --step --json]` | 资源指标（compute=Fly；db 受限） |
| `insta logs <db\|compute> [group] [--branch --limit --region --instance --json]` | 运行时日志（compute=Fly；db 受限） |
| `insta events [--branch --limit --json]` | 审计 + agent 事件时间线 |
| `insta usage [--from --to --json]` | 按 meter 聚合的资源用量（含 costUsd） |
| `insta billing [--org --json]` | 当前计费周期摘要（tier / 额度 / 已用 / overage / 状态） |
| `insta billing upgrade <pro\|enterprise> [--org --no-open --json]` | Stripe Checkout 订阅付费档，返回并打开支付链接 |
| `insta billing portal [--org --no-open --json]` | 打开 Stripe Customer Portal（改套餐 / 卡 / 取消） |
| `insta approvals list [--status] [--json]` | 治理审批列表 |
| `insta approvals approve <id> [--always]` / `deny <id>` | 批准 / 拒绝（admin） |
| `insta policy get [--json]` / `policy set <action> <decision>` | 治理策略 |

被 governance gate 的操作（`secrets.read`/`deploy`/`project.delete`/`branch.delete`）命中审批时，
CLI 会提示 `approval required — run: insta approvals approve <id>`。

## 配置位置

- 全局：`~/.insta/config.json`（apiUrl + access/refresh token + user）
- 项目：`./.insta/project.json`（projectId / orgId / 当前 branch）

## 本地端到端跑通

平台提供 `dev:fake` 模式（fake provider adapters，无需 Neon/Fly/Tigris 凭证）：

```bash
# 1) 起 Postgres + 平台 dev 服务（见 ../platform）
docker run -d --name pg -e POSTGRES_PASSWORD=insta -e POSTGRES_DB=insta_dev -p 55432:5432 postgres:16-alpine
cd ../platform && DATABASE_URL='postgres://postgres:insta@localhost:55432/insta_dev' PORT=8899 npm run dev:fake

# 2) 用 CLI 跑全流程（注册走 /auth/signup + /auth/verify-email，dev 模式验证码打印在服务端日志）
INSTA_API_URL=http://localhost:8899 insta login --email you@x.com --password ...
```

## OAuth 浏览器登录

```bash
insta login --oauth github          # 或 google
# CLI 起本地回环端口 → 打开浏览器到 /auth/cli/authorize → Better Auth 走 provider 授权 →
# 平台读会话 cookie 换出 bearer token → 带回回环端口 → CLI 存为登录态
```

> 平台侧需配置该 provider 的 OAuth 应用（`GITHUB_OAUTH_CLIENT_ID/SECRET` 或 `GOOGLE_*`），
> 且应用的回调 URL 必须是 **`{INSTA_API_BASE_URL}/api/auth/callback/<provider>`**（不是回环地址）。

> `metrics` / `logs` / `usage` 已支持（usage 为采集层聚合）。`compute add-group/scale/set-domain`、镜像构建后续加入。
