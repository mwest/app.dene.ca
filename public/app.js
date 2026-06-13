/* Dene Voice Library — single-page app (no build step) */
'use strict';

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') {
    // Session expired or not signed in — but a 401 from the login attempt
    // itself must fall through so the form can show "Invalid email or password".
    state.me = null;
    renderLogin();
    throw new ApiError('Not signed in', 401);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  return data;
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------
// State & utilities
// ---------------------------------------------------------------------------

const state = {
  me: null,          // { user, projects }
  activeProjectId: Number(localStorage.getItem('activeProjectId')) || null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(seconds) {
  seconds = Math.round(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtHours(seconds) {
  return ((seconds || 0) / 3600).toFixed(2);
}

function fmtBytes(bytes) {
  bytes = bytes || 0;
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function fmtDate(sqlite) {
  if (!sqlite) return '';
  // SQLite datetime('now') is UTC
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function activeProject() {
  const projects = state.me?.projects ?? [];
  return projects.find((p) => p.id === state.activeProjectId) || projects[0] || null;
}

function setActiveProject(id) {
  state.activeProjectId = Number(id);
  localStorage.setItem('activeProjectId', state.activeProjectId);
}

function isAdminOf(projectId) {
  if (state.me?.user.is_superadmin) return true;
  const p = (state.me?.projects ?? []).find((x) => x.id === Number(projectId));
  return p?.role === 'admin';
}

// Translators get a focused recording-only view of the app.
function isTranslator() {
  return !state.me?.user.is_superadmin && activeProject()?.role === 'translator';
}

// ---------------------------------------------------------------------------
// Dene character palette
// ---------------------------------------------------------------------------

const DENE_CHARS = [
  'ʔ', 'ł', 'ą', 'ę', 'į', 'ǫ', 'ų', 'á', 'é', 'í', 'ó', 'ú',
  'ą́', 'ę́', 'į́', 'ǫ́', 'ų́', 'ë', 'ï', 'ö', 'ü', 'ı', 'Ł', 'ʕ',
];

function palette(targetSelector) {
  return `
    <div class="char-palette" data-target="${esc(targetSelector)}">
      ${DENE_CHARS.map((c) => `<button type="button" tabindex="-1">${c}</button>`).join('')}
    </div>
    <div class="palette-hint">Click a character to insert it at the cursor. Hold <b>Shift</b> for uppercase.</div>`;
}

document.addEventListener('mousedown', (e) => {
  // keep focus in the text field while clicking palette buttons
  if (e.target.closest('.char-palette button')) e.preventDefault();
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.char-palette button');
  if (!btn) return;
  const paletteEl = btn.closest('.char-palette');
  const input = $(paletteEl.dataset.target);
  if (!input) return;
  let ch = btn.textContent;
  if (e.shiftKey) ch = ch.toLocaleUpperCase();
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + ch + input.value.slice(end);
  input.focus();
  input.selectionStart = input.selectionEnd = start + ch.length;
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

// ---------------------------------------------------------------------------
// Microphone recorder — captures raw PCM and encodes MP3 with lamejs
// ---------------------------------------------------------------------------

const Recorder = {
  session: null,

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false },
    });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(proc);
    proc.connect(ctx.destination);
    this.session = { stream, ctx, source, proc, chunks };
  },

  async teardown() {
    const s = this.session;
    this.session = null;
    if (!s) return null;
    s.proc.disconnect();
    s.source.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    const sampleRate = s.ctx.sampleRate;
    await s.ctx.close();
    return { chunks: s.chunks, sampleRate };
  },

  /** Stop and return an MP3 Blob. */
  async stop() {
    const rec = await this.teardown();
    if (!rec) return null;
    const total = rec.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Int16Array(total);
    let off = 0;
    for (const c of rec.chunks) {
      for (let i = 0; i < c.length; i++) {
        const v = Math.max(-1, Math.min(1, c[i]));
        samples[off++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    const encoder = new lamejs.Mp3Encoder(1, rec.sampleRate, 128);
    const parts = [];
    for (let i = 0; i < samples.length; i += 1152) {
      const buf = encoder.encodeBuffer(samples.subarray(i, i + 1152));
      if (buf.length) parts.push(buf);
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(tail);
    return new Blob(parts, { type: 'audio/mpeg' });
  },

  async cancel() {
    await this.teardown();
  },
};

// ---------------------------------------------------------------------------
// Modal helper
// ---------------------------------------------------------------------------

function openModal(innerHtml) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">${innerHtml}</div>`;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
  return backdrop;
}
function closeModal() {
  $('.modal-backdrop')?.remove();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function renderTopbar() {
  const bar = $('#topbar');
  if (!state.me) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#user-menu-btn').textContent = `${state.me.user.name} ▾`;
  $('#nav-users').hidden = !state.me.user.is_superadmin;
  $('#nav-jobs').hidden = !state.me.user.is_superadmin;
  $('#topbar nav a[data-nav="entries"]').hidden = isTranslator();

  const sw = $('#project-switcher');
  const projects = state.me.projects;
  sw.innerHTML = projects.length
    ? projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="">(no projects)</option>';
  const ap = activeProject();
  if (ap) sw.value = String(ap.id);
}

function setActiveNav(name) {
  document.querySelectorAll('#topbar nav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.nav === name));
}

$('#project-switcher').addEventListener('change', (e) => {
  setActiveProject(e.target.value);
  // entry list filters are project-specific — reset them on switch
  listState.contributor = '';
  listState.offset = 0;
  renderTopbar(); // nav differs per role (translator vs member)
  route(); // re-render current view with new context
});

$('#user-menu-btn').addEventListener('click', () => {
  const dd = $('#user-menu-dropdown');
  dd.hidden = !dd.hidden;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.user-menu')) $('#user-menu-dropdown').hidden = true;
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  state.me = null;
  location.hash = '';
  renderLogin();
});

$('#change-password-btn').addEventListener('click', () => {
  $('#user-menu-dropdown').hidden = true;
  const m = openModal(`
    <h2>Change password</h2>
    <form id="pw-form">
      <label class="field"><span>Current password</span>
        <input type="password" name="current" required autocomplete="current-password"></label>
      <label class="field"><span>New password (min 8 characters)</span>
        <input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit">Save</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#pw-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/me/password', {
        method: 'POST',
        body: { current_password: f.current.value, new_password: f.next.value },
      });
      closeModal();
      toast('Password updated');
    } catch (err) { showFormError(f, err.message); }
  });
});

function showFormError(form, msg) {
  const p = $('.error-msg', form);
  if (p) { p.textContent = msg; p.hidden = false; }
  else toast(msg, true);
}

// ---------------------------------------------------------------------------
// Login view
// ---------------------------------------------------------------------------

function renderLogin() {
  renderTopbar();
  setActiveNav('');
  view.innerHTML = `
    <div class="login-wrap">
      <div class="brand-big">🪶 Dene Voice Library</div>
      <div class="card">
        <form id="login-form">
          <label class="field"><span>Email</span>
            <input type="email" name="email" required autocomplete="email" autofocus></label>
          <label class="field"><span>Password</span>
            <input type="password" name="password" required autocomplete="current-password"></label>
          <p class="error-msg" hidden></p>
          <button type="submit" style="width:100%">Sign in</button>
          <p style="text-align:center;margin:12px 0 0">
            <a href="#/forgot" style="font-size:0.9rem">Forgot your password?</a></p>
        </form>
      </div>
      <p class="login-note">Accounts are created by your project admin.<br>
      Looking for a Dene translation? <a href="#/request">Submit a request</a>.<br>
      Dene Voice Project · dene.ca</p>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      await loadMe();
      location.hash = '#/entries';
      route();
    } catch (err) { showFormError(f, err.message); }
  });
}

// ---------------------------------------------------------------------------
// Forgot / set password views (work without a session)
// ---------------------------------------------------------------------------

function renderForgot() {
  renderTopbar();
  view.innerHTML = `
    <div class="login-wrap">
      <div class="brand-big">🪶 Dene Voice Library</div>
      <div class="card">
        <form id="forgot-form">
          <p>Enter your account email and we’ll send you a link to reset your password.</p>
          <label class="field"><span>Email</span>
            <input type="email" name="email" required autocomplete="email" autofocus></label>
          <p class="error-msg" hidden></p>
          <button type="submit" style="width:100%">Send reset link</button>
          <p style="text-align:center;margin:12px 0 0"><a href="#/" style="font-size:0.9rem">Back to sign in</a></p>
        </form>
      </div>
    </div>`;
  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/password/forgot', { method: 'POST', body: { email: f.email.value } });
      f.innerHTML = `<p>If <b>${esc(f.email.value)}</b> has an account, a reset link is on its way.
        The link is valid for 2 hours — check your spam folder if you don’t see it.</p>
        <p style="text-align:center;margin:12px 0 0"><a href="#/">Back to sign in</a></p>`;
    } catch (err) { showFormError(f, err.message); }
  });
}

function renderSetPassword(token) {
  renderTopbar();
  view.innerHTML = `
    <div class="login-wrap">
      <div class="brand-big">🪶 Dene Voice Library</div>
      <div class="card" id="setpw-card"><p>Checking your link…</p></div>
    </div>`;
  (async () => {
    let info;
    try { info = await api('/password/token/' + token); }
    catch (err) {
      $('#setpw-card').innerHTML = `<p>${esc(err.message)}</p>
        <p>Ask your project admin for a new invite, or
        <a href="#/forgot">request a fresh reset link</a>.</p>`;
      return;
    }
    $('#setpw-card').innerHTML = `
      <form id="setpw-form">
        <p>${info.purpose === 'invite' ? 'Welcome' : 'Hi'}, <b>${esc(info.name)}</b> —
          choose a password for <b>${esc(info.email)}</b>.</p>
        <label class="field"><span>New password (min 8 characters)</span>
          <input type="password" name="pw1" required minlength="8" autocomplete="new-password" autofocus></label>
        <label class="field"><span>Repeat password</span>
          <input type="password" name="pw2" required minlength="8" autocomplete="new-password"></label>
        <p class="error-msg" hidden></p>
        <button type="submit" style="width:100%">Set password</button>
      </form>`;
    $('#setpw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.pw1.value !== f.pw2.value) { showFormError(f, 'Passwords do not match'); return; }
      try {
        await api('/password/reset', { method: 'POST', body: { token, password: f.pw1.value } });
        location.hash = '#/';
        renderLogin();
        toast('Password set — you can sign in now');
      } catch (err) { showFormError(f, err.message); }
    });
  })();
}

// ---------------------------------------------------------------------------
// Public translation request views (work without a session)
// ---------------------------------------------------------------------------

function renderRequestStart() {
  renderTopbar();
  view.innerHTML = `
    <div class="login-wrap">
      <div class="brand-big">🪶 Dene Voice Library</div>
      <div class="card">
        <form id="request-start-form">
          <p>Looking for a Dene translation? Enter your email and we’ll send you a
            link to a short request form.</p>
          <label class="field"><span>Email</span>
            <input type="email" name="email" required autocomplete="email" autofocus></label>
          <p class="error-msg" hidden></p>
          <button type="submit" style="width:100%">Send me the form</button>
          <p style="text-align:center;margin:12px 0 0"><a href="#/" style="font-size:0.9rem">Back to sign in</a></p>
        </form>
      </div>
    </div>`;
  $('#request-start-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/requests/start', { method: 'POST', body: { email: f.email.value } });
      f.innerHTML = r.sent
        ? `<p>We sent a link to <b>${esc(f.email.value)}</b> — it’s valid for 7 days.
            Check your spam folder if you don’t see it.</p>
           <p style="text-align:center;margin:12px 0 0"><a href="#/">Back to sign in</a></p>`
        : `<p>We couldn’t send the email right now — please try again later.</p>
           <p style="text-align:center;margin:12px 0 0"><a href="#/">Back to sign in</a></p>`;
    } catch (err) { showFormError(f, err.message); }
  });
}

