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
| Translator | Recording and translating only — a stripped-down app with a recording session (entries without audio) and a translation session (incomplete phrases). Can complete a phrase's missing side but cannot otherwise create or edit entries |

Translators land on a dashboard with a **Start recording session** button and, whenever
phrases are awaiting translation, a count and a **Start translations session** button.
The recording session shows the Dene text large, the English below it, a record/playback
control, and the entry's metadata. The translation session shows two text boxes (the Dene
phrase/word and the English translation) plus the same metadata, so the translator fills
the missing side. Both sessions use **Save & next** / **Save & exit** / **Skip** to move
through the queue. Project admins assign the role from the project's **Members** page.

Removing a member takes effect immediately (membership is checked on every request);
their past contributions remain attributed to them.

## Dictionary & Phrases

Entries come in two kinds, distinguished by a `kind` column (`word` | `phrase`)
on the shared `entries` table — they share all the same machinery (recording,
review status, search, audio, export). The **Dictionary** tab lists words; the
**Phrases** tab lists phrases.

The one behavioural difference: a **dictionary word requires both the Dene and
English sides**, while a **phrase may be saved with only one side** (the other
left blank). A one-sided phrase is flagged **"Needs translation"** and is
completed either from its normal edit screen or through a translator's
**translation session**. Once both sides are present, the phrase behaves like
any entry and flows into the **same recording queue** as words (an incomplete phrase is held
out of the queue and can't be recorded until it's translated). Filter the
Phrases list by translation state with the "Needs translation / Complete"
selector.

**Import/export by kind.** CSV import (superadmin) has an *Import as* selector —
**Dictionary words** (both columns required) or **Phrases** (a row may fill only
one side; recognises a `dene_text`/`english_text` header and accepts just one of
them). Dedup is scoped per kind, so the same text can exist as both a word and a
phrase. Each list tab has its own **Export CSV/JSON** (admins) that exports just
that kind (`?kind=word|phrase`); the project card's export still produces the
full project, with a `kind` column distinguishing words from phrases.

## Recording audio

Each entry shows two recording slots per user: **Dene** and **English**. Click record,
speak, click **Stop & save** — the clip is encoded to MP3 in the browser, tagged with its
language and the speaker, and attached automatically. Each user has at most **one
recording per language per entry** (enforced by a unique index); re-recording or
re-uploading the same language replaces the previous clip. Recordings are **visible to
the whole project** — every member can see and play all recordings on entries in their
projects; editing or deleting a recording is still restricted to its uploader, project
admins, and superadmins.
Uploading existing files (WAV/MP3/M4A) is still available under
"Upload an audio file instead". Microphone access requires a secure context:
`localhost` works out of the box; a LAN/production deployment needs HTTPS.

## Public translation requests

People outside the app can ask for a translation: the sign-in page links to a public
form (`#/request`) where they enter their email and receive a unique, single-use form
link (valid 7 days). The form fixes the email server-side and collects name, required
Dene dialect, details, and up to 5 files (100 MB each; documents, images, audio, video,
zip). On submission every superadmin gets an email with the details and a link into the
app, where requests appear under the **Translation Jobs** tab (superadmin-only) with
the uploaded files viewable/downloadable. Public endpoints are rate-limited; uploaded
files are always served as attachments (audio may stream inline) so untrusted content
never executes on the app origin.

## Compensation

Optional tracking of translator pay (superadmin-only, under the **Compensation**
tab). Each translator has flat **per-project rates** — one for recording, one for
translation — that can change at any time. As translators record clips and complete
phrase translations, each billable action is logged once into an **append-only ledger**
with the amount **snapshotted at that moment**, so a later rate change only affects
future work (and re-recording a clip doesn't double-bill). Work logged before a rate is
set is recorded at $0 and can be re-priced with a manual **adjustment** (positive or
negative, with a note).

Balances **aggregate per translator** across all their projects:
`balance = sum(work) − sum(payments)`. **Payments are recorded, not moved** — the app
never touches money; the superadmin logs payments made offline (e-transfer, cheque, …)
for bookkeeping. Translators see their own running *earned / paid / balance* on their
dashboard. All amounts are stored as integer cents (CAD). Rate changes are kept in an
audit table.

## Semantic search

The Dictionary and Phrases lists have a **Smart search** toggle. With it on, the
query is matched by *meaning* against the English side — so "greeting" surfaces
"how are you" — rather than by substring; exact keyword matches are boosted to
the top (hybrid). Plain substring search is the default and is unchanged.

Embeddings are produced by a **local** sentence-transformer
(`Xenova/all-MiniLM-L6-v2`, 384-dim) run on-device with `transformers.js` —
the text never leaves the server. Each entry's English embedding is stored as a
`BLOB` on the `entries` row (with the model name, so a model change can be
detected); ranking is a brute-force cosine in memory, which is ample at this
corpus size. The model weights (~90 MB) download once to `data/models` on the
volume and persist across deploys. After deploying, run a one-time backfill for
existing rows:

```powershell
node scripts/embed-backfill.js          # local
bash scripts/prod-ssh.sh "node scripts/embed-backfill.js"   # production
```

Semantic search covers the **English** side only (the Dene side is low-resource
with no good embedding model). The production VM runs with 1 GB memory to fit
the model alongside Node + SQLite.

## Data layout

- `data/dene.db` — SQLite database (users, sessions, projects, memberships, entries,
  audio_files, translation_requests, request_files)
- `data/audio/<userID>/<file>` — audio files, organized per uploader (random file names;
  original filenames kept in the DB)
- `data/requests/<requestID>/<file>` — files uploaded with public translation requests
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
- Public (no session): `POST /api/requests/start` (emails a form link),
  `GET/POST /api/requests/form/:token` (the form; POST is multipart with up to 5 `files`)
- Superadmin: `GET /api/requests`, `GET/DELETE /api/requests/:id`,
  `GET /api/requests/files/:id/download`

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
