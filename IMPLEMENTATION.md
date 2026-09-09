# Implementation Contract

Single-user headless application. The approved prototype B layout is the visual source of truth; no demonstration data or simulated actions in the production frontend. Backend FastAPI serves frontend/dist and /api in a single process, port 8511 for local acceptance. The prototype on 8510 remains available during development.

## API
All paths below start /api. Session cookie authentication by default, same-origin. `DOWNKYI_AUTH_MODE=none` explicitly disables workspace authentication for all APIs/files; request-origin, body-size and path guards remain active. Only use on a trusted network. Errors {detail: string} (422 may be Pydantic list). No secrets returned except short-lived QR image and URL.

- GET /session -> {authenticated: bool, auth_required: bool}; none mode returns true/false without a cookie. Frontend hides login/logout and labels open access when auth_required is false.
- POST /login {token} -> {authenticated:true}, HttpOnly cookie in token mode; none mode is a no-op and permits an empty body.
- POST /logout -> {ok:true}
- GET /tasks -> {tasks: Task[]} (excludes record_removed)
- GET /library -> {tasks: Task[]} (completed outputs and removed unfinished records retained for cleanup; excludes removed records whose files were deleted)
- POST /parse {url} -> ParseResult
- POST /parse/{parse_id}/retry {entry_ids:string[]} -> full merged ParseResult with a new cache id. Only cached unavailable entries are accepted (1–100 unique IDs); the client cannot supply URLs. Successful and unselected entries stay unchanged, and recovered entries retain original id/url/group. Failed retries keep titles/durations/covers. Old snapshots remain immutable until normal expiry; 410 means reparse the original URL. Retry shares parse authentication, concurrency, cancellation, cookie snapshots and the 180-second timeout.
- POST /tasks {parse_id,entry_ids:string[],quality:'best'|'2160'|'1440'|'1080'|'720'|'480'|'360',mode:'video'|'audio',codec:'auto'|'avc'|'hevc'|'av1',subtitles:bool,cover:bool} -> {tasks:Task[]}. Validate server-side cache, no client-supplied media URLs. Duplicate visible tasks rejected 409. Parsing can take up to 180 seconds; support abort/loading.
- POST /tasks/{id}/pause -> Task
- POST /tasks/{id}/resume -> Task (paused/failed, resumes or reparses)
- DELETE /tasks/{id} -> {ok:true} stops active work and removes record, keeps files
- DELETE /tasks/{id}/files -> {ok:true} requires inactive task; removes this task's output/temp files, keeps record
- GET /tasks/{id}/files -> {files:[{name,size,url}]} only finalized artifacts; URLs authenticated
- GET /settings -> {concurrency:number,cookie_configured:bool,download_dir:string,default_download_dir:string}
- PATCH /settings {concurrency?:1..4,download_dir?:string} -> settings; at least one non-null field. Validates an existing writable absolute directory (no symlinks, system/private/managed-task paths). Atomic settings commit, affects newly admitted tasks only. Stored choice survives restarts and overrides the environment's initial default.
- PUT /settings/cookies {cookies:string} -> settings
- DELETE /settings/cookies -> settings
- GET /system -> {version,yt_dlp_version,ffmpeg:bool,disk_total,disk_free,download_dir,active_tasks}
- GET /bilibili/account -> {logged_in:bool,username:string|null,vip:bool,message?:string}
- POST /bilibili/qr -> {id:string,url:string,image:string,expires_in:number}; image data:image/png;base64,...
- POST /bilibili/qr/{id}/poll -> {status:'waiting'|'scanned'|'expired'|'confirmed',message:string}

Task = {id:string,url,title,thumbnail,status:'queued'|'resolving'|'downloading'|'merging'|'paused'|'completed'|'failed',progress:number(0..100),downloaded_bytes:number,total_bytes:number|null,speed:number|null,eta:number|null,error:string|null,quality:string,mode:'video'|'audio',codec:string,subtitles:bool,cover:bool,created_at:string ISO,updated_at:string ISO,record_removed:bool,files_deleted:bool,source_key:string,download_dir:string}