function renderRequestForm(token) {
  renderTopbar();
  view.innerHTML = `
    <div class="request-wrap">
      <div class="brand-big">🪶 Dene Voice Library</div>
      <div class="card" id="request-card"><p>Checking your link…</p></div>
    </div>`;
  (async () => {
    let info;
    try { info = await api('/requests/form/' + token); }
    catch (err) {
      $('#request-card').innerHTML = `<p>${esc(err.message)}</p>
        <p><a href="#/request">Request a fresh link</a>.</p>`;
      return;
    }
    if (info.status === 'submitted') {
      $('#request-card').innerHTML = `<p>This request has already been submitted —
        thank you! We’ll be in touch at <b>${esc(info.email)}</b>.</p>`;
      return;
    }
    $('#request-card').innerHTML = `
      <form id="request-form">
        <h2 style="margin-top:0">Translation request</h2>
        <label class="field"><span>Name</span>
          <input type="text" name="name" required value="${esc(info.name ?? '')}" autofocus></label>
        <label class="field"><span>Email</span>
          <input type="email" name="email" value="${esc(info.email)}" readonly
            style="background:var(--bg);color:var(--muted)"></label>
        <label class="field"><span>Dene dialect required</span>
          <input type="text" name="dialect" required value="${esc(info.dialect ?? '')}"
            placeholder="e.g. Dëne Sųłıné, Tłı̨chǫ, North Slavey"></label>
        <label class="field"><span>Details of your request</span>
          <textarea name="details" required rows="6"
            placeholder="What do you need translated? Include any deadlines or context.">${esc(info.details ?? '')}</textarea></label>
        <label class="field"><span>Files (optional — up to 5, max 100 MB each)</span>
          <input type="file" name="files" multiple
            accept=".pdf,.doc,.docx,.txt,.rtf,.csv,.xlsx,.jpg,.jpeg,.png,.heic,.mp3,.wav,.m4a,.mp4,.mov,.zip"></label>
        <p class="error-msg" hidden></p>
        <button type="submit" id="request-submit" style="width:100%">Submit request</button>
      </form>`;
    $('#request-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.files.files.length > 5) {
        showFormError(f, 'You can attach at most 5 files');
        return;
      }
      const fd = new FormData();
      fd.append('name', f.name.value);
      fd.append('dialect', f.dialect.value);
      fd.append('details', f.details.value);
      for (const file of f.files.files) fd.append('files', file);
      const btn = $('#request-submit');
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      try {
        await api('/requests/form/' + token, { method: 'POST', body: fd });
        $('#request-card').innerHTML = `<p><b>Request submitted — mahsi cho!</b></p>
          <p>We’ll review it and get back to you at <b>${esc(info.email)}</b>.</p>`;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Submit request';
        showFormError(f, err.message);
      }
    });
  })();
}

// ---------------------------------------------------------------------------
// Translation jobs (superadmin)
// ---------------------------------------------------------------------------

const jobStatusBadge = (s) =>
  s === 'submitted' ? '<span class="badge audio">Submitted</span>'
                    : '<span class="badge">Awaiting form</span>';

