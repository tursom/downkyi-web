# DownKyi Web

面向 Linux 无头服务器的哔哩哔哩下载器。浏览器负责操作，服务器负责解析、下载、合并和保存文件；关闭网页不会停止任务。

采用已确认的 B 版布局：顶部导航、紧凑任务表格，以及「解析内容 → 选择项目与规格 → 确认入队」三步流程。参考 [DownKyiCore](https://github.com/crazysmile-PhD/downkyicore) 的工作流，独立实现 Web 服务，不是其官方版本，也没有移植 Avalonia 桌面层。

## 功能

- BV / AV 号、视频链接、分 P、b23.tv 短链、番剧 EP / SS、合集和收藏夹链接解析。具体可用性取决于上游接口、网络、地区和当前账户权限。
- 从真实解析结果选择画质、视频编码、仅音频模式、封面和可用字幕；不会假定登录即拥有某种画质或付费内容权限。
- SQLite 持久化队列，并发 1–4；暂停、继续、重新解析重试、服务重启恢复未完成任务。
- 下载与合并校验分开显示；FFmpeg/ffprobe 验证通过后才公布输出文件。
- 下载记录与输出文件分开管理。移除记录会停止任务但保留文件；删除文件是独立操作，不会删除整个下载根目录。
- 服务器访问口令和 HttpOnly 会话；B 站扫码登录或 Netscape Cookie 导入，登录凭据不回显到浏览器。
- Cookie 私有存储、每次操作独立快照、扫码确认后验证账户状态、限定可访问的来源和文件路径。

当前不包含 DownKyi 桌面端的全部功能：弹幕 ASS、课程、历史记录、稍后再看、直播录制、转码工具箱和跨用户隔离不在本版范围内。

## Docker 部署

只使用宿主机目录绑定（bind mount），不创建 Docker 命名卷或匿名卷。首次部署先准备本地目录，并确认宿主机 `/export` 已挂载：

```sh
sudo mkdir -p ./docker-data ./downloads
sudo chown 1000:1000 ./docker-data ./downloads
sudo chmod 700 ./docker-data ./downloads
docker compose up -d --build
# 令牌模式且未指定 DOWNKYI_ADMIN_TOKEN 时，首次启动会自动生成访问口令：
docker compose exec downloader cat /data/admin-token
```

默认访问 `http://127.0.0.1:8511`。在登录页输入上述口令，免令牌模式则直接进入。挂载关系如下（相对路径以 Compose 文件所在目录为准）：

| 宿主机目录 | 容器目录 | 用途 |
| --- | --- | --- |
| `./docker-data` | `/data` | SQLite、配置、登录凭据和任务锁 |
| `./downloads` | `/downloads` | 默认下载文件与续传文件 |
| `/export` | `/export` | 原路径访问 NAS/外部存储 |

文件直接保存在宿主机，重建容器不会清空。三个绑定都禁止 Docker 自动创建缺失的源目录，避免误写位置或生成错误权限的目录。已有本地镜像时，可运行 `node scripts/check-bind-mounts.mjs` 验证实际挂载和 UID 1000 权限；镜像名默认 `downkyi-web:local`，可用 `DOWNKYI_CHECK_IMAGE` 指定。

可创建 `.env`，参照 `.env.example`：

- `DOWNKYI_AUTH_MODE=token`：默认启用令牌保护。设为 `none` 可免登录访问，见下文的内网模式。
- `DOWNKYI_ADMIN_TOKEN`：令牌模式下至少 16 字符，建议 `openssl rand -hex 32` 生成。不设置则自动生成并持久保存。
- `DOWNKYI_BIND=0.0.0.0`：允许局域网访问。不要把 HTTP 服务直接暴露到公网。
- `DOWNKYI_PORT=8511`：宿主机端口。
- `DOWNKYI_DOWNLOAD_DIR=/downloads`：未保存 Web 设置时使用的初始默认目录。可以在「偏好设置 → 下载设置」修改并持久保存，保存后以 Web 设置为准。写入 NAS 时使用 `/export` 下已存在且 UID 1000 有写权限的专用子目录，例如 `/export/media/downkyi`；先由 NAS 管理员准备目录。
- `DOWNKYI_SECURE_COOKIE=1`：经过 HTTPS 反向代理时启用，普通 HTTP 下不要设置为 1。

通过 HTTPS 访问时参考 `deploy/nginx.conf`，替换域名和证书，并保留原始 Host。二维码轮询和解析走同源 API，解析反代超时应大于 180 秒。默认不信任代理提供的客户端 IP，因此经代理的登录限速按代理地址共享。

容器以 UID/GID 1000 的非 root 用户运行；只给应用专用目录授权，不要递归修改整个 `/export` 的所有权或权限。绑定的 `/export` 内其他目录也会在容器中可见，实际读写权限由宿主机及 NAS 决定。当前环境的 `/export` 是 NFS 导出，导出根目录拒绝创建文件；即使绑定声明可读写，也不会绕过 NAS 的只读导出或权限限制。SQLite 和任务锁必须保留在本地 `./docker-data`，不要将 `/data` 放到 NFS 上。

本机运行的 `./data` 和旧 Docker 卷不会自动迁移或删除。下载记录保存每个任务原来的绝对路径；跨宿主机/容器迁移时，必须让原路径仍可访问，或单独进行离线路径迁移。仅复制媒体并修改默认目录不会重定位旧任务。迁移前停止原应用、备份完整数据与下载文件，检查目标 UID 1000 权限；不要同时运行两个实例写入同一份数据。若原服务仍占用 8511，先停止原服务或为容器选择其他 `DOWNKYI_PORT`。

## 本机运行

需要 Python 3.11+、Node.js 22+、FFmpeg 和 ffprobe。已在 Python 3.14 环境开发；Docker 使用 Python 3.12。

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock
cd frontend
npm ci
npm run build
cd ..
.venv/bin/python -m backend
```

默认监听 `127.0.0.1:8511`。默认数据目录 `./data`，下载目录 `./data/downloads`，自动生成的访问口令位于 `./data/admin-token`。`.env` 仅由 Docker Compose 自动读取；本机运行时请显式设置环境变量或使用 systemd 的 EnvironmentFile。

```sh
DOWNKYI_HOST=0.0.0.0 \
DOWNKYI_DATA_DIR=/var/lib/downkyi-web \
DOWNKYI_DOWNLOAD_DIR=/srv/downkyi-downloads \
.venv/bin/python -m backend
```

`deploy/downkyi-web.service` 是 systemd 模板。先创建独立系统用户、安装目录、数据目录和下载目录，调整路径后再安装。不要以 root 运行公开服务。

必须使用 **一个应用进程/一个 Uvicorn worker**。进程内部已管理并发下载，同一个数据目录会使用文件锁阻止第二个服务实例。

## 配置下载目录

在「偏好设置 → 下载设置」填写下载目录并保存，无需重启。路径必须是服务进程可见的、已存在且实际可写的绝对目录。Docker 部署使用容器内路径，例如 `/downloads` 或已挂载的 `/export/media/downkyi`，不是浏览器所在电脑的路径。

- 保存前会执行临时文件写入检查。不存在、只读、权限不足、符号链接、系统/私有数据目录或已有任务目录会被拒绝，不会自动创建目录或修改权限。
- 设置保存在 SQLite 中，重启后保留；环境变量只在尚未保存目录设置时提供初始默认值。
- **只影响保存后创建的新任务**。已有任务（包括等待中和已暂停任务）固定使用创建时的目录，继续下载、取回文件和删除文件都不受默认目录切换影响。
- 本功能不搬移已有文件。旧版本任务首次升级时会补记原目录；升级时应保留原有 `DOWNKYI_DOWNLOAD_DIR`，避免把未知旧路径误认成新路径。
- NAS 目录在之后断开或失去权限时，任务会失败并保留原路径，不会回退到其他磁盘；恢复挂载后可重试。设置页仍可修改新任务的默认目录。

## 内网免令牌模式

设置 `DOWNKYI_AUTH_MODE=none` 并重启服务，即可直接打开工作台。该模式不生成或校验访问令牌，不要求会话 Cookie，界面隐藏退出登录按钮并显示「免令牌」。B 站扫码登录和会员内容权限与此开关无关。

本机运行：

```sh
DOWNKYI_AUTH_MODE=none DOWNKYI_HOST=0.0.0.0 .venv/bin/python -m backend
```

Docker Compose 可在 `.env` 中设置后重建启动：

```dotenv
DOWNKYI_AUTH_MODE=none
DOWNKYI_BIND=0.0.0.0
```

```sh
docker compose up -d --build
```

systemd 部署可在 `/etc/downkyi-web.env` 中设置 `DOWNKYI_AUTH_MODE=none`，再重启应用服务。

**所有能连到服务的客户端都能下载、删除文件、修改设置和管理 B 站登录凭据，不只是免登录查看。** 本模式不会自动识别内外网，必须使用防火墙、可信局域网或 VPN 限制可达范围；不要暴露到公网。跨站修改请求、请求体大小及文件路径检查仍然生效，但它们不能替代访问认证。

恢复保护时改为 `DOWNKYI_AUTH_MODE=token` 并重启。既有令牌文件、B 站凭据和下载任务不会因切换模式被删除；首次启用令牌模式且没有令牌文件时才自动生成。无效模式值会拒绝启动，不能通过 Web API 切换认证模式。

## 使用流程

1. 默认使用服务器访问口令进入工作空间，免令牌模式则直接进入。该凭据与 B 站账户无关。
2. 可在偏好设置中扫码登录，或导入仅含 B 站域名的 Netscape Cookie。扫码图片由服务器生成，不需要服务器安装桌面或浏览器。导入前会验证登录状态，无效凭据不会覆盖原凭据。
3. 点击新建下载，粘贴链接解析。单次最多解析 100 项；超出会显示截断提示。解析结果保存一小时，过期需重做；网络解析最长 180 秒。
4. 选择项目、画质、编码和附件，检查确认页后加入队列。每批最多 50 个任务，未完成队列最多 500 个。
5. 在任务表格里暂停/继续/重试。暂停保留 `.part` 等续传文件；如果上游支持恢复，重试会利用保留的数据。
6. 在文件库中查看服务器真实文件并下载到当前电脑。下载目录按任务 ID 隔离，内部使用稳定的 `media.ext` 文件名保证重试续传；网页显示对应的视频标题，避免不同任务覆盖。

移除未完成任务的记录同样保留临时文件，但不会把未校验的部分文件当作已完成视频供下载。它们会在媒体库的「待清理」筛选中保留入口，可以独立确认删除以释放空间。

## 安全与运行限制

- 默认令牌模式下，所有业务 API、下载文件和 B 站登录操作都需要工作空间会话；Cookie 不会存入前端 localStorage。
- 令牌模式的会话在服务重启后失效，需要重新输入访问口令；B 站凭据和下载任务仍持久保留。
- 登录失败每个来源地址一分钟最多 5 次；JSON 请求体有大小限制，拒绝跨站修改请求。
- 只支持受限的哔哩哔哩入口，不是任意 URL 下载代理；不接受客户端直接指定媒体地址、输出目录或 shell 参数。
- 下载服务按单用户设计，拥有口令者可以管理全部任务、文件和 B 站凭据。需要多用户隔离时应部署独立实例和独立数据卷。
- 每个任务使用独立文件锁，锁由下载进程及其 FFmpeg 子进程共同持有。旧进程仍占用资源时，重启续传和删除文件都会拒绝执行。
- 移除文件不会绕过重复任务检测；需要重新添加已完成的内容时，请先处理旧文件并移除旧记录。
- 不支持交互视频的独立分支和旧式多段 FLV 条目，这些条目会明确标记为不可用。
- 不绕过付费、会员、地区或其他访问限制。仅下载有权保存的内容，并遵守平台条款和内容版权。
- 风控（例如 412）、账户过期、地区限制及 CDN 网络错误可能导致解析/下载失败；错误不会伪装成完成。先验证账户和网络，再重试。
- 默认直接访问上游，不继承系统代理。要在特殊网络中部署，需保证服务器可直接访问 B 站 API、登录服务和媒体 CDN。
- 进度来自下载引擎，分离音视频、多分片任务的估计总量可能变化；合并时显示独立阶段。

## 验证与维护

```sh
.venv/bin/pip install -e '.[test]'
.venv/bin/pytest -q
cd frontend
npm run typecheck
npm test
npm run build
```

前端浏览器检查见 `frontend/README.md`。后端确定性测试使用隔离的网络夹具、临时目录和可控子进程，不连接真实账户；这些测试不等价于已通过登录后付费内容的现场下载验证。

`requirements.lock` 和 `frontend/package-lock.json` 固定当前依赖。B 站提取器可能因平台改动需要更新 yt-dlp；更新后重新执行测试、构建并做有权内容的现场验证。备份时停止服务，备份整个数据目录和下载目录，包含 SQLite WAL 文件及 Cookie，备份文件应按敏感数据保护。

## 目录

- `backend/`：API、访问控制、SQLite、队列、媒体子进程及 B 站登录。
- `frontend/`：正式 React Web UI，数据来自真实 `/api`。
- `tests/`：后端确定性测试和独立子进程夹具。
- `deploy/`：Nginx、systemd 配置示例。
- `prototype/`：早期交互原型，仅作设计记录，不进入容器或正式服务。
- `IMPLEMENTATION.md`：前后端接口和内部进程协议。
