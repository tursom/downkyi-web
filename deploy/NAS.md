# NAS 部署记录

- 主机：`nas`（`192.168.0.138`），架构 `x86_64`。
- 部署目录：`/opt/downkyi`。
- 访问地址：<http://nas:8511> 或 <http://192.168.0.138:8511>。
- 容器：`downkyi-downloader-1`，UID/GID 0（root），重启策略 `unless-stopped`。
- 当前认证模式：`DOWNKYI_AUTH_MODE=none`，监听 `0.0.0.0:8511`，用于可信内网。

## 部署文件

| 仓库文件 | NAS 文件 |
| --- | --- |
| `compose.yaml` | `/opt/downkyi/compose.yaml` |
| `deploy/compose.nas.yaml` | `/opt/downkyi/compose.override.yaml` |
| NAS 环境配置 | `/opt/downkyi/.env`（权限 0600） |

Compose 自动合并 `compose.yaml` 和 `compose.override.yaml`。通用配置仍只绑定两个应用目录；NAS 专用覆盖配置增加 `/export`，不影响通用部署。

| NAS 路径 | 容器路径 | 用途 |
| --- | --- | --- |
| `/opt/downkyi/docker-data` | `/data` | SQLite、设置、凭据和任务锁 |
| `/opt/downkyi/downloads` | `/downloads` | 环境初始下载目录 |
| `/export` | `/export` | NAS 目录访问 |

Web 设置中当前保存的默认下载目录为 `/export/media/video/bilibili`；该持久设置优先于 `.env` 中的初始值 `/downloads`。

两个应用目录保留原有 UID/GID 1000 和权限 0700，已有数据无需改所有者。容器通过 Compose 的 `user: "0:0"` 以 root 运行，并恢复 Docker 默认 capabilities，能够访问这些私有目录及 NAS 共享目录。`/export` 及其子目录的所有权和权限未修改。已通过 `/downloads`、`/export`、`/export/media` 的实际临时文件写入和后端目录校验。配置默认目录不会搬移旧任务文件。

## 镜像与运维

镜像由 GitHub Actions 发布，`.env` 固定已验证的镜像摘要。下面是初次部署提交 `3cc1762c789198b29967f7877e64ecfc37df33b8` 对应的配置示例；升级后的实际镜像以 NAS `/opt/downkyi/.env` 为准：

```dotenv
DOWNKYI_IMAGE=ghcr.io/tursom/downkyi-web@sha256:687329732c65ce9c0aeb1f39ed0e1a4486c0419f17f9b633077a593325464b08
DOWNKYI_AUTH_MODE=none
DOWNKYI_BIND=0.0.0.0
DOWNKYI_PORT=8511
DOWNKYI_DOWNLOAD_DIR=/downloads
DOWNKYI_SECURE_COOKIE=0
```

在 NAS 上查看和管理服务：

```sh
cd /opt/downkyi
docker compose ps
docker compose logs --tail 100 downloader
```

升级前备份数据与下载文件，将 `.env` 的 `DOWNKYI_IMAGE` 改为已验证的新版本或摘要，再运行：

```sh
docker compose pull
docker compose up -d --wait
```

备份时应先停止应用，以包含完整的 SQLite 数据和 WAL。新部署使用独立数据；原开发机的服务、数据库和下载文件未迁移或删除。

已验证 GHCR 拉取、容器健康、三个 `Type=bind` 挂载、UID 0 对应用目录和 `/export` 的读写。真实浏览器在 1440、390、320px 下通过免令牌访问和真实 B 站视频解析，无页面错误或溢出。