async function renderJobs() {
  setActiveNav('jobs');
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try { data = await api('/requests'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  view.innerHTML = `
    <div class="page-head"><h1>Translation jobs</h1></div>
    <div class="card">
      ${data.requests.length ? `
      <table>
        <thead><tr><th>Received</th><th>Name</th><th>Email</th><th>Dialect</th><th>Files</th><th>Status</th></tr></thead>
        <tbody>
          ${data.requests.map((r) => `
            <tr class="job-row" data-id="${r.id}">
              <td>${fmtDate(r.submitted_at ?? r.created_at)}</td>
              <td>${esc(r.name ?? '—')}</td>
              <td>${esc(r.email)}</td>
              <td>${esc(r.dialect ?? '—')}</td>
              <td>${r.file_count}</td>
              <td>${jobStatusBadge(r.status)}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty">No translation requests yet.<br>
        The public request form is linked from the sign-in page.</div>`}
    </div>`;

  view.onclick = (e) => {
    const row = e.target.closest('tr.job-row');
    if (row) location.hash = `#/jobs/${row.dataset.id}`;
  };
}

async function renderJobDetail(id) {
  setActiveNav('jobs');
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let job;
  try { job = await api(`/requests/${id}`); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const field = (label, value) =>
    `<div class="job-field"><div class="job-label">${label}</div><div>${value}</div></div>`;

  view.innerHTML = `
    <div class="page-head">
      <h1>Translation job #${job.id}</h1>
      <a class="btn secondary" href="#/jobs">‹ Back to jobs</a>
    </div>
    <div class="card">
      <div class="entry-meta" style="margin-bottom:0.8rem">
        ${jobStatusBadge(job.status)}
        <span>requested ${fmtDate(job.created_at)}</span>
        ${job.submitted_at ? `<span>submitted ${fmtDate(job.submitted_at)}</span>` : ''}
      </div>
      ${field('Name', esc(job.name ?? '—'))}
      ${field('Email', `<a href="mailto:${esc(job.email)}">${esc(job.email)}</a>`)}
      ${field('Dene dialect required', esc(job.dialect ?? '—'))}
      ${field('Details of the request', `<div class="job-details">${esc(job.details ?? '—')}</div>`)}
    </div>
    <div class="card">
      <h2 style="margin-top:0">Files (${job.files.length})</h2>
      ${job.files.length ? job.files.map((f) => `
        <div class="audio-item">
          <div class="audio-item-head">
            <span class="fname">${esc(f.original_name)}</span>
            <span style="color:var(--muted);font-size:0.85rem">
              ${fmtBytes(f.size_bytes)} ·
              <a href="/api/requests/files/${f.id}/download?dl=1">Download</a></span>
          </div>
          ${f.mime_type.startsWith('audio/')
            ? `<audio controls preload="none" src="/api/requests/files/${f.id}/download"></audio>` : ''}
        </div>`).join('') : '<p style="color:var(--muted)">No files attached.</p>'}
    </div>
    <div class="form-actions">
      <button class="danger" id="delete-job">Delete request</button>
    </div>`;

  $('#delete-job').addEventListener('click', async () => {
    if (!confirm('Delete this translation request and its files? This cannot be undone.')) return;
    try {
      await api(`/requests/${job.id}`, { method: 'DELETE' });
      toast('Request deleted');
      location.hash = '#/jobs';
    } catch (err) { toast(err.message, true); }
  });
}

// ---------------------------------------------------------------------------
// Entries list view
// ---------------------------------------------------------------------------

const listState = { q: '', has_audio: '', contributor: '', status: '', offset: 0 };

async function renderEntries() {
  setActiveNav('entries');
  const projects = state.me.projects;
  if (!projects.length) {
    view.innerHTML = `<div class="empty">You are not a member of any project yet.<br>
      Ask your project admin to add you.</div>`;
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <h1>Dictionary</h1>
      <a class="btn" href="#/entries/new">＋ New entry</a>
    </div>
    <div class="filters">
      <input type="search" id="f-q" placeholder="Search Dene or English text…" value="${esc(listState.q)}">
      <select id="f-audio">
        <option value="">Audio: any</option>
        <option value="yes" ${listState.has_audio === 'yes' ? 'selected' : ''}>Has audio</option>
        <option value="no" ${listState.has_audio === 'no' ? 'selected' : ''}>No audio</option>
      </select>
      <select id="f-contributor"><option value="">All contributors</option></select>
      <select id="f-status">
        <option value="">Status: any</option>
        ${['draft', 'reviewed', 'verified'].map((s) =>
          `<option value="${s}" ${listState.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="entry-list" id="entry-list"><div class="empty">Loading…</div></div>
    <div class="pager" id="pager"></div>`;

  // contributor options come from the active project's stats
  populateContributors();

  let searchTimer;
  $('#f-q').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { listState.q = e.target.value; listState.offset = 0; loadEntryList(); }, 250);
  });
  for (const [id, key] of [['#f-audio', 'has_audio'], ['#f-contributor', 'contributor'], ['#f-status', 'status']]) {
    $(id).addEventListener('change', (e) => { listState[key] = e.target.value; listState.offset = 0; loadEntryList(); });
  }

  await loadEntryList();
}

async function populateContributors() {
  const sel = $('#f-contributor');
  if (!sel) return;
  const pid = activeProject()?.id;
  if (!pid) return;
  try {
    const stats = await api(`/projects/${pid}/stats`);
    sel.innerHTML = '<option value="">All contributors</option>' +
      stats.contributors.map((c) =>
        `<option value="${c.id}" ${String(c.id) === String(listState.contributor) ? 'selected' : ''}>${esc(c.name)} (${c.entry_count})</option>`).join('');
  } catch { /* keep default */ }
}

async function loadEntryList() {
  const listEl = $('#entry-list');
  if (!listEl) return;
  const params = new URLSearchParams();
  const ap = activeProject();
  if (ap) params.set('project_id', String(ap.id));
  if (listState.q) params.set('q', listState.q);
  if (listState.has_audio) params.set('has_audio', listState.has_audio);
  if (listState.contributor) params.set('contributor', listState.contributor);
  if (listState.status) params.set('status', listState.status);
  params.set('limit', '50');
  params.set('offset', String(listState.offset));

  let data;
  try { data = await api('/entries?' + params); }
  catch (err) { listEl.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  if (!data.entries.length) {
    listEl.innerHTML = `<div class="empty">No entries found.</div>`;
    $('#pager').innerHTML = '';
    return;
  }

  listEl.innerHTML = data.entries.map((e) => `
    <a class="entry-row" href="#/entries/${e.id}">
      <div class="dene">${esc(e.dene_text)}</div>
      <div class="english">${esc(e.english_text)}</div>
      <div class="entry-meta">
        <span class="badge">${esc(e.project_name)}</span>
        ${e.category ? `<span class="badge">${esc(e.category)}</span>` : ''}
        ${e.audio_count ? `<span class="badge audio">♪ ${e.audio_count} · ${fmtDuration(e.audio_seconds)}</span>` : ''}
        ${e.status !== 'draft' ? `<span class="badge status-${e.status}">${e.status}</span>` : ''}
        <span>by ${esc(e.created_by_name)}</span>
        <span>updated ${fmtDate(e.updated_at)}</span>
      </div>
    </a>`).join('');

  const pager = $('#pager');
  const page = Math.floor(listState.offset / 50) + 1;
  const pages = Math.max(1, Math.ceil(data.total / 50));
  pager.innerHTML = pages > 1 ? `
    <button class="ghost small" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <span>Page ${page} of ${pages} · ${data.total} entries</span>
    <button class="ghost small" id="pg-next" ${page >= pages ? 'disabled' : ''}>Next ›</button>`
    : `<span style="color:var(--muted);font-size:0.85rem">${data.total} entries</span>`;
  $('#pg-prev')?.addEventListener('click', () => { listState.offset -= 50; loadEntryList(); });
  $('#pg-next')?.addEventListener('click', () => { listState.offset += 50; loadEntryList(); });
}

// ---------------------------------------------------------------------------
// New entry view
// ---------------------------------------------------------------------------

function renderNewEntry() {
  setActiveNav('entries');
  const projects = state.me.projects;
  if (!projects.length) { location.hash = '#/entries'; return; }
  const ap = activeProject();

  view.innerHTML = `
    <div class="page-head">
      <h1>New entry</h1>
      <span class="page-context">${esc(ap.name)}${ap.dialect ? ` — ${esc(ap.dialect)}` : ''}</span>
    </div>
    <div class="card">
      <form id="entry-form">
        <label class="field"><span>Dene text</span>
          <input type="text" name="dene_text" id="dene-input" class="dene" required lang="den" spellcheck="false"></label>
        ${palette('#dene-input')}
        <label class="field"><span>English text</span>
          <input type="text" name="english_text" required></label>
        <div class="form-row">
          <label class="field"><span>Category (optional)</span>
            <input type="text" name="category" placeholder="e.g. greetings, animals, weather"></label>
          <label class="field"><span>Source document (optional)</span>
            <input type="text" name="source_doc" placeholder="e.g. Elder interview 2026-05, phrase book p.12"></label>
          <label class="field"><span>Notes (optional)</span>
            <input type="text" name="notes" placeholder="Context, register, regional usage…"></label>
        </div>
        <p class="error-msg" hidden></p>
        <div class="form-actions">
          <button type="submit">Create entry</button>
          <a class="btn secondary" href="#/entries">Cancel</a>
        </div>
      </form>
    </div>`;

  $('#entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const entry = await api('/entries', {
        method: 'POST',
        body: {
          project_id: ap.id,
          dene_text: f.dene_text.value,
          english_text: f.english_text.value,
          category: f.category.value,
          source_doc: f.source_doc.value,
          notes: f.notes.value,
        },
      });
      toast('Entry created — you can add audio now');
      location.hash = `#/entries/${entry.id}`;
    } catch (err) { showFormError(f, err.message); }
  });
}

