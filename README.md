# Dene Voice Library

Members-only database of Dene–English translation pairs with audio recordings, built for the
Dene Voice Project (dene.ca). Implements the PRD in `dene-translation-db-prd.md`:
projects (dialects/communities), role-based access, translation entries with full Unicode
Dene orthography support, audio attachments with automatic duration tracking, search and
filtering, per-project dashboards with progress toward the 100 hr/dialect goal, and
CSV/JSON export for STT/TTS training pipelines.

## Stack

- **Node.js 20+** (tested on 22), Express 5
- **SQLite** (better-sqlite3) — single file at `data/dene.db`, WAL mode
- Audio files stored on disk at `data/audio/<userID>/`, duration extracted with `music-metadata`
- In-browser recording: microphone PCM is encoded to MP3 client-side with `lamejs`
  (vendored at `public/vendor/lame.min.js`), so recorded clips are real `.mp3` files
- No-build vanilla JS frontend in `public/`
- Everything self-hostable — no cloud services required (relevant to the OCAP / data
  sovereignty open question in the PRD)

## Getting started

```powershell
npm install
npm run create-superadmin -- you@example.com "Your Name" "a-strong-password"
npm start          # http://localhost:3000  (set PORT to change)
```

Sign in as the superadmin, create a project from the **Dashboard**, then add members from
the project card → **Members** (existing accounts are added by email; new accounts need a
name and temporary password). Only the superadmin can create projects and assign project
admins; project admins manage their own project's members. There is no public signup.

## Roles

| Role | Powers |
|---|---|
| Superadmin | Everything, across all projects; creates projects and project admins |
| Project admin | Manage members, review/verify entries, export, edit any entry — in their project only |
| Member | Create entries, edit/delete their own entries, upload audio, search within their projects |
| Translator | Recording only — sees a stripped-down app that cycles through entries without audio so they can record them; cannot create or edit entries |

Translators land on a dashboard with a single **Start recording session** button. Each
card shows the Dene text large, the English below it, a record/playback control, and the
entry's metadata, with **Save & next** / **Save & exit** (and **Skip**) to move through
the queue. Project admins assign the role from the project's **Members** page.

Removing a member takes effect immediately (membership is checked on every request);
their past contributions remain attributed to them.

## Recording audio

Each entry shows two recording slots per user: **Dene** and **English**. Click record,
speak, click **Stop & save** — the clip is encoded to MP3 in the browser, tagged with its
language and the speaker, and attached automatically. Each user has at most **one
recording per language per entry** (enforced by a unique index); re-recording or
re-uploading the same language replaces the previous clip. Recordings are **private to
their contributor** — members see and play only their own; project admins and superadmins
see all recordings on entries in their projects (needed for review and export).
Uploading existing files (WAV/MP3/M4A) is still available under
"Upload an audio file instead". Microphone access requires a secure context:
`localhost` works out of the box; a LAN/production deployment needs HTTPS.

## Data layout

- `data/dene.db` — SQLite database (users, sessions, projects, memberships, entries, audio_files)
- `data/audio/<userID>/<file>` — audio files, organized per uploader (random file names;
  original filenames kept in the DB)
- Exports reference audio as `audio/<userID>/<file>`, so an export plus a copy of
  `data/audio/` is a complete training bundle. Recordings carry a `language` tag
  (`dene` or `english`); the CSV export has separate `dene_audio_files` and
  `english_audio_files` columns.

Back up by copying the `data/` directory.

## API

JSON API under `/api` with cookie sessions. Highlights:

- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET/POST /api/projects`, `GET /api/projects/:id/stats`, `GET /api/projects/:id/export?format=csv|json`
- `GET/POST /api/projects/:id/members`, `DELETE /api/projects/:id/members/:userId`
- `GET/POST /api/entries` (filters: `q`, `project_id`, `has_audio`, `contributor`, `status`),
  `GET/PATCH/DELETE /api/entries/:id`
- `POST /api/entries/:id/audio` (multipart; fields: `file`, `language` (`dene`|`english`),
  `speaker`, `recording_notes`), `GET /api/audio/:id/stream`,
  `POST /api/audio/:id/replace`, `PATCH/DELETE /api/audio/:id`

Audio uploads accept WAV, MP3, and M4A up to 500 MB; corrupt or unreadable files are
rejected with a clear message and the entry is left unchanged.

## Deployment (Fly.io, Toronto)

The app runs at https://app.dene.ca on Fly.io in the `yyz` (Toronto) region — data
stays in Canada. Config is in `fly.toml`; the SQLite DB and all audio live on a 10 GB
encrypted volume (`dene_data`) mounted at `/app/data`, with automatic daily snapshots
(5-day retention). DNS: `app.dene.ca` is a CNAME to `dene-translation-db.fly.dev`
in Route 53.

Common operations (flyctl):

```powershell
fly deploy --remote-only --ha=false   # ship the current working tree
fly logs                              # tail production logs
fly status                            # machine state
fly ssh console                       # shell on the production machine
fly certs check app.dene.ca           # TLS certificate status
fly ssh console -C "node scripts/create-superadmin.js <email> <name> <password>"
```

Offsite backup (pulls the SQLite DB; run after `fly ssh console -C "sqlite3 ..."` or
just grab the whole data dir via sftp):

```powershell
fly ssh sftp get /app/data/dene.db ./backup/dene.db
```

## Production notes

- Run behind HTTPS (the session cookie is marked `Secure` when `NODE_ENV=production`).
- The `projects.is_public` column exists for the future public Dene Voice Library face
  (P2-1) but nothing reads it yet.
