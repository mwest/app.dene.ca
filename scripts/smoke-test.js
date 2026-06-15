// End-to-end smoke test against a running server.
// Usage: node scripts/smoke-test.js [baseUrl] [superadminEmail] [superadminPassword]
const BASE = process.argv[2] || 'http://localhost:3000';
const SA_EMAIL = process.argv[3] || 'mike@dene.ca';
const SA_PASS = process.argv[4] || 'dene-admin-2026';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
  if (!cond) failures++;
}

function client() {
  let cookie = '';
  return {
    async req(method, path, body, isForm = false) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) data = await res.json();
      else data = await res.text();
      return { status: res.status, data, headers: res.headers };
    },
  };
}

// Minimal valid PCM WAV: 1 second of silence at 8 kHz, 16-bit mono.
function makeWav(seconds = 1, rate = 8000) {
  const samples = seconds * rate;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const sa = client();
const member = client();
const stranger = client();

// --- auth ---
let r = await sa.req('GET', '/api/me');
check('unauthenticated /api/me is 401', r.status === 401);

r = await sa.req('POST', '/api/login', { email: SA_EMAIL, password: 'wrong-password' });
check('wrong password rejected', r.status === 401);

r = await sa.req('POST', '/api/login', { email: SA_EMAIL, password: SA_PASS });
check('superadmin login', r.status === 200, JSON.stringify(r.data));

// --- projects ---
const pname = `Smoke Test ${Date.now()}`;
r = await sa.req('POST', '/api/projects', { name: pname, dialect: 'Dëne Sųłıné' });
check('superadmin creates project', r.status === 201, JSON.stringify(r.data));
const projectId = r.data.id;

r = await sa.req('POST', '/api/projects', { name: pname });
check('duplicate project name rejected', r.status === 400);

// --- members ---
const memberEmail = `member${Date.now()}@test.ca`;
r = await sa.req('POST', `/api/projects/${projectId}/members`, {
  email: memberEmail, name: 'Test Member', password: 'member-pass-123',
});
check('admin creates member account', r.status === 201, JSON.stringify(r.data));
const memberId = r.data.user_id;

r = await member.req('POST', '/api/login', { email: memberEmail, password: 'member-pass-123' });
check('member login', r.status === 200);

r = await member.req('GET', '/api/projects');
check('member sees only their project', r.status === 200 &&
  r.data.projects.length === 1 && r.data.projects[0].id === projectId, JSON.stringify(r.data));

r = await member.req('POST', '/api/projects', { name: 'Should fail' });
check('member cannot create projects', r.status === 403);

r = await member.req('GET', `/api/projects/${projectId}/members`);
check('member cannot list members (not admin)', r.status === 403);

r = await member.req('POST', `/api/projects/${projectId}/members`,
  { email: 'x@y.ca', name: 'X', password: 'password123', role: 'admin' });
check('member cannot add members', r.status === 403);

// stranger: a user in no projects
const strangerEmail = `stranger${Date.now()}@test.ca`;
// create a second project + user to test isolation
r = await sa.req('POST', '/api/projects', { name: pname + ' B' });
const projectB = r.data.id;
await sa.req('POST', `/api/projects/${projectB}/members`,
  { email: strangerEmail, name: 'Stranger', password: 'stranger-pass-1' });
await stranger.req('POST', '/api/login', { email: strangerEmail, password: 'stranger-pass-1' });

// --- entries ---
r = await member.req('POST', '/api/entries', {
  project_id: projectId,
  dene_text: 'Sı̨ Mike sʔǫlye, ʔedlánet\'e?',
  english_text: 'My name is Mike, how are you?',
  source_doc: 'Phrase book p.1',
  notes: 'greeting',
});
check('member creates entry with Dene diacritics', r.status === 201, JSON.stringify(r.data));
const entryId = r.data?.id;
check('entry preserves Unicode text', r.data?.dene_text === 'Sı̨ Mike sʔǫlye, ʔedlánet\'e?');

r = await stranger.req('GET', `/api/entries/${entryId}`);
check('non-member cannot read entry (project isolation)', r.status === 403);

r = await stranger.req('POST', '/api/entries',
  { project_id: projectId, dene_text: 'x', english_text: 'y' });
check('non-member cannot create entry in project', r.status === 403);

r = await member.req('PATCH', `/api/entries/${entryId}`, { english_text: 'My name is Mike. How are you?' });
check('member edits own entry', r.status === 200 && r.data.english_text.includes('How are you?'));

r = await member.req('POST', '/api/entries',
  { project_id: projectId, dene_text: 'tu', english_text: 'water', category: 'nature' });
check('entry created with category', r.status === 201 && r.data.category === 'nature',
  JSON.stringify(r.data?.category));
const catEntryId = r.data?.id;

r = await member.req('PATCH', `/api/entries/${catEntryId}`, { category: 'environment' });
check('category editable', r.status === 200 && r.data.category === 'environment');

r = await member.req('GET', `/api/entries?q=environment`);
check('search matches category', r.status === 200 &&
  r.data.entries.some((e) => e.id === catEntryId), JSON.stringify(r.data.total));

r = await member.req('PATCH', `/api/entries/${entryId}`, { status: 'verified' });
check('member cannot change review status', r.status === 403);

r = await sa.req('PATCH', `/api/entries/${entryId}`, { status: 'verified' });
check('admin sets review status', r.status === 200 && r.data.status === 'verified');

// --- search ---
r = await member.req('GET', `/api/entries?q=${encodeURIComponent('sʔǫlye')}`);
check('search by Dene text', r.status === 200 && r.data.total >= 1, JSON.stringify(r.data));

r = await member.req('GET', '/api/entries?q=zzz-no-match-zzz');
check('search with no results', r.status === 200 && r.data.total === 0);

r = await stranger.req('GET', '/api/entries?q=Mike');
check('search excludes other projects', r.status === 200 && r.data.total === 0, JSON.stringify(r.data));

r = await member.req('GET', `/api/entries?project_id=${projectB}`);
check('filtering by non-member project rejected', r.status === 403);

// --- audio ---
const wav = makeWav(2);
let fd = new FormData();
fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'greeting.wav');
fd.append('speaker', 'Elder Test');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('audio upload (WAV)', r.status === 201, JSON.stringify(r.data));
const audioId = r.data?.id;
check('duration auto-captured (~2s)', Math.abs((r.data?.duration_seconds ?? 0) - 2) < 0.1,
  `got ${r.data?.duration_seconds}`);