// ---------------------------------------------------------------------------
// Entry detail view
// ---------------------------------------------------------------------------

async function renderEntryDetail(id) {
  setActiveNav('entries');
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let entry;
  try { entry = await api(`/entries/${id}`); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const ro = !entry.can_edit;
  const isAdmin = entry.role === 'admin';
  const myId = state.me.user.id;
  const mine = {
    dene: entry.audio.find((a) => a.uploaded_by === myId && a.language === 'dene'),
    english: entry.audio.find((a) => a.uploaded_by === myId && a.language === 'english'),
  };
  const others = entry.audio.filter((a) => a.uploaded_by !== myId);

  view.innerHTML = `
    <div class="page-head">
      <h1>Entry #${entry.id}</h1>
      <a class="btn secondary" href="#/entries">‹ Back to dictionary</a>
    </div>
    <div class="card">
      <form id="entry-form">
        <div class="entry-meta" style="margin-bottom:0.8rem">
          <span class="badge">${esc(entry.project_name)}${entry.dialect ? ` — ${esc(entry.dialect)}` : ''}</span>
          <span>created by ${esc(entry.created_by_name)} on ${fmtDate(entry.created_at)}</span>
          <span>last edited by ${esc(entry.updated_by_name)} on ${fmtDate(entry.updated_at)}</span>
        </div>
        <div class="entry-texts">
          <label class="field"><span>Dene text</span>
            <textarea name="dene_text" id="dene-input" class="dene" required lang="den" spellcheck="false" ${ro ? 'readonly' : ''}>${esc(entry.dene_text)}</textarea></label>
          <label class="field"><span>English text</span>
            <textarea name="english_text" required ${ro ? 'readonly' : ''}>${esc(entry.english_text)}</textarea></label>
        </div>
        ${ro ? '' : palette('#dene-input')}
        <div class="form-row">
          <label class="field"><span>Category</span>
            <input type="text" name="category" value="${esc(entry.category ?? '')}" ${ro ? 'readonly' : ''} placeholder="e.g. greetings, animals"></label>
          <label class="field"><span>Source document</span>
            <input type="text" name="source_doc" value="${esc(entry.source_doc ?? '')}" ${ro ? 'readonly' : ''}></label>
          <label class="field"><span>Notes</span>
            <input type="text" name="notes" value="${esc(entry.notes ?? '')}" ${ro ? 'readonly' : ''}></label>
          <label class="field"><span>Review status</span>
            <select name="status" ${isAdmin ? '' : 'disabled'}>
              ${['draft', 'reviewed', 'verified'].map((s) =>
                `<option value="${s}" ${entry.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select></label>
        </div>
        <p class="error-msg" hidden></p>
        ${ro ? '' : `
        <div class="form-actions">
          <button type="submit">Save changes</button>
          <button type="button" class="danger" id="delete-entry">Delete entry</button>
        </div>`}
      </form>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Your recordings</h2>
      <div class="audio-slots" id="audio-slots">
        ${slotHtml('dene', mine.dene)}
        ${mine.english ? slotHtml('english', mine.english) : '' /* legacy English recordings stay manageable; no new ones */}
      </div>
      ${others.length ? `
      <div id="audio-list" style="border-top:1px solid var(--line);margin-top:1rem">
        <h3 style="margin:0.8rem 0 0.2rem">All recordings (admin view)</h3>
        ${others.map((a) => audioItemHtml(a, entry)).join('')}
      </div>` : '<div id="audio-list"></div>'}
      <details style="border-top:1px solid var(--line);padding-top:0.8rem;margin-top:1rem">
        <summary style="cursor:pointer;color:var(--muted)">Upload an audio file instead (WAV / MP3 / M4A)</summary>
        <p style="color:var(--muted);font-size:0.85rem">Uploading replaces your existing recording for that language.</p>
        <form id="audio-form" style="margin-top:0.8rem">
          <div class="form-row">
            <label class="field"><span>Audio file</span>
              <input type="file" name="file" accept=".wav,.mp3,.m4a,audio/*" required></label>
            <label class="field"><span>Speaker name / ID</span>
              <input type="text" name="speaker" placeholder="e.g. Elder Mary T."></label>
            <label class="field"><span>Recording notes</span>
              <input type="text" name="recording_notes" placeholder="e.g. recorded 2026-06, studio"></label>
          </div>
          <p class="error-msg" hidden></p>
          <button type="submit" id="audio-submit">Upload audio</button>
        </form>
      </details>
    </div>`;

  // --- entry save/delete ---
  $('#entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ro) return;
    const f = e.target;
    try {
      const body = {
        dene_text: f.dene_text.value,
        english_text: f.english_text.value,
        category: f.category.value,
        source_doc: f.source_doc.value,
        notes: f.notes.value,
      };
      if (isAdmin) body.status = f.status.value;
      await api(`/entries/${entry.id}`, { method: 'PATCH', body });
      toast('Entry saved');
      renderEntryDetail(entry.id);
    } catch (err) { showFormError(f, err.message); }
  });

  $('#delete-entry')?.addEventListener('click', async () => {
    if (!confirm('Delete this entry and all its audio recordings? This cannot be undone.')) return;
    try {
      await api(`/entries/${entry.id}`, { method: 'DELETE' });
      toast('Entry deleted');
      location.hash = '#/entries';
    } catch (err) { toast(err.message, true); }
  });

  // --- microphone recording ---
  setupRecorder(entry);

  // --- audio upload ---
  $('#audio-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData();
    fd.append('file', f.file.files[0]);
    fd.append('language', 'dene');
    fd.append('speaker', f.speaker.value);
    fd.append('recording_notes', f.recording_notes.value);
    const btn = $('#audio-submit');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      await api(`/entries/${entry.id}/audio`, { method: 'POST', body: fd });
      toast('Audio uploaded');
      renderEntryDetail(entry.id);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Upload audio';
      showFormError(f, err.message);
    }
  });

  // --- per-audio actions (event delegation) ---
  $('#audio-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const audioId = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'delete') {
      if (!confirm('Delete this recording?')) return;
      try {
        await api(`/audio/${audioId}`, { method: 'DELETE' });
        toast('Recording deleted');
        renderEntryDetail(entry.id);
      } catch (err) { toast(err.message, true); }
    } else if (action === 'edit-meta') {
      const item = btn.closest('.audio-item');
      const speaker = prompt('Speaker name / ID:', item.dataset.speaker || '');
      if (speaker === null) return;
      const notes = prompt('Recording notes:', item.dataset.notes || '');
      if (notes === null) return;
      try {
        await api(`/audio/${audioId}`, { method: 'PATCH', body: { speaker, recording_notes: notes } });
        toast('Recording details saved');
        renderEntryDetail(entry.id);
      } catch (err) { toast(err.message, true); }
    }
  });
}

function slotHtml(lang, a) {
  const label = lang === 'english' ? 'English' : 'Dene';
  return `
    <div class="audio-slot" data-lang="${lang}">
      <div class="slot-head">${label}</div>
      ${a ? `
        <audio controls preload="none" src="/api/audio/${a.id}/stream"></audio>
        <div class="slot-meta">${fmtDuration(a.duration_seconds)} · ${fmtDate(a.created_at)}</div>
        <div class="slot-controls">
          <button type="button" class="rec-btn small" data-lang="${lang}">⏺ Re-record</button>
          <button type="button" class="danger small" data-action="delete" data-id="${a.id}">Delete</button>
        </div>` : `
        <div class="slot-empty">No recording yet</div>
        <div class="slot-controls">
          <button type="button" class="rec-btn" data-lang="${lang}">⏺ Record ${label}</button>
        </div>`}
    </div>`;
}

function setupRecorder(entry) {
  const box = $('#audio-slots');
  let timer = null;

  box.onclick = async (e) => {
    const startBtn = e.target.closest('.rec-btn');
    const stopBtn = e.target.closest('[data-rec=stop]');
    const cancelBtn = e.target.closest('[data-rec=cancel]');
    const deleteBtn = e.target.closest('button[data-action=delete]');

    if (deleteBtn) {
      if (!confirm('Delete this recording?')) return;
      try {
        await api(`/audio/${deleteBtn.dataset.id}`, { method: 'DELETE' });
        toast('Recording deleted');
        renderEntryDetail(entry.id);
      } catch (err) { toast(err.message, true); }
      return;
    }

    if (startBtn) {
      if (Recorder.session) return; // one recording at a time
      const lang = startBtn.dataset.lang;
      const langLabel = lang === 'english' ? 'English' : 'Dene';
      try {
        await Recorder.start();
      } catch {
        toast('Could not access the microphone — check browser permissions', true);
        return;
      }
      const slot = startBtn.closest('.audio-slot');
      const controls = $('.slot-controls', slot);
      const started = Date.now();
      box.querySelectorAll('.rec-btn').forEach((b) => { b.disabled = true; });
      controls.innerHTML = `
        <span class="rec-live"><span class="rec-dot"></span> Recording ${langLabel} — <span id="rec-time">0:00</span></span>
        <button type="button" data-rec="stop" data-lang="${lang}">■ Stop &amp; save</button>
        <button type="button" class="ghost" data-rec="cancel">Cancel</button>`;
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        const t = $('#rec-time');
        if (t) t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 250);
      return;
    }

    if (cancelBtn) {
      clearInterval(timer);
      await Recorder.cancel();
      renderEntryDetail(entry.id);
      return;
    }

    if (stopBtn) {
      clearInterval(timer);
      const lang = stopBtn.dataset.lang;
      stopBtn.closest('.slot-controls').innerHTML = `<span class="rec-live">Saving recording…</span>`;
      try {
        const blob = await Recorder.stop();
        if (!blob || blob.size === 0) throw new Error('Nothing was recorded');
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const fd = new FormData();
        fd.append('file', blob, `${lang}-entry${entry.id}-${stamp}.mp3`);
        fd.append('language', lang);
        fd.append('speaker', state.me.user.name);
        fd.append('recording_notes', 'recorded in browser');
        await api(`/entries/${entry.id}/audio`, { method: 'POST', body: fd });
        toast(`${lang === 'english' ? 'English' : 'Dene'} recording saved`);
      } catch (err) {
        toast(err.message, true);
      }
      renderEntryDetail(entry.id);
    }
  };
}

function audioItemHtml(a, entry) {
  const mine = a.uploaded_by === state.me.user.id;
  const canManage = mine || entry.role === 'admin';
  return `
    <div class="audio-item" data-speaker="${esc(a.speaker ?? '')}" data-notes="${esc(a.recording_notes ?? '')}">
      <div class="audio-item-head">
        <span class="fname"><span class="badge ${a.language === 'english' ? '' : 'audio'}">${a.language === 'english' ? 'English' : 'Dene'}</span> ${esc(a.original_name)}</span>
        <span style="color:var(--muted);font-size:0.85rem">
          ${fmtDuration(a.duration_seconds)} · ${(a.size_bytes / 1024 / 1024).toFixed(1)} MB
          · uploaded by ${esc(a.uploaded_by_name)} on ${fmtDate(a.created_at)}
        </span>
      </div>
      ${a.speaker || a.recording_notes ? `
        <div style="font-size:0.9rem;color:var(--muted)">
          ${a.speaker ? `Speaker: <b>${esc(a.speaker)}</b>` : ''}
          ${a.speaker && a.recording_notes ? ' · ' : ''}${esc(a.recording_notes ?? '')}
        </div>` : ''}
      <audio controls preload="none" src="/api/audio/${a.id}/stream"></audio>
      ${canManage ? `
      <div class="audio-actions">
        <button type="button" class="ghost small" data-action="edit-meta" data-id="${a.id}">Edit details</button>
        <button type="button" class="danger small" data-action="delete" data-id="${a.id}">Delete</button>
      </div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Translator dashboard — one big button, more to come later
// ---------------------------------------------------------------------------

async function renderTranslatorDashboard() {
  setActiveNav('dashboard');
  const p = activeProject();
  if (!p) {
    view.innerHTML = `<div class="empty">You are not a member of any project yet.<br>
      Ask your project admin to add you.</div>`;
    return;
  }
  view.innerHTML = `
    <div class="translator-home">
      <h1>Welcome, ${esc(state.me.user.name)}</h1>
      <p class="translator-project">${esc(p.name)}${p.dialect ? ` — ${esc(p.dialect)}` : ''}</p>
      <p class="queue-count" id="queue-count">&nbsp;</p>
      <button class="big-action" id="start-session">⏺ Start recording session</button>
    </div>`;
  $('#start-session').addEventListener('click', () => { location.hash = '#/record'; });
  try {
    const data = await api(`/entries?project_id=${p.id}&has_audio=no&limit=1`);
    $('#queue-count').textContent = data.total === 0
      ? 'Every entry has a recording — check back later.'
      : `${data.total} ${data.total === 1 ? 'entry needs' : 'entries need'} a recording.`;
    if (data.total === 0) $('#start-session').disabled = true;
  } catch { /* count is decorative — the session view reports errors itself */ }
}

// ---------------------------------------------------------------------------
// Recording session — cycle through entries that have no audio yet
// ---------------------------------------------------------------------------

const recSession = { queue: [], pos: 0, total: 0 };

async function renderRecordSession() {
  setActiveNav('dashboard');
  const p = activeProject();
  if (!p) { location.hash = '#/dashboard'; return; }
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try { data = await api(`/entries?project_id=${p.id}&has_audio=no&limit=200`); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  recSession.queue = data.entries;
  recSession.pos = 0;
  recSession.total = data.total;
  renderRecordCard();
}

function renderRecordCard() {
  const entry = recSession.queue[recSession.pos];
  if (!entry) { renderRecordDone(); return; }

  const badges = [
    entry.category ? `<span class="badge">${esc(entry.category)}</span>` : '',
    entry.status !== 'draft' ? `<span class="badge status-${entry.status}">${entry.status}</span>` : '',
  ].filter(Boolean).join(' ');

  view.innerHTML = `
    <div class="rec-session">
      <div class="rec-progress">
        <a href="#/dashboard">‹ Exit</a>
        <span>${recSession.pos + 1} of ${recSession.queue.length}${recSession.total > recSession.queue.length ? ` (${recSession.total} waiting in total)` : ''}</span>
        <span>${esc(entry.project_name)}</span>
      </div>
      <div class="card rec-card">
        <div class="rec-dene dene" lang="den">${esc(entry.dene_text)}</div>
        <div class="rec-english">${esc(entry.english_text)}</div>
        <div class="rec-stage" id="rec-stage"></div>
        <div class="rec-meta">
          ${badges ? `<div>${badges}</div>` : ''}
          ${entry.source_doc ? `<div>Source: ${esc(entry.source_doc)}</div>` : ''}
          ${entry.notes ? `<div>Notes: ${esc(entry.notes)}</div>` : ''}
          <div>Added by ${esc(entry.created_by_name)} · ${fmtDate(entry.created_at)}</div>
        </div>
      </div>
      <div class="rec-actions">
        <button class="secondary" id="save-exit" disabled>Save &amp; exit</button>
        <button id="save-next" disabled>Save &amp; next</button>
        <button class="ghost" id="skip-btn">Skip ›</button>
      </div>
    </div>`;

  setupSessionRecorder(entry);
}

function renderRecordDone() {
  view.innerHTML = `
    <div class="translator-home">
      <h1>All done 🎉</h1>
      <p class="queue-count">You went through every entry in this list. Mahsi cho!</p>
      <div class="rec-actions">
        <button class="secondary" id="back-dash">Back to dashboard</button>
        <button id="check-more">Check for more</button>
      </div>
    </div>`;
  $('#back-dash').addEventListener('click', () => { location.hash = '#/dashboard'; });
  $('#check-more').addEventListener('click', renderRecordSession);
}

/** Record → preview → save flow for one entry card. */
function setupSessionRecorder(entry) {
  const stage = $('#rec-stage');
  const saveExit = $('#save-exit');
  const saveNext = $('#save-next');
  const skipBtn = $('#skip-btn');
  let blob = null;
  let blobUrl = null;
  let timer = null;

  function showIdle() {
    stage.innerHTML = `<button type="button" class="rec-btn big-action" id="rec-start">⏺ Record</button>`;
    $('#rec-start').addEventListener('click', startRec);
  }

  function showPreview() {
    stage.innerHTML = `
      <audio controls src="${blobUrl}"></audio>
      <button type="button" class="ghost" id="rec-again">⏺ Re-record</button>`;
    $('#rec-again').addEventListener('click', () => {
      URL.revokeObjectURL(blobUrl);
      blob = null;
      blobUrl = null;
      saveExit.disabled = saveNext.disabled = true;
      startRec();
    });
  }

  async function startRec() {
    if (Recorder.session) return;
    try {
      await Recorder.start();
    } catch {
      toast('Could not access the microphone — check browser permissions', true);
      return;
    }
    const started = Date.now();
    stage.innerHTML = `
      <span class="rec-live"><span class="rec-dot"></span> Recording — <span id="rec-time">0:00</span></span>
      <button type="button" id="rec-stop">■ Stop</button>
      <button type="button" class="ghost" id="rec-cancel">Cancel</button>`;
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      const t = $('#rec-time');
      if (t) t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
    $('#rec-stop').addEventListener('click', async () => {
      clearInterval(timer);
      try {
        blob = await Recorder.stop();
        if (!blob || blob.size === 0) throw new Error('Nothing was recorded');
      } catch (err) {
        toast(err.message, true);
        showIdle();
        return;
      }
      blobUrl = URL.createObjectURL(blob);
      saveExit.disabled = saveNext.disabled = false;
      showPreview();
    });
    $('#rec-cancel').addEventListener('click', async () => {
      clearInterval(timer);
      await Recorder.cancel();
      showIdle();
    });
  }

  async function save() {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const fd = new FormData();
    fd.append('file', blob, `dene-entry${entry.id}-${stamp}.mp3`);
    fd.append('language', 'dene');
    fd.append('speaker', state.me.user.name);
    fd.append('recording_notes', 'recorded in browser');
    await api(`/entries/${entry.id}/audio`, { method: 'POST', body: fd });
    URL.revokeObjectURL(blobUrl);
  }

  async function saveThen(after) {
    saveExit.disabled = saveNext.disabled = skipBtn.disabled = true;
    try {
      await save();
    } catch (err) {
      toast(err.message, true);
      saveExit.disabled = saveNext.disabled = skipBtn.disabled = false;
      return;
    }
    toast('Recording saved');
    after();
  }

  saveExit.addEventListener('click', () => saveThen(() => { location.hash = '#/dashboard'; }));
  saveNext.addEventListener('click', () => saveThen(() => { recSession.pos++; renderRecordCard(); }));
  skipBtn.addEventListener('click', async () => {
    clearInterval(timer);
    if (Recorder.session) await Recorder.cancel();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    recSession.pos++;
    renderRecordCard();
  });

  showIdle();
}

// ---------------------------------------------------------------------------
// Dashboard view
// ---------------------------------------------------------------------------

const TARGET_HOURS = 100; // PRD: 100 hours of transcribed audio per dialect

async function renderDashboard() {
  setActiveNav('dashboard');
  const isSuper = state.me.user.is_superadmin;
  view.innerHTML = `<div class="empty">Loading…</div>`;

  let data;
  try { data = await api('/projects'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  const projects = data.projects;

  const totalEntries = projects.reduce((s, p) => s + p.entry_count, 0);
  const totalSeconds = projects.reduce((s, p) => s + p.audio_seconds, 0);

  view.innerHTML = `
    <div class="page-head">
      <h1>Dashboard</h1>
      ${isSuper ? '<button id="new-project-btn">＋ New project</button>' : ''}
    </div>
    ${projects.length > 1 || isSuper ? `
    <div class="card">
      <div class="stat-numbers">
        <div><div class="num">${projects.length}</div><div class="lbl">Projects</div></div>
        <div><div class="num">${totalEntries}</div><div class="lbl">Entries</div></div>
        <div><div class="num">${fmtHours(totalSeconds)}</div><div class="lbl">Audio hours</div></div>
      </div>
    </div>` : ''}
    <div class="stat-grid">
      ${projects.map((p) => projectCardHtml(p)).join('') ||
        '<div class="empty">No projects yet.</div>'}
    </div>
    <div id="project-detail"></div>`;

  $('#new-project-btn')?.addEventListener('click', showNewProjectModal);

  view.onclick = async (e) => {
    const btn = e.target.closest('button[data-proj-action]');
    if (!btn) return;
    const pid = btn.dataset.id;
    const action = btn.dataset.projAction;
    if (action === 'activity') await showProjectActivity(pid);
    if (action === 'members') location.hash = `#/projects/${pid}/members`;
    if (action === 'edit') showEditProjectModal(pid);
    if (action === 'import') showImportModal(pid, btn.dataset.name);
    if (action === 'delete') showDeleteProjectModal(pid, btn.dataset.name);
  };
}

function showEditProjectModal(projectId) {
  const p = state.me.projects.find((x) => x.id === Number(projectId));
  if (!p) return;
  const m = openModal(`
    <h2>Edit project</h2>
    <form id="edit-project-form">
      <label class="field"><span>Project name</span>
        <input type="text" name="name" required value="${esc(p.name)}"></label>
      <label class="field"><span>Dialect / community</span>
        <input type="text" name="dialect" value="${esc(p.dialect ?? '')}"></label>
      <label class="field"><span>Description</span>
        <input type="text" name="description" value="${esc(p.description ?? '')}"></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit">Save changes</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#edit-project-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/projects/${projectId}`, {
        method: 'PATCH',
        body: { name: f.name.value, dialect: f.dialect.value, description: f.description.value },
      });
      closeModal();
      toast('Project updated');
      await loadMe();
      renderDashboard();
    } catch (err) { showFormError(f, err.message); }
  });
}

