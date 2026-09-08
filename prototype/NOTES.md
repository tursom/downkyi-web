# DownKyi Web Workflow Prototype

Throwaway frontend for reviewing the download workflow before backend implementation.
No API calls, real downloads, database, or persistent credentials. Tasks and
settings are demonstration data held in browser memory and reset on reload.

## Run

```sh
cd /root/dev/bili/downkyi-web/prototype
npm install
npm run dev -- --port 8510
```

Open `/` (old `?variant=` links also show B). The preview currently runs on
port 8510. Backend implementation remains paused.

## Design Decision

The user preferred B, the compact task table with top navigation, and approved
refining its workflow. A/C renderers and the floating variant switcher were
removed. This is still prototype code, not a production frontend.

Workflow reference: DownKyiCore's README and ARCHITECTURE.md, specifically input
identification, part/chapter selection, stream selection, persistent task queue,
media/artifact download, mux/validation, and completed outputs. Upstream desktop
code was not ported, and the desktop application was not run during this work.

## Review Flow

1. New download: choose a demonstration input (single video, multipart,
   collection, episodes, or unavailable video), then parse.
2. Select entries and specifications. Groups collapse; selections support
   search and bulk selection; unavailable/duplicate entries cannot be selected.
   Video/audio mode, codec, per-entry quality, cover and subtitles are retained.
3. Review actual per-entry demonstration quality and available attachments,
   then enqueue. Back navigation preserves options.
4. Open a task's details and use the explicit demonstration-stage command to
   step through queued -> resolving -> downloading -> merging -> completed.
   Media at 100% is not a completed task until mux/validation finishes.
5. Inspect output files. Removing a record preserves completed files in the
   library. Deleting files requires a separate checkbox confirmation; a retained
   task record displays missing files. No filesystem files are actually removed.

The simulated login switch is local to the new-download dialog. Anonymous 720P,
ordinary-account 1080P, membership labels, codecs, durations and available streams
are fixture values for UX review, not claims about live Bilibili API permissions.
The prototype does not implement QR login, server authentication, real extraction,
subtitles, filesystem operations, or background downloads.

The separate `../frontend` directory contains the earlier API-integrated scaffold;
it is NOT the prototype served on port 8510.

## Verification

- TypeScript and Vite build.
- Playwright at desktop 1440x1000 and mobile 390x844.
- Thumbnail loading, no document horizontal overflow or browser page errors.
- Parse errors; quality restrictions and simulated login; back-navigation state;
  duplicate exclusion; multipart/collection/episode selection; audio-only output.
- Full demonstration task lifecycle, media 100% versus mux/validation completion,
  attached files, record-only removal, and independently confirmed file removal.

Browser smoke check: `node check-browser.mjs`. Set `PLAYWRIGHT_CHROMIUM` to your
Chromium executable if it differs from the local environment. Screenshots are
written to `/tmp/downkyi-workflow-screenshots`.

## Image Credits

Demonstration photos from Unsplash, downloaded locally for reliable previews:

- https://images.unsplash.com/photo-1464822759023-fed622ff2c3b
- https://images.unsplash.com/photo-1518770660439-4636190af475
- https://images.unsplash.com/photo-1419242902214-272b3f66ee7a
- https://images.unsplash.com/photo-1519608487953-e999c86e7455

Video titles, authors, download figures and server statistics are fictional.
