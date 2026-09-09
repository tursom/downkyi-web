# Delivery Verification

## Video-to-Collection Parsing Fix

- Reproduced `av116605745239789` returning one entry on the NAS. The Bilibili
  view response identified UGC season 7839144; yt-dlp's video extractor only
  expanded multipart videos, ignoring this parent-collection relationship.
- Root AV/BV links now discover the collection once and reuse the existing
  paginated extractor. Short links are resolved first. Explicit `p` selection
  and actual download jobs keep individual-video behavior.
- Episode titles, durations and covers from collection metadata survive failed
  per-video extraction. Requests are spaced during parsing; unavailable items
  and rate-limit errors remain explicit rather than exposing invented formats.
- Added 18 regression cases. The complete host backend suite passed 220 tests.
  Earlier core discovery changes also passed 219 tests on Python 3.12; the new
  metadata-preservation case is included in the final host run and CI suite.
- Live verification returned `合集·人民的名义-2026版`, 58 unique URLs including
  `BV1HqL16BEeF`, no blank titles and no truncation, in about 71 seconds.
  32 entries were available; 26 had upstream rate-limit errors. Collection
  membership expanded correctly without claiming all media was accessible.

## Root Container Runtime Update

- Per user request, Compose now explicitly runs `user: "0:0"` and retains
  Docker's default capabilities. Dropping all capabilities was removed so root
  can access existing UID 1000 private application directories and NAS files.
- The Dockerfile now also declares root as its default runtime user. The NAS
  was immediately recreated using the existing pinned image with Compose's
  user override; a new image publication is not required for this runtime fix.
- NAS verification returned `uid=0(root) gid=0(root)` and healthy status.
  The actual backend directory validator passed temporary write/fsync/delete
  checks in `/downloads`, `/export` and `/export/media`.
- The base Compose mount checker passed as root, and Dockerfile build checks
  completed without warnings. Existing data, ownership, directory permissions
  and the user's selected default download directory were not changed by this
  operation. This supersedes the earlier UID 1000 deployment configuration.

## NAS Deployment

- Deployed to `nas` (`192.168.0.138`) in `/opt/downkyi` from the successful GHCR
  publication of commit `3cc1762c789198b29967f7877e64ecfc37df33b8`.
  The image is pinned by digest; details are recorded in `deploy/NAS.md`.
- The NAS-specific Compose override adds `/export:/export` to the base two bind
  mounts. Container inspection confirmed all three mounts are `Type=bind`.
- `docker compose up -d --wait` completed with a healthy container. Port 8511 is
  available over the LAN in the existing requested no-token mode.
- UID 1000 write/read/delete probes passed in `/data` and `/downloads`. `/export`
  is readable and traversable, but its root is not writable by the container user.
  Existing NAS ownership and permissions were preserved.
- Real-browser checks at 1440, 390 and 320px passed against the NAS, including
  no-token access, settings, system status and live Bilibili video parsing.
- The former native service and its data were not migrated or removed.

## Export Mount Removal

- Compose now binds only `./docker-data:/data` and `./downloads:/downloads`.
  The `/export` bind was removed; no host directory or stored file was deleted.
- Deployment documentation and directory examples reflect the two-mount setup.
  The earlier three-mount verification below is historical and superseded.
- Compose validation passed. The updated mount checker inspected a real
  container with exactly two bind mounts, verified that `/export` was absent,
  and completed write/read/delete probes as UID 1000 in both mounted directories.
  The temporary verification container was removed.
- Frontend: 54 tests passed; TypeScript/Vite build passed. No NAS deployment,
  remote image publication, or change to the native service's saved directory
  was performed.

## GHCR Publishing Update

- Added `.github/workflows/docker-publish.yml`: tests gate publication to GHCR,
  pull requests cannot publish, and official Actions are pinned to verified
  commit hashes. Default-branch builds publish `latest`; semantic version tags
  publish version tags without replacing `latest`. Both include full-SHA tags.
- Configured `linux/amd64` and `linux/arm64` builds with QEMU/Buildx. The frontend
  build stage uses the builder's native platform; the Python runtime follows
  the target architecture.
- `actionlint` passed. Compose configuration checks passed for the default
  `ghcr.io/tursom/downkyi-web:latest` image and version/digest overrides, with no
  deployment-host build and all three bind mounts preserved.
- Local amd64 Docker build passed, including TypeScript/Vite compilation.
  Backend: 202 passed on host Python 3.14 and 202 passed as UID 1000 on container
  Python 3.12. Frontend: 54 passed. Existing two deprecation warnings remain.
- Actual bind-mount probes passed both with `DOWNKYI_CHECK_IMAGE` and with the
  image taken directly from Compose through `DOWNKYI_IMAGE`. Verification
  containers were removed. The existing server health endpoint remains OK.
- The host root filesystem had no space available to ordinary users. Container
  test dependencies and temporary files used a bounded tmpfs instead; unrelated
  host data and Docker caches were not deleted.
- GitHub execution, remote GHCR publication/pull, and the arm64 build have not
  been run yet. These require pushing the workflow and a successful Actions run.
  No NAS deployment, credential changes or data migration was performed.

## Configurable Download Directory Update

- Web download settings now support a persisted `download_dir`, with the
  environment exposed separately as `default_download_dir`. PATCH accepts only
  changed fields and validates all changes before an atomic commit.
- Validation requires an existing writable absolute directory, rejects symlinks,
  system/private state locations and managed task directories, and performs a
  real temporary-file write/fsync/delete probe. It does not create directories
  or change permissions.