Task download_dir is pinned on admission; files live at download_dir/id. Legacy tasks are backfilled once using their initial root. Changing settings never moves existing files or changes old task paths. /system reports disk information for the current default directory; if inaccessible it returns 503 while /settings remains usable.

ParseResult = {id,title,thumbnail,entries:Entry[],truncated:bool,warnings:string[]}
Entry = {id:string,title:string,url:string,duration:number|null,thumbnail:string,group:string,available:bool,error:string|null,qualities:number[],codecs:string[],has_subtitles:bool}
qualities are actual available stream heights, not presumed permissions. Codes are auto/avc/hevc/av1. No hard-coded account resolution limit. Empty video qualities can still represent audio-only source. Result ID expires in 1 hour. Maximum 100 entries per parse, 50 admitted per call. Optional extra fields in future are safe to ignore.

## Media Worker Contract

backend/media.py implements MediaService and CLI for isolated yt-dlp work. Constructor MediaService(config), config has data_dir,download_dir. Public async parse(url:str,cookie_path:Path|None) -> dict {title,thumbnail,entries,truncated,warnings} (without cache id). Parent manages snapshots so method must not expose cookies. Expose normalize_url(url) async if convenient.

Root BV/AV video URLs without an explicit `p` query discover their UGC collection through the restricted Bilibili view API, then reuse the existing paginated collection extractor. Discovery runs once per parse, after short-link resolution; child videos and download workers do not rediscover collections. Embedded episode titles/durations/covers are retained when a child cannot be extracted. Metadata discovery failures produce a safe warning and fall back to the original video. Parsing spaces extractor requests by 250ms; the existing 100-entry and 180-second limits still apply.

`MediaService.retry(urls, cookie_path)` runs the isolated `python -m backend.media retry -` worker. Its stdin contains `{urls, cookie_path}` selected by the server from a cached parse. It returns `{entries, warnings}` through the same bounded parsed/error protocol. Each URL is resolved without discovering its parent collection; failures are retained individually, and identity changes cannot replace the requested video. The API merges this result into a new full snapshot before returning it.

Download subprocess invocation:
`python -m backend.media download JOB_JSON_PATH`
JOB JSON = {url,output_dir,cookie_path|null,quality,mode,codec,subtitles,cover}
Output newline JSON protocol ONLY, flushed: {event:'progress',status:'resolving'|'downloading'|'merging',progress,downloaded_bytes,total_bytes,speed,eta}; {event:'complete',files:[relative filenames],quality?:string}; {event:'error',message:string}. Exit 0 only after complete. No raw upstream errors/URLs/cookies in output; sanitize URLs/query/credentials. Keep partial media for retries. Paths constrained by parent to unique task dir. Worker should validate finalized media ffprobe and artifacts; output file list trusted only after parent resolves within task dir and excludes symlinks. Cancellation parent sends POSIX process-group TERM/KILL, killing ffmpeg too. The production launcher inherits a per-task filesystem lock into media/FFmpeg children, kills the whole group on supervisor death, and prevents reuse/deletion while an old child still holds the lock. Download uses yt-dlp built-in continuation.

## Bilibili Account Contract
backend/bilibili.py BilibiliAccount(config) owns data_dir/cookies.txt, async methods:
- account() -> above account dict
- create_qr() -> above QR dict
- poll_qr(id) -> above poll dict (on confirmed saves cookies atomically)
- import_cookies(text) -> None (sync or async, specify final)
- clear_cookies() -> None
- snapshot(target:Path) -> Path|None (sync, copies cookie file to private per-operation path)
- configured() -> bool
- close() async
Exceptions ValueError for invalid imports/id; RuntimeError for upstream network/failed authorization. Cookie import only Bilibili-domain Netscape entries, 128KB max. Use atomic restrictive file permissions. Never log secrets. External requests HTTPS, fixed endpoints, no arbitrary callback redirects. Cache QR isolated clients max 5 minutes, max 10 sessions.
