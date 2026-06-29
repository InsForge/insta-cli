# insta-cli

InstaCloud CLI (`insta`) — a thin client of the [platform](../platform) control-plane API.
管理 project / branch / secrets / deploy / governance，面向开发者与 agent。

技术栈：Node 20 + TypeScript（ESM）+ commander。所有命令都是平台 API 的封装。

## 安装 / 构建

```bash
npm install
npm run build         # -> dist/index.js（bin: insta）
node dist/index.js --help
```

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
| `insta events [--branch --limit --json]` | 审计 + agent 事件时间线 |
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

> v1 覆盖平台已实现的能力。`metrics` / `logs`（observability）与 `usage`（billing）待平台 #4/#5
> 完成后补充；OAuth 浏览器登录、`compute add-group/scale/set-domain`、镜像构建后续加入。
