# PRD: Dene–English Translation Database

**Project:** Dene Voice Project (dene.ca)
**Status:** Draft v1
**Author:** Mike
**Date:** 2026-06-10

---

## Problem Statement

The Dene Voice Project needs transcribed, dialect-tagged Dene–English translation pairs (text + audio) to build its Speech-to-Text, Text-to-Speech, and Chat AI models, and to populate the Dene Voice Library. Today there is no central, structured place to record and manage this data — it lives in scattered documents, recordings, and individual interpreters' files. Without a shared database, contributions can't be tracked per dialect, audio can't be systematically linked to text, and the project can't measure progress toward its target of 100 hours of transcribed audio per dialect.

## Goals

1. **Centralize translation data**: All Dene–English translation pairs and their audio recordings stored in one structured database, tagged by project (dialect/community).
2. **Enable multi-project contribution**: Contributors can work across one or more projects with correct dialect attribution on every entry.
3. **Controlled membership**: Project admins fully control who can contribute to their project; no public signup.
4. **AI-training-ready data**: Entries are exportable in a format usable for STT/TTS model training (text–audio alignment preserved).
5. **Measurable progress**: Per-project dashboards show entry counts and audio hours collected, tracking toward the 100 hr/dialect goal.

## Non-Goals

- **Public browsing/search** — v1 is members-only. Public access to the Dene Voice Library is a separate, future initiative.
- **Public self-signup** — accounts are created only by project admins (and project admins by the superadmin). Reduces moderation burden and protects data quality.
- **AI model training/inference** — this system produces and manages training data; it does not train or host models.
- **In-browser studio-quality recording workflow** — the CommonVoice-style recording platform is a separate effort; v1 accepts uploaded audio files.
- **Translation service request portal** — the customer-facing translation services portal described on dene.ca is out of scope for this database.

## Personas

- **Superadmin** — Mike / core team. Manages projects and project admins.
- **Project Admin** — leads a dialect/community project. Manages members and reviews entries.
- **Member (Contributor)** — interpreter, translator, or technician. Creates and edits translation entries and uploads audio.

## User Stories

### Superadmin
- As a superadmin, I want to create a new Project (e.g., a dialect or community) so that contributions are organized and attributed correctly.
- As a superadmin, I want to assign or remove Project Admins so that each project has accountable local management.
- As a superadmin, I want to see activity and totals across all projects so that I can report progress to funders and communities.

### Project Admin
- As a project admin, I want to add and remove members of my project so that only trusted contributors can enter data.
- As a project admin, I want to review recent entries in my project so that I can maintain data quality.
- As a project admin, I want to see my project's totals (entries, audio hours) so that I can track progress toward our transcription goals.

### Member
- As a member, I want to create a translation entry (Dene text + English text) tagged to my project so that the pair is preserved with correct dialect attribution.
- As a member, I want to attach one or more audio recordings to an entry so that text and speech stay aligned for AI training and the DVL.
- As a member of multiple projects, I want to switch between my projects so that I always contribute to the right dialect.
- As a member, I want to search and filter entries within my active project so that I can avoid duplicates and find work to continue.
- As a member, I want to edit my own entries so that I can fix mistakes.

### Edge cases
- As a member whose account is removed from a project, I should lose access to that project's data immediately, while my past contributions remain attributed to me.
- As a member, if I upload an unsupported or corrupt audio file, I should see a clear error and the entry should remain intact without the audio.
- As a project admin, I should not be able to see or manage another project's members or data unless I'm also a member there.

## Requirements

### Must-Have (P0)

**P0-1: Authentication & roles**
Email/password (or magic link) login. Three roles: superadmin, project admin, member. No public signup — accounts created by superadmin (admins) or project admins (members).
- [ ] Given no account, a visitor cannot register or view any data
- [ ] A superadmin can create projects and create/assign project admins
- [ ] A project admin can create member accounts and add/remove members in their project only
- [ ] A removed member immediately loses access to that project's data