function showDeleteProjectModal(projectId, projectName) {
  const m = openModal(`
    <h2 style="color:var(--danger)">Delete project</h2>
    <p>This permanently deletes <b>${esc(projectName)}</b> — every entry, every audio
      recording, and all member access. <b>This cannot be undone.</b></p>
    <form id="delete-project-form">
      <label class="field"><span>Type the project name to confirm</span>
        <input type="text" name="confirm_name" required autocomplete="off"
          placeholder="${esc(projectName)}"></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit" class="danger">Delete project forever</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#delete-project-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/projects/${projectId}`, {
        method: 'DELETE',
        body: { confirm_name: f.confirm_name.value },
      });
      closeModal();
      toast(`Project deleted (${r.deleted_entries} entries, ${r.deleted_recordings} recordings removed)`);
      await loadMe();
      renderDashboard();
    } catch (err) { showFormError(f, err.message); }
  });
}

function showImportModal(projectId, projectName) {
  const m = openModal(`
    <h2>Import CSV — ${esc(projectName)}</h2>
    <p style="color:var(--muted);font-size:0.9rem">
      A CSV with two text columns: Dene and English, plus an optional third
      <b>Category</b> column. A header row like <code>dene_text,english_text,category</code>
      (or "Dene Text","English Text","Category") is used if present; otherwise the
      columns are taken in that order. Rows already in the project and duplicates
      within the file are skipped, so re-importing the same file is safe.
      Max 10,000 rows per file.</p>
    <form id="import-form">
      <label class="field"><span>CSV file</span>
        <input type="file" name="file" accept=".csv,.txt,text/csv" required></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit" id="import-submit">Import</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#import-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData();
    fd.append('file', f.file.files[0]);
    const btn = $('#import-submit', m);
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const r = await api(`/projects/${projectId}/import`, { method: 'POST', body: fd });
      closeModal();
      const parts = [`Imported ${r.imported} entries`];
      if (r.skipped_duplicates) parts.push(`${r.skipped_duplicates} duplicates skipped`);
      if (r.skipped_invalid) parts.push(`${r.skipped_invalid} incomplete rows skipped`);
      toast(parts.join(' · '));
      renderDashboard();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Import';
      showFormError(f, err.message);
    }
  });
}

function projectCardHtml(p) {
  const hours = (p.audio_seconds || 0) / 3600;
  const pct = Math.min(100, (hours / TARGET_HOURS) * 100);
  const admin = isAdminOf(p.id);
  return `
    <div class="card project-card">
      <h2>${esc(p.name)}</h2>
      <div class="dialect">${esc(p.dialect ?? '')}${p.description ? ` · ${esc(p.description)}` : ''}</div>
      <div class="stat-numbers">
        <div><div class="num">${p.entry_count}</div><div class="lbl">Entries</div></div>
        <div><div class="num">${p.audio_count}</div><div class="lbl">Recordings</div></div>
        <div><div class="num">${fmtHours(p.audio_seconds)}</div><div class="lbl">Audio hrs</div></div>
      </div>
      <div class="progress"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="progress-label">${hours.toFixed(2)} / ${TARGET_HOURS} hrs toward transcription goal</div>
      <div class="card-actions">
        <button class="ghost small" data-proj-action="activity" data-id="${p.id}">Recent activity</button>
        ${admin ? `
          <button class="ghost small" data-proj-action="members" data-id="${p.id}">Members</button>
          <a class="btn secondary small" style="padding:0.25rem 0.6rem;font-size:0.85rem" href="/api/projects/${p.id}/export?format=csv">Export CSV</a>
          <a class="btn secondary small" style="padding:0.25rem 0.6rem;font-size:0.85rem" href="/api/projects/${p.id}/export?format=json">Export JSON</a>` : ''}
        ${state.me.user.is_superadmin ? `
          <button class="ghost small" data-proj-action="edit" data-id="${p.id}">Edit</button>
          <button class="ghost small" data-proj-action="import" data-id="${p.id}" data-name="${esc(p.name)}">Import CSV</button>
          <button class="danger small" data-proj-action="delete" data-id="${p.id}" data-name="${esc(p.name)}">Delete</button>` : ''}
      </div>
    </div>`;
}

async function showProjectActivity(projectId) {
  const target = $('#project-detail');
  target.innerHTML = '<div class="card">Loading…</div>';
  try {
    const s = await api(`/projects/${projectId}/stats`);
    const pname = esc(state.me.projects.find((p) => p.id === Number(projectId))?.name ?? 'Project');
    target.innerHTML = `
      <div class="card">
        <h2 style="margin-top:0">${pname} — recent activity</h2>
        ${s.recent.length ? `<ul class="recent-list">
          ${s.recent.map((r) => `
            <li><a href="#/entries/${r.id}"><b>${esc(r.dene_text)}</b></a> — ${esc(r.english_text)}
              <div class="when">edited by ${esc(r.updated_by_name)} · ${fmtDate(r.updated_at)}</div></li>`).join('')}
        </ul>` : '<p style="color:var(--muted)">No entries yet.</p>'}
        ${s.contributors.length ? `
          <h3>Contributors</h3>
          <ul class="recent-list">
            ${s.contributors.map((c) => `<li>${esc(c.name)} — ${c.entry_count} entries</li>`).join('')}
          </ul>` : ''}
      </div>`;
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) { target.innerHTML = `<div class="card error-msg">${esc(err.message)}</div>`; }
}

function showNewProjectModal() {
  const m = openModal(`
    <h2>New project</h2>
    <form id="proj-form">
      <label class="field"><span>Project name</span>
        <input type="text" name="name" required placeholder="e.g. Sahtú Got'ı̨nę Yatı̨́"></label>
      <label class="field"><span>Dialect / community</span>
        <input type="text" name="dialect" placeholder="e.g. North Slavey — Délı̨nę"></label>
      <label class="field"><span>Description</span>
        <input type="text" name="description"></label>
      <p class="error-msg" hidden></p>
      <div class="form-actions">
        <button type="submit">Create project</button>
        <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
      </div>
    </form>`);
  $('#proj-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/projects', {
        method: 'POST',
        body: { name: f.name.value, dialect: f.dialect.value, description: f.description.value },
      });
      closeModal();
      await loadMe();
      toast('Project created');
      renderDashboard();
    } catch (err) { showFormError(f, err.message); }
  });
}

// ---------------------------------------------------------------------------
// Members view (project admins)
// ---------------------------------------------------------------------------

async function renderMembers(projectId) {
  setActiveNav('dashboard');
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try { data = await api(`/projects/${projectId}/members`); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  const project = state.me.projects.find((p) => p.id === Number(projectId));
  const isSuper = state.me.user.is_superadmin;

  view.innerHTML = `
    <div class="page-head">
      <h1>${esc(project?.name ?? 'Project')} — members</h1>
      <a class="btn secondary" href="#/dashboard">‹ Back to dashboard</a>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Entries</th><th>Added</th><th></th></tr></thead>
        <tbody>
          ${data.members.map((mb) => `
            <tr>
              <td>${esc(mb.name)}</td>
              <td>${esc(mb.email)}</td>
              <td><span class="badge">${{ admin: 'Project admin', translator: 'Translator' }[mb.role] ?? 'Member'}</span></td>
              <td>${mb.entry_count}</td>
              <td>${fmtDate(mb.created_at)}</td>
              <td>${mb.role === 'admin' && !isSuper ? '' :
                `<button class="danger small" data-remove="${mb.id}">Remove</button>`}</td>
            </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No members yet.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Add a member</h2>
      <p style="color:var(--muted);font-size:0.9rem;margin-top:-0.5rem">
        If the email already has an account, it will simply be added to this project.
        Otherwise fill in a name — they’ll get an invite email with a link to set
        their own password (or set a temporary password here instead).</p>
      <form id="add-member-form">
        <div class="form-row">
          <label class="field"><span>Email</span>
            <input type="email" name="email" required></label>
          <label class="field"><span>Name (for new accounts)</span>
            <input type="text" name="name"></label>
          <label class="field"><span>Temporary password (optional)</span>
            <input type="text" name="password" minlength="8" autocomplete="off"
              placeholder="blank = email an invite"></label>
          <label class="field"><span>Role</span>
            <select name="role">
              <option value="member">Member</option>
              <option value="translator">Translator</option>
              ${isSuper ? '<option value="admin">Project admin</option>' : ''}
            </select></label>
        </div>
        <p class="error-msg" hidden></p>
        <button type="submit">Add member</button>
      </form>
    </div>`;

  $('#add-member-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/projects/${projectId}/members`, {
        method: 'POST',
        body: {
          email: f.email.value,
          name: f.name.value || undefined,
          password: f.password.value || undefined,
          role: f.role?.value || 'member',
        },
      });
      if (r.invite_link && !r.invite_sent) {
        prompt('Member added, but the invite email could not be sent.\nCopy this set-password link and share it with them:', r.invite_link);
      } else {
        toast(r.invite_sent ? 'Member added — invite email sent' : 'Member added');
      }
      renderMembers(projectId);
    } catch (err) { showFormError(f, err.message); }
  });

  view.onclick = async (e) => {
    const btn = e.target.closest('button[data-remove]');
    if (!btn) return;
    if (!confirm('Remove this member from the project? Their past entries stay attributed to them, but they lose access immediately.')) return;
    try {
      await api(`/projects/${projectId}/members/${btn.dataset.remove}`, { method: 'DELETE' });
      toast('Member removed');
      renderMembers(projectId);
    } catch (err) { toast(err.message, true); }
  };
}