check('language tagged', r.data?.language === 'dene', JSON.stringify(r.data));
check('stored under audio/<userID>/', r.data?.stored_name?.startsWith(`${memberId}/`),
  `stored_name=${r.data?.stored_name}`);

fd = new FormData();
fd.append('file', new Blob([Buffer.from('this is not audio at all')], { type: 'audio/wav' }), 'corrupt.wav');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('corrupt audio rejected gracefully', r.status === 400 && /corrupt|read/i.test(r.data.error), JSON.stringify(r.data));

fd = new FormData();
fd.append('file', new Blob([wav]), 'notes.txt');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('unsupported extension rejected', r.status === 400);

r = await member.req('GET', `/api/entries/${entryId}`);
check('entry intact after failed uploads, 1 audio attached',
  r.status === 200 && r.data.audio.length === 1, JSON.stringify(r.data?.audio));

r = await member.req('GET', `/api/audio/${audioId}/stream`);
check('member streams audio', r.status === 200);

r = await stranger.req('GET', `/api/audio/${audioId}/stream`);
check('non-member cannot stream audio', r.status === 403);

// one recording per language per user: same-language upload replaces
fd = new FormData();
fd.append('file', new Blob([makeWav(3)], { type: 'audio/wav' }), 'greeting-v2.wav');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('same-language re-upload replaces (upsert)', r.status === 200 && r.data.replaced === true &&
  r.data.id === audioId && Math.abs(r.data.duration_seconds - 3) < 0.1, JSON.stringify(r.data));

fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'english.wav');
fd.append('language', 'english');
r = await member.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('second language adds a slot', r.status === 201 && r.data.language === 'english');
const englishAudioId = r.data?.id;

r = await member.req('GET', `/api/entries/${entryId}`);
check('member has one dene + one english', r.status === 200 && r.data.audio.length === 2 &&
  new Set(r.data.audio.map((a) => a.language)).size === 2, JSON.stringify(r.data?.audio));

// every project member sees and can stream all recordings on the project's entries
const member2Email = `member2-${Date.now()}@test.ca`;
await sa.req('POST', `/api/projects/${projectId}/members`,
  { email: member2Email, name: 'Second Member', password: 'member2-pass-1' });
const member2 = client();
await member2.req('POST', '/api/login', { email: member2Email, password: 'member2-pass-1' });

fd = new FormData();
fd.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'm2-dene.wav');
fd.append('language', 'dene');
r = await member2.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('second member records own dene clip', r.status === 201, JSON.stringify(r.data));
const member2AudioId = r.data?.id;

r = await member2.req('GET', `/api/entries/${entryId}`);
check('member2 sees all recordings on the entry', r.status === 200 && r.data.audio.length === 3 &&
  r.data.audio.some((a) => a.id === member2AudioId), JSON.stringify(r.data?.audio));

r = await member.req('GET', `/api/entries/${entryId}`);
check("member1 sees member2's recording too", r.status === 200 && r.data.audio.length === 3 &&
  r.data.audio.some((a) => a.id === member2AudioId), JSON.stringify(r.data?.audio));

r = await member2.req('GET', `/api/audio/${audioId}/stream`);
check("member streams another member's recording", r.status === 200);

r = await sa.req('GET', `/api/entries/${entryId}`);
check('admin sees all recordings', r.status === 200 && r.data.audio.length === 3,
  JSON.stringify(r.data?.audio?.length));

r = await sa.req('GET', `/api/audio/${member2AudioId}/stream`);
check("admin can stream members' recordings", r.status === 200);

// --- translator role: records audio, cannot touch entries ---
const translatorEmail = `translator${Date.now()}@test.ca`;
r = await sa.req('POST', `/api/projects/${projectId}/members`,
  { email: translatorEmail, name: 'Test Translator', password: 'translator-pass-1', role: 'translator' });
check('admin creates translator account', r.status === 201, JSON.stringify(r.data));

const translator = client();
r = await translator.req('POST', '/api/login', { email: translatorEmail, password: 'translator-pass-1' });
check('translator login', r.status === 200);

r = await translator.req('GET', '/api/projects');
check('translator sees project with translator role', r.status === 200 &&
  r.data.projects[0]?.role === 'translator', JSON.stringify(r.data));

r = await translator.req('POST', '/api/entries',
  { project_id: projectId, dene_text: 'x', english_text: 'y' });
check('translator cannot create entries', r.status === 403);

r = await translator.req('PATCH', `/api/entries/${entryId}`, { english_text: 'nope' });
check('translator cannot edit entries', r.status === 403);

r = await translator.req('GET', `/api/entries?project_id=${projectId}&has_audio=no`);
check('translator lists entries without audio (recording queue)', r.status === 200 &&
  r.data.entries.every((e) => e.audio_count === 0), JSON.stringify(r.data.total));

fd = new FormData();
fd.append('file', new Blob([makeWav(2)], { type: 'audio/wav' }), 'translator-dene.wav');
fd.append('language', 'dene');
r = await translator.req('POST', `/api/entries/${entryId}/audio`, fd, true);
check('translator records audio on an entry', r.status === 201, JSON.stringify(r.data));
const translatorAudioId = r.data?.id;

// clean up the extra clips so the stats checks below stay simple
await member.req('DELETE', `/api/audio/${englishAudioId}`);
await member2.req('DELETE', `/api/audio/${member2AudioId}`);
await translator.req('DELETE', `/api/audio/${translatorAudioId}`);