**P0-2: Projects & membership**
Users belong to one or more projects. All data is scoped to a project.
- [ ] Every entry belongs to exactly one project
- [ ] A user sees only data from projects they belong to
- [ ] Multi-project users can switch their active project (top bar); all views — browsing, search, and entry creation — are scoped to it. Most users have one project and never touch the switcher.

**P0-3: Translation entries**
An entry is a Dene text + English text pair with metadata: project/dialect, contributor, source document (optional), notes, created/updated timestamps.
- [ ] Members can create, view, and edit entries in their project(s)
- [ ] Dene text input supports the full range of Dene orthography characters (Unicode, special characters/diacritics)
- [ ] Entries record who created and last edited them

**P0-4: Audio attachments**
One or more audio files per entry (common formats: WAV, MP3, M4A), with speaker name/ID and recording metadata.
- [ ] Members can upload, play back, and replace audio on an entry
- [ ] Audio duration is captured automatically and counted in project totals
- [ ] Invalid/corrupt uploads fail gracefully with a clear message

**P0-5: Search & browse**
Search entries by Dene text, English text, contributor, or source within the member's active project.
- [ ] Search returns results only from the active project (no per-search project filter)
- [ ] Results can be filtered by has-audio and contributor

### Nice-to-Have (P1)

**P1-1: Project dashboard** — entry count, audio hours, recent activity per project; cross-project rollup for superadmin.
**P1-2: Export** — CSV/JSON export of entries with audio file references, suitable for STT/TTS training pipelines.
**P1-3: Review workflow** — entries flaggable as draft/reviewed/verified by project admins.
**P1-4: Bulk import** — import existing dictionaries/phrase books (CSV) to seed a project.
**P1-5: Duplicate detection** — warn when creating an entry whose Dene or English text closely matches an existing entry in the project.

### Future Considerations (P2)

**P2-1: Public read access** — per-project opt-in public browsing (the DVL public face). Design data model so a visibility flag can be added later.
**P2-2: In-browser recording** — integration with the planned CommonVoice-style recording platform; entries become recording prompts.
**P2-3: Sentence/word-level audio alignment** — store time-aligned segments for higher-quality TTS training.
**P2-4: API access** — token-based API for the Chat AI to query translations.

## Success Metrics

**Leading (first 1–3 months)**
- 100% of active interpreters/translators across pilot projects have accounts and have created ≥1 entry
- ≥80% of new entries include at least one audio attachment
- Median time to create an entry with audio ≤ 3 minutes

**Lagging (6–12 months)**
- Audio hours per dialect tracked and growing toward the 100 hr/dialect 3-year target (≈33 hr/dialect/year pace)
- ≥1 successful export consumed by an STT/TTS training run
- Zero cross-project data leakage incidents

**Measurement**: project dashboard totals (P1-1) evaluated monthly; export usage tracked manually until API exists.

## Open Questions

- **(Mike/community)** Which dialect orthographies must be supported at launch, and is a special on-screen keyboard/input method needed for Dene characters?
- **(Mike)** Expected storage volume for audio — does budget allow cloud object storage, or is self-hosted storage required?
- **(Engineering)** Max audio file size/length per upload? *(non-blocking)*
- **(Mike/community)** Data sovereignty requirements — must data be hosted in Canada or under community control (OCAP principles)? *(blocking for hosting choice)*
- **(Engineering)** Single Dene text field per entry, or support multiple orthographic variants of the same phrase? *(non-blocking)*

## Timeline Considerations

- No hard external deadline identified, but the 100 hr/dialect 3-year transcription goal implies the database should be live before large-scale recording begins.
- **Phase 1 (v1)**: P0 items — auth/roles, projects, entries, audio upload, search.
- **Phase 2**: P1 items — dashboard, export, review workflow, bulk import.
- **Phase 3**: P2 items as the DVL public face and recording platform mature.
- Dependency: the recording-platform effort (CommonVoice-style) should consume this database's schema — coordinate data model before Phase 3.