// ---------------------------------------------------------------------------
// Users view (superadmin)
// ---------------------------------------------------------------------------

async function renderUsers() {
  setActiveNav('users');
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try { data = await api('/users'); }
  catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  view.innerHTML = `
    <div class="page-head">
      <h1>Users</h1>
      <button id="new-user-btn">＋ New account</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Projects</th><th>Entries</th><th>Recordings</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${data.users.map((u) => `
            <tr>
              <td>${esc(u.name)} ${u.is_superadmin ? '<span class="badge">Superadmin</span>' : ''}</td>
              <td>${esc(u.email)}</td>
              <td>${esc(u.memberships ?? '—')}</td>
              <td>${u.entry_count}</td>
              <td>${u.audio_count}</td>
              <td>${fmtDate(u.created_at)}</td>
              <td style="white-space:nowrap">
                <button class="ghost small" data-act="reset" data-id="${u.id}" data-name="${esc(u.name)}">Reset password</button>
                ${u.id === state.me.user.id ? '' : `
                  <button class="ghost small" data-act="super" data-id="${u.id}" data-super="${u.is_superadmin}">
                    ${u.is_superadmin ? 'Revoke superadmin' : 'Make superadmin'}</button>
                  <button class="danger small" data-act="delete" data-id="${u.id}" data-name="${esc(u.name)}">Delete</button>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p style="color:var(--muted);font-size:0.85rem;margin-bottom:0">
        Accounts with contributions can't be deleted (attribution is preserved) — remove them
        from their projects instead, which revokes all access. Project membership is managed
        from each project's <a href="#/dashboard">Dashboard</a> card.</p>
    </div>`;

  $('#new-user-btn').addEventListener('click', () => {
    const m = openModal(`
      <h2>New account</h2>
      <p style="color:var(--muted);font-size:0.9rem">The account starts with no project access —
        add it to a project from the Dashboard → Members.</p>
      <form id="user-form">
        <label class="field"><span>Name</span><input type="text" name="name" required></label>
        <label class="field"><span>Email</span><input type="email" name="email" required></label>
        <label class="field"><span>Temporary password (optional)</span>
          <input type="text" name="password" minlength="8" autocomplete="off"
            placeholder="blank = email an invite link"></label>
        <p class="error-msg" hidden></p>
        <div class="form-actions">
          <button type="submit">Create account</button>
          <button type="button" class="ghost" onclick="document.querySelector('.modal-backdrop').remove()">Cancel</button>
        </div>
      </form>`);
    $('#user-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const r = await api('/users', {
          method: 'POST',
          body: { name: f.name.value, email: f.email.value, password: f.password.value || undefined },
        });
        closeModal();
        if (r.invite_link && !r.invite_sent) {
          prompt('Account created, but the invite email could not be sent.\nCopy this set-password link and share it with them:', r.invite_link);
        } else {
          toast(r.invite_sent ? 'Account created — invite email sent' : 'Account created');
        }
        renderUsers();
      } catch (err) { showFormError(f, err.message); }
    });
  });

  view.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.dataset.act === 'reset') {
      const pw = prompt(`New temporary password for ${btn.dataset.name} (min 8 characters):`);
      if (pw === null) return;
      try {
        await api(`/users/${id}`, { method: 'PATCH', body: { password: pw } });
        toast('Password reset — they are signed out everywhere');
      } catch (err) { toast(err.message, true); }
    } else if (btn.dataset.act === 'super') {
      const makeSuper = btn.dataset.super !== '1';
      if (!confirm(makeSuper
        ? 'Grant superadmin? They will have full access to every project and all user management.'
        : 'Revoke superadmin access for this user?')) return;
      try {
        await api(`/users/${id}`, { method: 'PATCH', body: { is_superadmin: makeSuper } });
        toast(makeSuper ? 'Superadmin granted' : 'Superadmin revoked');
        renderUsers();
      } catch (err) { toast(err.message, true); }
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`Delete the account for ${btn.dataset.name}? This cannot be undone.`)) return;
      try {
        await api(`/users/${id}`, { method: 'DELETE' });
        toast('Account deleted');
        renderUsers();
      } catch (err) { toast(err.message, true); }
    }
  };
}