// --- stats & export ---
r = await sa.req('GET', `/api/projects/${projectId}/stats`);
check('project stats: entries + audio seconds', r.status === 200 &&
  r.data.entry_count === 2 && Math.abs(r.data.audio_seconds - 3) < 0.1, JSON.stringify(r.data));

r = await sa.req('GET', `/api/projects/${projectId}/export?format=csv`);
check('CSV export', r.status === 200 && String(r.data).includes('dene_text'), String(r.data).slice(0, 100));

r = await sa.req('GET', `/api/projects/${projectId}/export?format=json`);
check('JSON export includes audio refs', r.status === 200 &&
  r.data.entries[0].audio.length === 1 &&
  r.data.entries[0].audio[0].file === `audio/${memberId}/` + r.data.entries[0].audio[0].file.split('/').pop() &&
  r.data.entries[0].audio[0].language === 'dene',
  JSON.stringify(r.data).slice(0, 300));

r = await member.req('GET', `/api/projects/${projectId}/export?format=json`);
check('member cannot export (admin only)', r.status === 403);

// --- bulk CSV import (superadmin only) ---
const csvBody = [
  '"Dene Text","English Text"',
  '"sı̨ne, sǫba","my money, with a comma"',
  'ʔedlánetʼe?,How are you?',
  'ʔedlánetʼe?,How are you?',                       // duplicate within file
  '"Sı̨ Mike sʔǫlye, ʔedlánetʼe?",ignored-not-dup', // same dene but different english = not a dup
  ',missing dene',
  'missing english,',
  '',
].join('\r\n');

fd = new FormData();
fd.append('file', new Blob(['﻿' + csvBody], { type: 'text/csv' }), 'phrasebook.csv');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('CSV import (header, quotes, BOM, CRLF)', r.status === 200 &&
  r.data.imported === 3 && r.data.skipped_duplicates === 1 && r.data.skipped_invalid === 2,
  JSON.stringify(r.data));

r = await sa.req('GET', `/api/entries?project_id=${projectId}&q=${encodeURIComponent('sǫba')}`);
check('imported entry searchable with diacritics intact', r.status === 200 && r.data.total === 1 &&
  r.data.entries[0].dene_text === 'sı̨ne, sǫba', JSON.stringify(r.data.entries?.[0]?.dene_text));
check('import sets source document', r.data.entries?.[0]?.source_doc === 'CSV import: phrasebook.csv',
  JSON.stringify(r.data.entries?.[0]?.source_doc));

fd = new FormData();
fd.append('file', new Blob([csvBody], { type: 'text/csv' }), 'phrasebook.csv');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('re-import is idempotent (all duplicates)', r.status === 200 &&
  r.data.imported === 0 && r.data.skipped_duplicates === 4, JSON.stringify(r.data));

// headerless two-column file
fd = new FormData();
fd.append('file', new Blob(['łue,fish\n'], { type: 'text/csv' }), 'no-header.csv');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('headerless CSV assumes dene,english', r.status === 200 && r.data.imported === 1,
  JSON.stringify(r.data));

// optional third category column
const catCsv = 'dene_text,english_text,category\nbesı̨ı̨́,knife,tools\nkǫ́,fire,"household, heat"\nsah,bear\n';
fd = new FormData();
fd.append('file', new Blob([catCsv], { type: 'text/csv' }), 'categories.csv');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('CSV import with optional category column', r.status === 200 && r.data.imported === 3,
  JSON.stringify(r.data));

r = await sa.req('GET', `/api/entries?project_id=${projectId}&q=besı̨ı̨́`);
check('imported category stored', r.status === 200 && r.data.entries[0]?.category === 'tools',
  JSON.stringify(r.data.entries?.[0]?.category));

r = await sa.req('GET', `/api/entries?project_id=${projectId}&q=sah`);
check('row without category imports with empty category', r.status === 200 &&
  r.data.entries[0]?.category === null, JSON.stringify(r.data.entries?.[0]?.category));