- Each new task stores its download root. Legacy tasks are backfilled once
  without changing their timestamps; queued, paused and completed tasks retain
  their original paths across settings changes and restarts. Missing mounts do
  not cause automatic recreation or fallback to a different directory.
- Backend: 202 tests passed. Frontend: 54 tests passed. TypeScript/Vite and Docker
  builds passed. Fixture-driven browser checks increased to 90 at four widths.
- Actual-server settings UI verified at 1440, 390 and 320px, with its current path
  populated and no page overflow. The existing local default was not changed.
- An isolated non-root Docker instance with bind mounts rejected missing,
  read-only and private paths. A real video admitted before changing the default
  stayed under `/downloads`; a new audio task used `/downloads/alternate`.
  Both completed. After restarting the container, the saved default persisted
  and the earlier video's files remained readable. Test files and containers
  were removed; no user's download files were moved.

## Bind Mount Update

At the earlier bind-mount checkpoint, Compose declared `./docker-data:/data`,
`./downloads:/downloads`, and `/export:/export`. There were no top-level named
volumes, and missing source directories were not created automatically by Docker.
Local application directories were created with UID/GID 1000 and mode 0700.

`/export` is an existing NFS export. Creating `/export/downkyi` was rejected by
the NAS as read-only; no directory was created there and no NAS permissions or
mount options were changed. SQLite and task locks stay on the local data bind.
`DOWNKYI_DOWNLOAD_DIR` can select an existing writable directory under `/export`
when the NAS administrator has granted suitable access.

`node scripts/check-bind-mounts.mjs` validated the rendered Compose configuration,
inspected a real container's mounts (all three reported `Type=bind`), checked
`/export` visibility, and performed temporary write/read/delete probes in `/data`
and `/downloads` as UID 1000. The verification container was removed. Existing
native-service data and the running service on 8511 were not migrated or changed.

## No-token Mode Update

- Explicit `DOWNKYI_AUTH_MODE=none`; default `token` remains protected. Invalid values fail startup.
- No token file is generated/read in open mode. Existing token and Bilibili credential files are retained when switching modes.
- No-cookie tests cover task creation, controls, file retrieval/deletion, settings, QR APIs and logout behavior. Cross-site/body/path protections remain in place.
- Updated backend suite: 182 passed. Updated frontend suite: 42 passed. TypeScript/Vite and Docker builds passed.
- Actual-server browser checks verified direct entry, reload, no session cookie, hidden logout and live parsing at 1440, 390 and 320px. Narrow-screen status label checked visually.
- A non-root Docker instance in `none` mode returned anonymous API success, rejected cross-site mutation with 403 and created no admin-token file. The test container was removed.
- The current local server on 8511 was explicitly restarted in `none` mode. Deployment examples continue to default to `token`.

## Automated Checks

- Backend: `172 passed` with `pytest -q` on Python 3.14.7.
- Frontend: `40 passed` with Vitest.
- Frontend TypeScript and production Vite build passed.
- Fixture-driven Playwright: 74 checks at widths 1440, 768, 390 and 320; no page errors or layout overflow.
- Actual-server Playwright: login, B-layout queue, settings, system status, real public-video parsing and review at widths 1440 and 390; no page errors or document overflow.
- Docker image `downkyi-web:local` built successfully; Compose configuration validated.
- Container ran as UID 1000 with dropped capabilities and no-new-privileges. Health and favicon endpoints returned 200.

Two non-failing deprecation warnings originate from current Starlette test-client/httpx and AnyIO integration. Runtime checks were unaffected.

## Live Download Acceptance

A public, approximately 90-second single-part video was parsed and downloaded at
360P, first through the host service and then through the Python 3.12 Docker
service. This exercised the real API, SQLite queue, isolated yt-dlp worker,
FFmpeg/ffprobe and file serving, not a mock extractor.

Container verification observed:

- Final MP4: 4,640,133 bytes.
- Cover PNG: 628,486 bytes.
- FFprobe: HEVC video at height 360, AAC audio, duration 90.303 seconds.
- Authenticated Range request: HTTP 206, exactly 32 requested bytes.
- Test records and test media were removed using the application's separate
  record-removal and file-deletion endpoints. Temporary acceptance containers
  were removed; the local service on 8511 remains running.

Bilibili QR generation and waiting-state polling succeeded against the live
service, including from the Docker image. The live API now returns an
`account.bilibili.com` scan URL; the adapter accepts that exact host and the
legacy `passport.bilibili.com` host. Regression fixtures reject lookalike and
unrelated hosts.

No user completed a real QR authorization during verification. Cookie import,
confirmed-login verification, expired credentials and failure preservation are
covered by isolated MockTransport tests, not by accessing a real user's account.
Paid/member-only content and every collection/season were not live-tested.

## Review Remediation

- Supervisor-death cleanup now kills the full worker group, including
  TERM-resistant descendants. A per-task file lock is inherited by FFmpeg so
  reuse and deletion remain blocked while any old writer still holds it.
- Visible task records continue owning duplicate identities after file deletion;
  resume checks the same ownership policy.
- Removed unfinished tasks remain discoverable in the library's cleanup filter.
  Their partial files cannot be downloaded as completed media but can be deleted
  independently with confirmation.
- Validation responses omit raw submitted values, including credential bodies.
- Subtitle-only login warnings no longer imply that available video cannot be
  downloaded.

## Reproduction

See README.md for build and deployment commands, frontend/README.md for the
fixture browser checks, and `node scripts/live-browser-check.mjs` for the
non-mutating real-server UI check. The latter reads the local access token
without logging it and performs live metadata requests; it does not create
media downloads or change settings.