// ---------------------------------------------------------------------------
// Router & boot
// ---------------------------------------------------------------------------

async function loadMe() {
  state.me = await api('/me');
  if (!state.me.projects.some((p) => p.id === state.activeProjectId)) {
    state.activeProjectId = state.me.projects[0]?.id ?? null;
  }
  renderTopbar();
}

function route() {
  view.onclick = null; // clear any per-view delegated handler
  if (Recorder.session) Recorder.cancel(); // navigating away releases the mic
  const hash = location.hash || '#/entries';
  let m;
  // Views that work without a session:
  if ((m = hash.match(/^#\/set-password\/([a-f0-9]{64})$/))) { renderSetPassword(m[1]); return; }
  if (hash === '#/forgot') { renderForgot(); return; }
  if (hash === '#/request') { renderRequestStart(); return; }
  if ((m = hash.match(/^#\/request\/([a-f0-9]{64})$/))) { renderRequestForm(m[1]); return; }
  if (!state.me) { renderLogin(); return; }
  if (isTranslator()) {
    // Translators see only their dashboard and the recording session.
    if (hash === '#/record') renderRecordSession();
    else if (hash === '#/dashboard') renderTranslatorDashboard();
    else location.hash = '#/dashboard';
    return;
  }
  if (hash === '#/entries') renderEntries();
  else if (hash === '#/entries/new') renderNewEntry();
  else if ((m = hash.match(/^#\/entries\/(\d+)$/))) renderEntryDetail(m[1]);
  else if (hash === '#/dashboard') renderDashboard();
  else if (hash === '#/users' && state.me.user.is_superadmin) renderUsers();
  else if (hash === '#/jobs' && state.me.user.is_superadmin) renderJobs();
  else if ((m = hash.match(/^#\/jobs\/(\d+)$/)) && state.me.user.is_superadmin) renderJobDetail(m[1]);
  else if ((m = hash.match(/^#\/projects\/(\d+)\/members$/))) renderMembers(m[1]);
  else { location.hash = '#/entries'; }
}

window.addEventListener('hashchange', route);

(async function boot() {
  // Public views (set-password, forgot, request) must render even with no session.
  const publicView = /^#\/(set-password\/|forgot$|request)/.test(location.hash);
  try {
    await loadMe();
    route();
  } catch {
    if (publicView) route();
    // otherwise: not signed in — renderLogin already shown by api()
  }
})();