r = await sa.req('GET', `/api/projects/${projectId}/export?format=csv`);
check('CSV export includes category column', r.status === 200 &&
  String(r.data).includes(',category,') && String(r.data).includes('tools'),
  String(r.data).slice(0, 140));

fd = new FormData();
fd.append('file', new Blob(['a,b\n'], { type: 'text/csv' }), 'x.csv');
r = await member.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('member cannot import', r.status === 403);

fd = new FormData();
fd.append('file', new Blob(['not,a,csv'], { type: 'text/plain' }), 'data.json');
r = await sa.req('POST', `/api/projects/${projectId}/import`, fd, true);
check('non-CSV file rejected', r.status === 400);

// --- phrases (entries with kind='phrase'; one side may be blank → incomplete) ---
// Created and cleaned up here so the project's entry/recording counts are
// unchanged for the deletion assertions below.
r = await member.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase', dene_text: 'sǫǫ', english_text: '' });
check('phrase with only Dene (incomplete)', r.status === 201 && r.data.kind === 'phrase' && r.data.english_text === '', JSON.stringify(r.data));
const phraseDeneOnly = r.data?.id;

r = await member.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase', dene_text: '', english_text: 'hello there' });
check('phrase with only English (incomplete)', r.status === 201 && r.data.dene_text === '', JSON.stringify(r.data));
const phraseEngOnly = r.data?.id;

r = await member.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase', dene_text: 'edǝ', english_text: 'good morning' });
check('phrase with both sides (complete)', r.status === 201 && r.data.kind === 'phrase', JSON.stringify(r.data));
const phraseBoth = r.data?.id;

r = await member.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase' });
check('phrase with neither side rejected', r.status === 400);

r = await member.req('POST', '/api/entries', { project_id: projectId, dene_text: 'lonely', english_text: '' });
check('word still requires both sides', r.status === 400);

r = await member.req('GET', `/api/entries?project_id=${projectId}&kind=phrase`);
check('kind=phrase returns only phrases', r.status === 200 && r.data.total >= 3 &&
  r.data.entries.every((e) => e.kind === 'phrase'), JSON.stringify(r.data.total));

r = await member.req('GET', `/api/entries?project_id=${projectId}&kind=word`);
check('kind=word excludes phrases', r.status === 200 && r.data.entries.every((e) => e.kind === 'word'));

r = await member.req('GET', `/api/entries?project_id=${projectId}&kind=phrase&has_audio=no&complete=yes`);
check('recordable queue includes complete phrase, excludes incomplete', r.status === 200 &&
  r.data.entries.some((e) => e.id === phraseBoth) && !r.data.entries.some((e) => e.id === phraseDeneOnly),
  JSON.stringify(r.data.entries.map((e) => e.id)));

fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'p.wav');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${phraseEngOnly}/audio`, fd, true);
check('audio rejected on incomplete phrase', r.status === 400, JSON.stringify(r.data));

r = await member.req('PATCH', `/api/entries/${phraseEngOnly}`, { dene_text: 'sası̨ı̨' });
check('completing a phrase via edit', r.status === 200 && r.data.dene_text === 'sası̨ı̨');

fd = new FormData();
fd.append('file', new Blob([makeWav(1)], { type: 'audio/wav' }), 'p2.wav');
fd.append('language', 'dene');
r = await member.req('POST', `/api/entries/${phraseEngOnly}/audio`, fd, true);
check('audio accepted once phrase is complete', r.status === 201, JSON.stringify(r.data));

r = await member.req('PATCH', `/api/entries/${phraseBoth}`, { dene_text: '', english_text: '' });
check('cannot blank both sides of a phrase', r.status === 400);

r = await translator.req('POST', '/api/entries', { project_id: projectId, kind: 'phrase', english_text: 'nope' });
check('translator cannot create phrases', r.status === 403);

// clean up the phrases (and their cascade-deleted audio) to keep counts stable
for (const pid of [phraseDeneOnly, phraseEngOnly, phraseBoth]) {
  await member.req('DELETE', `/api/entries/${pid}`);
}

// --- removal: immediate access loss, attribution kept ---
r = await sa.req('DELETE', `/api/projects/${projectId}/members/${memberId}`);
check('admin removes member', r.status === 200);

r = await member.req('GET', `/api/entries/${entryId}`);
check('removed member immediately loses access', r.status === 403, JSON.stringify(r.data));

r = await sa.req('GET', `/api/entries/${entryId}`);
check('past contribution still attributed', r.status === 200 && r.data.created_by_name === 'Test Member');

// --- user management (superadmin) ---
r = await member.req('GET', '/api/users');
check('member cannot list users', r.status === 403);

const mgmtEmail = `mgmt${Date.now()}@test.ca`;
r = await sa.req('POST', '/api/users', { email: mgmtEmail, name: 'Mgmt Test', password: 'first-pass-123' });
check('superadmin creates standalone account', r.status === 201, JSON.stringify(r.data));
const mgmtId = r.data?.user_id;

r = await sa.req('PATCH', `/api/users/${mgmtId}`, { password: 'second-pass-456' });
check('superadmin resets password', r.status === 200);

const mgmt = client();
r = await mgmt.req('POST', '/api/login', { email: mgmtEmail, password: 'second-pass-456' });
check('login works with reset password', r.status === 200);

r = await sa.req('PATCH', `/api/users/${mgmtId}`, { is_superadmin: true });
check('grant superadmin', r.status === 200);
r = await mgmt.req('GET', '/api/users');
check('promoted user can list users', r.status === 200);
r = await sa.req('PATCH', `/api/users/${mgmtId}`, { is_superadmin: false });
check('revoke superadmin', r.status === 200);

r = await sa.req('DELETE', `/api/users/${mgmtId}`);
check('delete account without contributions', r.status === 200);

r = await sa.req('DELETE', `/api/users/${memberId}`);
check('account with contributions cannot be deleted', r.status === 400, JSON.stringify(r.data));

// --- public translation requests ---
const requesterEmail = `requester${Date.now()}@test.ca`;
const anon = client();

r = await anon.req('POST', '/api/requests/start', { email: 'not-an-email' });
check('request start rejects invalid email', r.status === 400);

r = await anon.req('POST', '/api/requests/start', { email: requesterEmail });
check('request start issues form link (dev exposes it)', r.status === 200 &&
  typeof r.data.form_link === 'string', JSON.stringify(r.data));
const requestToken = r.data.form_link.split('/').pop();

r = await anon.req('GET', `/api/requests/form/${'0'.repeat(64)}`);
check('bogus form token rejected', r.status === 404);

r = await anon.req('GET', `/api/requests/form/${requestToken}`);
check('form preloads with fixed email', r.status === 200 &&
  r.data.email === requesterEmail && r.data.status === 'invited', JSON.stringify(r.data));

fd = new FormData();
fd.append('name', 'Pat Requester');
r = await anon.req('POST', `/api/requests/form/${requestToken}`, fd, true);
check('form requires name, dialect, details', r.status === 400);

fd = new FormData();
fd.append('name', 'Pat Requester');
fd.append('dialect', 'Tłı̨chǫ');
fd.append('details', 'Please translate the attached ceremony program.');
for (let i = 0; i < 6; i++) {
  fd.append('files', new Blob(['x'], { type: 'text/plain' }), `f${i}.txt`);
}
r = await anon.req('POST', `/api/requests/form/${requestToken}`, fd, true);
check('more than 5 files rejected', r.status === 400 && /at most 5/.test(r.data.error),
  JSON.stringify(r.data));

fd = new FormData();
fd.append('name', 'Pat Requester');
fd.append('dialect', 'Tłı̨chǫ');
fd.append('details', 'Please translate the attached ceremony program.');
fd.append('files', new Blob([makeWav(1)], { type: 'audio/wav' }), 'sample.wav');
fd.append('files', new Blob(['program text'], { type: 'text/plain' }), 'program.txt');
r = await anon.req('POST', `/api/requests/form/${requestToken}`, fd, true);
check('request form submits with 2 files', r.status === 200, JSON.stringify(r.data));

r = await anon.req('GET', `/api/requests/form/${requestToken}`);
check('form reports submitted', r.status === 200 && r.data.status === 'submitted');

fd = new FormData();
fd.append('name', 'Pat Again');
fd.append('dialect', 'x');
fd.append('details', 'y');
r = await anon.req('POST', `/api/requests/form/${requestToken}`, fd, true);
check('resubmission rejected', r.status === 400);

r = await member.req('GET', '/api/requests');
check('non-superadmin cannot list translation jobs', r.status === 403);

r = await sa.req('GET', '/api/requests');
const job = r.data?.requests?.find((x) => x.email === requesterEmail);
check('superadmin lists translation jobs', r.status === 200 && job &&
  job.status === 'submitted' && job.file_count === 2, JSON.stringify(r.data?.requests?.[0]));

r = await sa.req('GET', `/api/requests/${job.id}`);
check('job detail has fields and files', r.status === 200 && r.data.name === 'Pat Requester' &&
  r.data.dialect === 'Tłı̨chǫ' && r.data.files.length === 2, JSON.stringify(r.data));
const txtFile = r.data.files.find((f) => f.original_name === 'program.txt');

r = await sa.req('GET', `/api/requests/files/${txtFile.id}/download`);
check('superadmin downloads request file (forced attachment)', r.status === 200 &&
  /attachment/.test(r.headers.get('content-disposition') ?? ''),
  r.headers.get('content-disposition'));

r = await anon.req('GET', `/api/requests/files/${txtFile.id}/download`);
check('public cannot download request files', r.status === 401);

r = await sa.req('DELETE', `/api/requests/${job.id}`);
check('superadmin deletes translation job', r.status === 200);
r = await sa.req('GET', `/api/requests/${job.id}`);
check('deleted job is gone', r.status === 404);

// --- project editing (superadmin) ---
r = await member.req('PATCH', `/api/projects/${projectId}`, { name: 'Hacked' });
check('member cannot edit a project', r.status === 403);

r = await sa.req('PATCH', `/api/projects/${projectId}`,
  { name: pname + ' Renamed', dialect: 'Tłı̨chǫ', description: 'updated desc' });
check('superadmin edits name/dialect/description', r.status === 200 &&
  r.data.name === pname + ' Renamed' && r.data.dialect === 'Tłı̨chǫ' &&
  r.data.description === 'updated desc', JSON.stringify(r.data));

r = await sa.req('PATCH', `/api/projects/${projectId}`, { name: pname + ' B' });
check('rename to an existing project name rejected', r.status === 400, JSON.stringify(r.data));

r = await sa.req('PATCH', `/api/projects/${projectId}`, { name: pname });
check('rename back', r.status === 200 && r.data.name === pname);

// --- project deletion (superadmin, doubles as cleanup) ---
r = await member.req('DELETE', `/api/projects/${projectId}`, { confirm_name: pname });
check('member cannot delete a project', r.status === 403);

r = await sa.req('DELETE', `/api/projects/${projectId}`, { confirm_name: 'Wrong Name' });
check('wrong confirmation name rejected', r.status === 400, JSON.stringify(r.data));

r = await sa.req('DELETE', `/api/projects/${projectId}`, { confirm_name: pname });
check('superadmin deletes project (entries + recordings)', r.status === 200 &&
  r.data.deleted_entries === 9 && r.data.deleted_recordings === 1, JSON.stringify(r.data));

r = await sa.req('GET', `/api/entries/${entryId}`);
check('entries gone after project deletion', r.status === 404);

r = await sa.req('DELETE', `/api/projects/${projectB}`, { confirm_name: pname + ' B' });
check('second project deleted', r.status === 200);

r = await stranger.req('GET', '/api/projects');
check('membership gone after project deletion', r.status === 200 && r.data.projects.length === 0,
  JSON.stringify(r.data));

console.log(failures ? `\n${failures} FAILURES` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
