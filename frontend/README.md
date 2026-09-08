# DownKyi Web Frontend

Production React + TypeScript + Vite client for `../IMPLEMENTATION.md`. The visual source is approved prototype B: full-width top navigation, compact task table, and a three-step download wizard. There is no production fixture data, simulated action, account resolution cap, or fixed cover image.

## Verification

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:browser
```

The browser check requires Playwright Chromium. To use an existing installation:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:browser
```

`test:browser` reads `dist/` and fulfills static files/API fixtures through Playwright routing. It does **not** start a server or bind a port. It checks 1440, 768, 390 and 320px viewports, B navigation dimensions and compact row height, all three wizard steps, real image rendering, desktop columns/mobile stacking, keyboard drawer behavior, details, preserved files, file deletion, account settings, QR expiration, errors and overflow. Screenshots are written to `test-results/`. Test fixtures are confined to `src/test/` and `scripts/browser-check.mjs`, and are not bundled into production.

## Production Contract

- Serve `dist/` at `/` and route same-origin `/api` to the backend. Session cookie authentication is required by default. With server-side `DOWNKYI_AUTH_MODE=none`, `/session` returns `authenticated:true, auth_required:false`; the client opens the workspace directly, labels unprotected access and hides logout. Missing `auth_required` defaults to protected mode for older backends. Tokens and Bilibili cookies are never persisted in browser storage.
- Session check, token login, logout and protected-API 401 expiration are implemented.
- `/tasks` polls every 2 seconds, `/library` every 5 seconds and `/system` every 15 seconds after each previous request completes. Refresh/unmount abort prior reads and stale responses are ignored. Task detail tracks the latest polled state, including resolving and merging; the browser does not drive worker progression.
- The media library uses `/library`, including output files whose task records have been removed. Artifact lists and authenticated download links come from `/tasks/{id}/files`; only same-origin download links are accepted.
- Parsing supports cancellation/close and a 180-second timeout. The three steps are parse, choose projects/specifications, and review/create. Source groups, unavailable reasons, actual stream heights/codecs, audio-only resources, warnings and truncation are preserved. At most 50 entries may be admitted per creation request.
- Creation sends only the parse cache ID, entry IDs and the exact selected quality/mode/codec/subtitle/cover options. Duplicate 409 and expired-cache errors remain visible on review. There is no client duplicate suppression. The backend remains authoritative for resource access, format fallback and finalized output names; the UI does not promise an invented MP4/M4A container or bitrate.
- Pause/resume/retry use real endpoints. Record removal stops work and preserves files. File deletion is a separate inactive-task action with explicit confirmation, retaining the record. The backend must revalidate inactivity and ownership at mutation time.
- Settings support concurrency 1–4 and an editable server/container download directory. `GET /settings` returns `download_dir` (persisted current default) and `default_download_dir` (environment initial default); `PATCH /settings` sends only changed concurrency/directory fields and consumes the full returned settings. Dirty inputs survive refreshes and errors. Successful saves immediately refresh workspace `/system` so the queue footer and new-download wizard use the current default.
- Download directories must be existing, writable absolute server/container paths, such as `/export` or `/export/downloads` **only if provisioned by the operator**. The client provides no filesystem picker or automatic folder creation. The backend validates actual writability and rejects unsafe, data, system and managed-task paths. Changing the default affects only new tasks; task detail shows the task's pinned `download_dir` and actual `${download_dir}/${id}` directory. Older task payloads without a directory display “未提供”, never the current default.
- Netscape cookie text/file import supports up to 128 KB. Only configured status is fetched; stored cookies are never echoed. Account state comes from `/bilibili/account`.
- QR login uses the returned PNG data URI and sequential POST polls. Close/unmount aborts requests; confirmed/expired/error states stop polling, and the returned expiry deadline also aborts stalled polls. Confirmation refreshes account/settings. Expired/error sessions can be replaced explicitly.
- Dialogs and the mobile drawer trap focus, make the underlying app inert, restore focus on close and support Escape. The compact table scrolls locally on small screens; the page itself does not overflow.

## Source Layout

- `App.tsx`, `Login.tsx`: session boundary and B navigation.
- `Tasks.tsx`, `TaskDetail.tsx`: queue/library, live details and separate delete confirmations.
- `ParseModal.tsx`, `EntryPicker.tsx`, `DownloadSpecs.tsx`, `DownloadReview.tsx`: three-step workflow.
- `Settings.tsx`, `QrLogin.tsx`, `System.tsx`: real settings, account lifecycle and server information.
- `api.ts`, `hooks.ts`, `components.tsx`, `types.ts`: API errors, polling, accessible primitives and contract types.
- `styles.css`, `workflow.css`: B layout and responsive styling.

Live Bilibili authorization, parsing/downloading, server-side queue persistence, disk deletion, and cookie security require backend integration acceptance. No backend/prototype files are owned or modified by this frontend.
