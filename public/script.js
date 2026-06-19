document.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('.topbar');
  if (header) {
    window.addEventListener('scroll', () => {
      header.style.boxShadow = window.scrollY > 10 ? '0 15px 30px rgba(15, 23, 42, 0.06)' : 'none';
    });
  }

  updateNavAuth();
  initAppNav();
  initAppSidebar();
  if (document.body.dataset.page === 'dashboard') {
    refreshDashboardAiBanner();
    initAiSetupModal();
  }

  const links = document.querySelectorAll('.nav-links a[href^="#"]');
  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = document.querySelector(link.getAttribute('href'));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
});

// BipoAi mock client utilities
function formatApiError(msg) {
  const lower = (msg || '').toLowerCase();
  if (lower.includes('invalid authentication') || lower.includes('401') || lower.includes('access_token_type_unsupported')) {
    return 'Gemini API key is not working. Use an AIzaSy... key from https://aistudio.google.com/apikey — AQ. keys may not work on all accounts yet.';
  }
  return msg || 'Request failed';
}

async function parseApiResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  const raw = await res.text();
  let data = null;

  if (contentType.includes('application/json') || raw.trimStart().startsWith('{')) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('Server returned invalid JSON. Restart the app server and try again.');
    }
  } else if (raw.trimStart().startsWith('<')) {
    if (res.status === 404) {
      throw new Error('Study link API is unavailable. Restart the server (npm start) and try again.');
    }
    throw new Error('Server returned an HTML error page instead of data. Check that npm start is running.');
  } else {
    throw new Error(raw.slice(0, 180) || 'Request failed');
  }

  if (!res.ok) {
    let msg = data.error || 'Request failed';
    try {
      const nested = JSON.parse(msg);
      msg = nested?.error?.message || msg;
    } catch (e) {
      /* plain string error */
    }
    throw new Error(formatApiError(msg));
  }
  return data;
}

function renderEnvChecklist(envCheck) {
  const list = document.getElementById('ai-setup-env-list');
  if (!list || !envCheck?.variables) return;
  const labels = {
    GEMINI_API_KEY: 'GEMINI_API_KEY',
    SUPABASE_URL: 'SUPABASE_URL',
    SUPABASE_SERVICE_ROLE_KEY: 'SUPABASE_SERVICE_ROLE_KEY',
    SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
    SESSION_SECRET: 'SESSION_SECRET'
  };
  list.hidden = false;
  list.innerHTML = Object.entries(labels).map(([key, label]) => {
    const ok = Boolean(envCheck.variables[key]);
    return `<li class="${ok ? 'is-ok' : 'is-missing'}"><span>${label}</span><span>${ok ? '✓ set' : '✗ missing'}</span></li>`;
  }).join('');
  if (envCheck.hint) {
    list.innerHTML += `<li class="is-missing" style="margin-top:0.4rem;font-family:inherit">${envCheck.hint}</li>`;
  }
}

async function refreshDashboardAiBanner() {
  const banner = document.getElementById('study-ai-banner');
  if (!banner || document.body.dataset.page !== 'dashboard') return false;
  try {
    const status = await fetch('/api/gemini/status').then((r) => r.json());
    if (status.connected) {
      banner.hidden = true;
      return true;
    }
    banner.hidden = false;
    if (status.reason === 'no_key') {
      banner.textContent = 'AI is off on bipoai.com. Add GEMINI_API_KEY in Vercel (AIzaSy… from aistudio.google.com/apikey), then Redeploy.';
    } else if (status.reason === 'auth') {
      banner.textContent = status.message || 'Gemini key rejected. Use an AIzaSy… key from aistudio.google.com/apikey.';
    } else {
      banner.textContent = status.message || 'Gemini is not connected on this server.';
    }
    return false;
  } catch {
    return false;
  }
}

function initAiSetupModal() {
  if (document.body.dataset.page !== 'dashboard') return;
  const modal = document.getElementById('ai-setup-modal');
  if (!modal) return;
  const statusEl = document.getElementById('ai-setup-status');
  const descEl = document.getElementById('ai-setup-desc');
  const recheckBtn = document.getElementById('ai-setup-recheck');
  const dismissKey = 'bipai.aiSetupDismissed';

  function openModal() {
    if (sessionStorage.getItem(dismissKey) === '1') return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }

  function closeModal() {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    sessionStorage.setItem(dismissKey, '1');
  }

  modal.querySelectorAll('[data-ai-setup-close]').forEach((el) => {
    el.addEventListener('click', closeModal);
  });

  recheckBtn?.addEventListener('click', async () => {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = 'Reconnecting…';
      statusEl.classList.remove('is-error');
    }
    let envCheck = null;
    try {
      envCheck = await fetch('/api/env/check').then((r) => r.json());
      renderEnvChecklist(envCheck);
    } catch { /* ignore */ }
    try {
      await fetch('/api/gemini/reconnect', { method: 'POST' });
    } catch { /* ignore */ }
    const ok = await refreshDashboardAiBanner();
    if (ok) {
      closeModal();
      sessionStorage.removeItem(dismissKey);
      if (statusEl) statusEl.textContent = 'Gemini connected. You can generate real notes now.';
    } else if (statusEl) {
      const missing = envCheck?.variables
        ? Object.entries(envCheck.variables).filter(([, v]) => !v).map(([k]) => k)
        : [];
      statusEl.textContent = missing.length
        ? `Still missing on server: ${missing.join(', ')}. Add in Vercel → Redeploy.`
        : 'Variables set but Gemini not connected. Try an AIzaSy… key, then Redeploy.';
      statusEl.classList.add('is-error');
    }
  });

  Promise.all([
    fetch('/api/gemini/status').then((r) => r.json()),
    fetch('/api/env/check').then((r) => r.json()).catch(() => null)
  ]).then(([status, envCheck]) => {
    if (envCheck) renderEnvChecklist(envCheck);
    if (status.connected) return;
    if (descEl && status.reason === 'auth') {
      descEl.textContent = 'Your API key is set but rejected. Use an AIzaSy… key from Google AI Studio.';
    } else if (descEl && envCheck && !envCheck.variables?.GEMINI_API_KEY) {
      descEl.textContent = 'The server sees zero env vars. You must add them in Vercel (not just locally in .env), then Redeploy.';
    }
    openModal();
  }).catch(() => openModal());
}

const PENDING_STUDY_KEY = 'bipai.pendingStudy';

function exitDashboardStudyView() {
  document.body.classList.remove('study-has-session');
  const workspaceEl = document.getElementById('study-workspace');
  const resultsEl = document.getElementById('study-results');
  if (workspaceEl) workspaceEl.hidden = true;
  if (resultsEl) resultsEl.hidden = true;
  const url = new URL(window.location.href);
  if (url.searchParams.has('session')) {
    url.searchParams.delete('session');
    history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }
}

function notifyDashboardPanelChange(panelKey) {
  window.dispatchEvent(new CustomEvent('bipai:dashboard-panel', { detail: { panel: panelKey } }));
}

function slimStudySessionForStorage(payload, { aggressive = false } = {}) {
  const clone = JSON.parse(JSON.stringify(payload));
  const audio = clone.data?.podcast?.audio;
  if (audio?.audioBase64) {
    if (audio.audioUrl) delete audio.audioBase64;
    else delete clone.data.podcast.audio;
  }
  if (clone.data?.sourceText?.length > 4000) {
    clone.data.sourceText = clone.data.sourceText.slice(0, 4000);
  }
  if (aggressive && clone.data) {
    delete clone.data.sourceText;
    const podcast = clone.data.podcast;
    if (podcast?.script?.length > 12) podcast.script = podcast.script.slice(0, 12);
    if (podcast?.segments?.length > 8) podcast.segments = podcast.segments.slice(0, 8);
  }
  return clone;
}

function slimSessionForDb(session) {
  const clone = JSON.parse(JSON.stringify(session));
  const audio = clone.podcast?.audio;
  if (audio?.audioBase64 && audio?.audioUrl) delete audio.audioBase64;
  if (clone.inputText?.length > 50000) clone.inputText = clone.inputText.slice(0, 50000);
  if (clone.sourceText?.length > 50000) clone.sourceText = clone.sourceText.slice(0, 50000);
  return clone;
}

function inputTypeFromMode(mode) {
  if (mode === 'audio') return 'audio';
  if (mode === 'url') return 'url';
  if (mode === 'text') return 'text';
  return 'files';
}

function setPendingStudy(payload) {
  const attempts = [
    () => slimStudySessionForStorage(payload),
    () => slimStudySessionForStorage(payload, { aggressive: true })
  ];
  let lastError = null;
  for (const build of attempts) {
    try {
      sessionStorage.setItem(PENDING_STUDY_KEY, JSON.stringify(build()));
      return;
    } catch (err) {
      lastError = err;
      if (!/quota/i.test(String(err?.name || err?.message))) throw err;
    }
  }
  throw new Error(
    'This study session is too large to open in Ai Study +. Try again with podcast turned off, or use a smaller upload.'
  );
}

function takePendingStudy() {
  const raw = sessionStorage.getItem(PENDING_STUDY_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PENDING_STUDY_KEY);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function bindAutoGrowTextarea(el) {
  if (!el || el.dataset.autoGrow === '1') return;
  el.dataset.autoGrow = '1';
  const resize = () => {
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 136)}px`;
  };
  el.addEventListener('input', resize);
  resize();
}

function initAutoGrowTextareas(root = document) {
  root.querySelectorAll('.solver-problem-input').forEach(bindAutoGrowTextarea);
}

/* Supabase-backed storage (falls back to localStorage when DB is off) */
let _dataReady = false;
let _sessionsCache = null;
let _decksCache = null;
let _foldersCache = null;
let _dbEnabled = null;

function getGuestId() {
  let id = localStorage.getItem('bipai.guestId');
  if (!id) {
    id = `guest-${crypto.randomUUID()}`;
    localStorage.setItem('bipai.guestId', id);
  }
  return id;
}

function getStorageOwnerId() {
  const user = getCurrentUser();
  if (user?.id) return String(user.id);
  return getGuestId();
}

function userDataKey(kind) {
  return `bipai.${getStorageOwnerId()}.${kind}`;
}

function resetUserDataCache() {
  _dataReady = false;
  _sessionsCache = null;
  _decksCache = null;
  _foldersCache = null;
}

function authApiHeaders(json = true) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  const token = localStorage.getItem('bipai.token');
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers['X-Guest-Id'] = getGuestId();
  return headers;
}

async function apiDataFetch(path, options = {}) {
  const useJson = options.body && !(options.body instanceof FormData);
  const res = await fetch(path, {
    ...options,
    headers: { ...authApiHeaders(useJson), ...options.headers }
  });
  return parseApiResponse(res);
}

async function checkDatabase() {
  if (_dbEnabled !== null) return _dbEnabled;
  try {
    const data = await fetch('/api/db/status').then((r) => r.json());
    _dbEnabled = Boolean(data.ok);
  } catch {
    _dbEnabled = false;
  }
  return _dbEnabled;
}

async function refreshAllData() {
  if (!(await checkDatabase())) {
    try { _sessionsCache = JSON.parse(localStorage.getItem(userDataKey('sessions')) || '[]'); } catch { _sessionsCache = []; }
    try { _decksCache = JSON.parse(localStorage.getItem(userDataKey('decks')) || '[]'); } catch { _decksCache = []; }
    try { _foldersCache = JSON.parse(localStorage.getItem(userDataKey('folders')) || '[]'); } catch { _foldersCache = []; }
    _dataReady = true;
    return;
  }
  try {
    const [sessions, decks, folders] = await Promise.all([
      apiDataFetch('/api/sessions').then((d) => d.sessions || []),
      apiDataFetch('/api/decks').then((d) => d.decks || []),
      apiDataFetch('/api/folders').then((d) => d.folders || [])
    ]);
    _sessionsCache = sessions;
    _decksCache = decks;
    _foldersCache = folders;
  } catch (err) {
    console.warn('Data refresh:', err.message);
  }
  _dataReady = true;
}

async function migrateGuestToUser() {
  const guestId = localStorage.getItem('bipai.guestId');
  if (!guestId || !localStorage.getItem('bipai.token')) return;
  try {
    await apiDataFetch('/api/auth/migrate-guest', { method: 'POST', body: JSON.stringify({ guestId }) });
  } catch (e) { /* ignore */ }
}

async function ensureDataReady() {
  if (!_dataReady) await refreshAllData();
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  return parseApiResponse(res);
}

async function uploadAudio(file) {
  const fd = new FormData();
  fd.append('audio', file);
  const res = await fetch('/api/audio', { method: 'POST', body: fd });
  return parseApiResponse(res);
}

async function uploadNotesFiles(files) {
  const fd = new FormData();
  files.forEach((file) => fd.append('files', file));
  const res = await fetch('/api/notes', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

async function uploadNotesFile(file) {
  return uploadNotesFiles([file]);
}

const SMART_UPLOAD_ACCEPT = [
  'image/*',
  '.pdf', '.doc', '.docx', '.txt', '.md', '.rtf',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic',
  '.ppt', '.pptx', '.xls', '.xlsx', '.csv',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
].join(',');

function detectFileType(file) {
  const name = (file.name || file.originalname || '').toLowerCase();
  const mime = (file.type || file.mimetype || '').toLowerCase();

  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(name)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (
    mime.includes('word') ||
    mime === 'application/msword' ||
    /\.(docx?|rtf)$/i.test(name)
  ) return 'word';
  if (
    mime.includes('presentation') ||
    mime.includes('powerpoint') ||
    /\.(pptx?|odp)$/i.test(name)
  ) return 'slides';
  if (
    mime.includes('sheet') ||
    mime.includes('excel') ||
    mime === 'text/csv' ||
    /\.(xlsx?|csv)$/i.test(name)
  ) return 'spreadsheet';
  if (mime.startsWith('text/') || /\.(txt|md)$/i.test(name)) return 'text';
  if (mime.startsWith('audio/') || /\.(mp3|m4a|wav|ogg)$/i.test(name)) return 'audio';
  return 'document';
}

function fileTypeLabel(type) {
  const labels = {
    image: 'Image',
    pdf: 'PDF',
    word: 'Word',
    slides: 'Slides',
    spreadsheet: 'Sheet',
    text: 'Text',
    audio: 'Audio',
    document: 'Document'
  };
  return labels[type] || 'File';
}

async function generateNotesFromText(text) {
  const res = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  return parseApiResponse(res);
}

async function generateQuizFromText(text) {
  const res = await fetch('/api/quiz', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text})});
  return parseApiResponse(res);
}

async function generatePodcast({ text, title, style }) {
  const res = await fetch('/api/podcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, title, style })
  });
  return parseApiResponse(res);
}

async function solveProblem(problem, subject = 'auto') {
  const res = await fetch('/api/solve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ problem, subject })});
  return parseApiResponse(res);
}

function renderSolverResult(container, data) {
  const esc = (t) => String(t ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (data.error) {
    container.innerHTML = `<p class="study-error">${esc(data.error)}</p>`;
    return;
  }
  const solution = data.solution || {};
  const givenList = (solution.given || []).length
    ? `<ul class="study-solver-given-list">${solution.given.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
    : '';
  const steps = (solution.steps || []).map((step) => `
    <div class="study-step">
      <strong>Step ${step.step}: ${esc(step.title)}</strong>
      <p>${esc(step.detail)}</p>
    </div>`).join('');
  container.innerHTML = `
    <div class="study-solver-card">
      <div class="study-solver-head">
        <h4>${esc(solution.title || 'Solution')}</h4>
      </div>
      ${solution.question ? `<div class="study-solver-block"><span class="study-solver-label">Question</span><p>${esc(solution.question)}</p></div>` : ''}
      ${givenList ? `<div class="study-solver-block"><span class="study-solver-label">Given</span>${givenList}</div>` : ''}
      ${solution.formula ? `<div class="study-solver-block"><span class="study-solver-label">Formula</span><p class="study-solver-formula">${esc(solution.formula)}</p></div>` : ''}
      ${steps ? `<div class="study-solver-block"><span class="study-solver-label">Steps</span><div class="study-solver-steps">${steps}</div></div>` : ''}
      <div class="study-solver-answer">
        <span class="study-solver-answer-label">Final answer</span>
        <strong class="study-solver-answer-value">${esc(solution.answer || 'See steps above')}</strong>
      </div>
    </div>`;
}

async function problemTextFromFiles(files) {
  const textFiles = files.filter((file) => detectFileType(file) === 'text');
  const richFiles = files.filter((file) => detectFileType(file) !== 'text');
  const textParts = [];
  for (const file of textFiles) {
    const text = (await file.text()).trim();
    if (text) textParts.push(text);
  }
  if (richFiles.length) {
    const notesData = await uploadNotesFiles(richFiles);
    const bullets = notesData.notes?.bullets || [];
    if (bullets.length) textParts.push(bullets.join(' '));
    else textParts.push(`Solve the problems shown in ${richFiles.map((f) => f.name).join(', ')}`);
  }
  return textParts.join('\n\n').trim();
}

let podcastAudioFetchId = 0;
const podcastBlobUrls = new WeakMap();

function podcastPlayUrl(audio) {
  if (!audio?.audioUrl) return '';
  if (/^https?:\/\//i.test(audio.audioUrl)) return audio.audioUrl;
  return `${window.location.origin}${audio.audioUrl}`;
}

function attachPodcastAudioPlayer(wrap, audio) {
  const player = wrap.querySelector('audio');
  if (!player || !audio) return false;

  if (audio.audioUrl) {
    player.src = podcastPlayUrl(audio);
    player.load();
    return Boolean(player.src);
  }

  if (audio.audioBase64) {
    try {
      const prev = podcastBlobUrls.get(player);
      if (prev) URL.revokeObjectURL(prev);
      const binary = atob(audio.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: audio.mimeType || 'audio/wav' });
      const blobUrl = URL.createObjectURL(blob);
      podcastBlobUrls.set(player, blobUrl);
      player.src = blobUrl;
      player.load();
      return true;
    } catch (err) {
      console.warn('Podcast blob audio:', err);
    }
  }

  return false;
}

function wirePodcastPlayButton(wrap, podcast) {
  const btn = wrap.querySelector('#podcast-play-btn');
  const label = wrap.querySelector('#podcast-play-label');
  const icon = wrap.querySelector('#podcast-play-icon');
  const player = wrap.querySelector('audio');
  if (!btn) return;

  const setIcon = (playing) => {
    if (!icon) return;
    icon.innerHTML = playing
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<path d="M8 5v14l11-7z"/>';
  };

  const updateUi = () => {
    const hasFile = Boolean(player?.src);
    const playing = hasFile && player && !player.paused && !player.ended;
    if (label) {
      if (btn.disabled) label.textContent = 'Preparing audio…';
      else if (!hasFile) label.textContent = 'Play podcast';
      else label.textContent = playing ? 'Pause podcast' : 'Play podcast';
    }
    setIcon(playing);
    btn.setAttribute('aria-label', label?.textContent || 'Play podcast');
  };

  btn.onclick = () => {
    if (btn.disabled) return;
    if (player?.src) {
      if (player.paused || player.ended) {
        player.play().catch(() => speakPodcastInBrowser(podcast));
      } else {
        player.pause();
      }
      return;
    }
    speakPodcastInBrowser(podcast);
  };

  if (player) {
    player.addEventListener('play', updateUi);
    player.addEventListener('pause', updateUi);
    player.addEventListener('ended', updateUi);
    player.addEventListener('error', () => {
      if (label) label.textContent = 'Play podcast';
      btn.disabled = false;
      updateUi();
    });
  }

  updateUi();
}

function setPodcastPlayerState(wrap, { loading = false, message = '', podcast = null, audio = null } = {}) {
  if (!wrap) return;
  wrap.hidden = false;

  const status = wrap.querySelector('#podcast-audio-status');
  const btn = wrap.querySelector('#podcast-play-btn');
  const player = wrap.querySelector('audio');

  if (status) {
    if (message) {
      status.hidden = false;
      status.textContent = message;
      status.classList.toggle('is-loading', loading);
    } else {
      status.hidden = true;
      status.classList.remove('is-loading');
    }
  }

  if (btn) btn.disabled = loading;

  if (audio && attachPodcastAudioPlayer(wrap, audio)) {
    if (player) player.hidden = false;
  } else if (player && !audio) {
    player.removeAttribute('src');
    player.hidden = true;
  }

  if (podcast) wirePodcastPlayButton(wrap, podcast);
}

function showPodcastReady(wrap, audio, podcast) {
  setPodcastPlayerState(wrap, { podcast, audio, message: '' });
}

function showPodcastLoading(wrap, message = 'Preparing podcast audio…') {
  setPodcastPlayerState(wrap, { loading: true, message, podcast: wrap._podcastRef || null });
}

function showPodcastBrowserFallback(wrap, podcast) {
  setPodcastPlayerState(wrap, {
    podcast,
    message: 'AI voices unavailable — tap Play to listen in your browser.'
  });
}

function pickBrowserVoices() {
  const voices = window.speechSynthesis?.getVoices() || [];
  const female = voices.find((v) => /female|samantha|karen|victoria|zira|fiona|moira/i.test(v.name))
    || voices.find((v) => v.lang.startsWith('en') && !/male/i.test(v.name));
  const male = voices.find((v) => /male|daniel|alex|fred|david|james|thomas|guy/i.test(v.name))
    || voices.find((v) => v.lang.startsWith('en') && v !== female);
  return { male: male || voices[0], female: female || voices[1] || voices[0] };
}

function speakPodcastInBrowser(podcast) {
  if (!window.speechSynthesis) {
    alert('Speech playback is not supported in this browser.');
    return;
  }
  window.speechSynthesis.cancel();
  const boy = podcast?.hosts?.[0] || 'Alex';
  const girl = podcast?.hosts?.[1] || 'Sam';
  const { male, female } = pickBrowserVoices();
  const script = podcast?.script || [];
  let index = 0;

  function speakNext() {
    if (index >= script.length) return;
    const line = script[index++];
    const utterance = new SpeechSynthesisUtterance(line.text);
    utterance.voice = line.speaker === girl ? female : male;
    utterance.rate = 0.95;
    utterance.onend = speakNext;
    utterance.onerror = speakNext;
    window.speechSynthesis.speak(utterance);
  }

  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.onvoiceschanged = null;
      speakNext();
    };
  } else {
    speakNext();
  }
}

async function loadPodcastAudio(container, podcast, fetchId) {
  const wrap = container.querySelector('#podcast-audio-wrap');
  if (!wrap) return;

  wrap._podcastRef = podcast;
  showPodcastLoading(wrap);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const data = await fetch('/api/podcast/audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ podcast }),
      signal: controller.signal
    }).then((res) => parseApiResponse(res));

    if (fetchId !== podcastAudioFetchId) return;

    if (data.audio?.audioUrl || data.audio?.audioBase64) {
      const episode = data.podcast || podcast;
      container._podcastData = episode;
      wrap._podcastRef = episode;
      showPodcastReady(wrap, data.audio, episode);
      return;
    }

    showPodcastBrowserFallback(wrap, podcast);
  } catch (err) {
    if (fetchId !== podcastAudioFetchId) return;
    console.warn('Podcast audio:', err.message);
    showPodcastBrowserFallback(wrap, podcast);
  } finally {
    clearTimeout(timeoutId);
  }
}

function renderPodcastResult(container, data) {
  const esc = (t) => String(t ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const podcast = data.podcast || data;
  const fetchId = ++podcastAudioFetchId;
  const hosts = podcast.hosts || ['Alex', 'Sam'];
  const hasAudio = podcast.audio?.audioUrl || podcast.audio?.audioBase64;

  container.innerHTML = `
    <h3 class="study-podcast-title">${esc(podcast.title || 'Study podcast')}</h3>
    <p class="study-result-meta study-podcast-meta">${esc(podcast.duration || '—')} · ${esc(podcast.styleLabel || podcast.style || 'Conversational')} · Hosts: ${esc(hosts.join(' & '))}</p>
    ${podcast.description ? `<p class="study-podcast-desc">${esc(podcast.description)}</p>` : ''}
    <div class="study-podcast-audio-minimal" id="podcast-audio-wrap">
      <button type="button" class="button button-primary study-podcast-play-btn" id="podcast-play-btn" aria-label="Play podcast">
        <svg class="study-podcast-play-icon" id="podcast-play-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        <span id="podcast-play-label">${hasAudio ? 'Play podcast' : 'Preparing audio…'}</span>
      </button>
      <p class="study-podcast-audio-status${hasAudio ? '' : ' is-loading'}" id="podcast-audio-status"${hasAudio ? ' hidden' : ''}>Preparing podcast audio…</p>
      <audio class="study-podcast-player-minimal" controls playsinline preload="auto" hidden></audio>
    </div>`;

  const wrap = container.querySelector('#podcast-audio-wrap');
  wrap._podcastRef = podcast;
  container._podcastData = podcast;

  if (hasAudio) {
    showPodcastReady(wrap, podcast.audio, podcast);
  } else if (podcast.script?.length) {
    showPodcastLoading(wrap);
    loadPodcastAudio(container, podcast, fetchId);
  } else {
    showPodcastBrowserFallback(wrap, podcast);
  }
}

function readGenerateOptions(prefix) {
  const notes = document.getElementById(`${prefix}gen-notes`);
  const flashcards = document.getElementById(`${prefix}gen-flashcards`);
  const podcast = document.getElementById(`${prefix}gen-podcast`);
  return {
    notes: notes ? notes.checked : true,
    flashcards: flashcards ? flashcards.checked : true,
    podcast: podcast ? podcast.checked : true
  };
}

function validateGenerateOptions(generate) {
  if (!generate.notes && !generate.flashcards && !generate.podcast) {
    throw new Error('Select at least one: Notes, Flashcards, or Podcast.');
  }
  return generate;
}

function humanizeSessionFilename(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSessionTitle(userName, data, mode, sourceFiles = []) {
  const given = String(userName || '').trim();
  if (given) return given.slice(0, 80);
  if (data?.sessionName) return String(data.sessionName).slice(0, 80);

  const { notes = {} } = data || {};

  if (mode === 'url' && notes.title) {
    const title = notes.title.trim();
    if (title && title !== 'Study session') return title.slice(0, 80);
  }

  if (mode === 'files' && sourceFiles.length === 1) {
    const name = humanizeSessionFilename(sourceFiles[0].name);
    if (name) return name.slice(0, 80);
  }
  if (mode === 'files' && sourceFiles.length > 1) {
    const first = humanizeSessionFilename(sourceFiles[0].name);
    return (first ? `${first} + ${sourceFiles.length - 1} more` : `${sourceFiles.length} files`).slice(0, 80);
  }

  if (mode === 'audio' && sourceFiles[0]?.name) {
    const name = humanizeSessionFilename(sourceFiles[0].name);
    if (name && !/^recording[-\s]?\d+$/i.test(name)) return name.slice(0, 80);
    return 'Lecture recording';
  }

  if (mode === 'text' && data?.sourceText) {
    const line = data.sourceText.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (line) return line.slice(0, 80);
    return 'Pasted notes';
  }

  const noteTitle = String(notes.title || '').trim();
  if (noteTitle && noteTitle !== 'Study session') {
    return noteTitle.replace(/^Smart notes from\s+/i, '').slice(0, 80);
  }
  if (notes.source) return String(notes.source).slice(0, 80);

  return `Study session — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function loadingMessagesForGenerate(generate, activeMode = 'files') {
  const msgs = [];
  if (activeMode === 'audio') msgs.push('Transcribing your audio…');
  else if (activeMode === 'url') msgs.push('Fetching your link…');
  else msgs.push('Reading your content…');
  if (generate.notes) msgs.push('Writing smart notes…');
  if (generate.flashcards) msgs.push('Building flashcards…');
  if (generate.podcast) msgs.push('Creating podcast voices…');
  return msgs.length ? msgs : ['Working on your session…'];
}

async function createStudySession({ files = [], text = '', url = '', urlType = '', sessionName = '', generate = null }) {
  const gen = generate || { notes: true, flashcards: true, podcast: true };

  if (url) {
    const controller = new AbortController();
    const timeoutMs = 90000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('/api/study/url', {
        method: 'POST',
        headers: authApiHeaders(true),
        body: JSON.stringify({
          url,
          ...(urlType ? { urlType } : {}),
          ...(sessionName ? { sessionName } : {}),
          generate: gen
        }),
        signal: controller.signal
      });
      return parseApiResponse(res);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Generation timed out. Try a shorter link or turn off podcast for faster results.');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const fd = new FormData();
  files.forEach((file) => fd.append('files', file));
  if (text) fd.append('text', text);
  if (sessionName) fd.append('sessionName', sessionName);
  fd.append('generate', JSON.stringify(gen));

  const controller = new AbortController();
  const timeoutMs = 90000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('/api/study', {
      method: 'POST',
      headers: authApiHeaders(false),
      body: fd,
      signal: controller.signal
    });
    return parseApiResponse(res);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Generation timed out. Try a shorter file, paste text, or turn off podcast.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchStudyStage(path, body, timeoutMs = 90000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: authApiHeaders(true),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return parseApiResponse(res);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('This step timed out. Try again with less content or disable podcast.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Generate in stages so notes appear quickly; flashcards and podcast load after. */
async function createStudySessionStaged(params, { onProgress, onPartial } = {}) {
  const gen = params.generate || { notes: true, flashcards: true, podcast: true };
  const outputCount = [gen.notes, gen.flashcards, gen.podcast].filter(Boolean).length;
  if (outputCount <= 1) {
    return createStudySession(params);
  }

  const stage1Gen = {
    notes: gen.notes,
    flashcards: gen.flashcards && !gen.notes,
    podcast: false
  };

  onProgress?.(params.url ? 'Fetching your link…' : gen.notes ? 'Writing smart notes…' : 'Building flashcards…', 15);
  const data = await createStudySession({ ...params, generate: stage1Gen });
  onProgress?.('Notes ready', gen.flashcards || gen.podcast ? 42 : 100);

  const emitPartial = (extra = {}) => {
    if (!onPartial) return;
    const merged = { ...data, ...extra };
    onPartial({
      ...merged,
      _pendingFlashcards: gen.flashcards && !stage1Gen.flashcards && !(merged.flashcards || []).length,
      _pendingPodcast: gen.podcast && !(merged.podcast?.script?.length || merged.podcast?.title)
    });
  };

  emitPartial({
    flashcards: stage1Gen.flashcards ? (data.flashcards || []) : [],
    podcast: {}
  });

  if (gen.flashcards && !stage1Gen.flashcards) {
    onProgress?.('Building flashcards…', 58);
    try {
      const cardsData = await fetchStudyStage('/api/study/flashcards', {
        sourceText: data.sourceText,
        text: params.text || ''
      });
      data.flashcards = cardsData.flashcards || [];
      if (cardsData.usedMockFallback) data.usedMockFallback = true;
      emitPartial({ flashcards: data.flashcards, _pendingFlashcards: false });
      onProgress?.('Flashcards ready', gen.podcast ? 78 : 100);
    } catch (err) {
      data._flashcardsError = err.message;
      emitPartial({ _pendingFlashcards: false });
      onProgress?.('Flashcards skipped', gen.podcast ? 78 : 100);
    }
  }

  if (gen.podcast) {
    onProgress?.('Creating podcast script…', 88);
    try {
      const podData = await fetchStudyStage('/api/podcast', {
        text: data.sourceText || params.text || '',
        title: data.notes?.title || 'Study podcast',
        style: 'conversational'
      });
      data.podcast = podData.podcast || {};
      emitPartial({ podcast: data.podcast, _pendingPodcast: false });
      onProgress?.('All set!', 100);
    } catch (err) {
      data._podcastError = err.message;
      emitPartial({ _pendingPodcast: false });
      onProgress?.('All set!', 100);
    }
  } else {
    onProgress?.('All set!', 100);
  }

  delete data._pendingFlashcards;
  delete data._pendingPodcast;
  return data;
}

async function sendTutorMessage(message, context = '') {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context })
  });
  return parseApiResponse(res);
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('bipai.user') || 'null');
  } catch (e) {
    return null;
  }
}

function setCurrentUser(user, token) {
  localStorage.setItem('bipai.user', JSON.stringify(user));
  if (token) localStorage.setItem('bipai.token', token);
}

function clearCurrentUser() {
  localStorage.removeItem('bipai.user');
  localStorage.removeItem('bipai.token');
}

async function signOutUser() {
  clearCurrentUser();
  resetUserDataCache();
  await refreshAllData();
}

async function signIn(email, password) {
  const res = await fetch('/api/auth/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Sign in failed');
  return data;
}

async function signUp(email, password, name) {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Sign up failed');
  return data;
}

async function signInWithProvider(provider, payload) {
  const res = await fetch(`/api/auth/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Sign in failed');
  return data;
}

async function signInWithDemo(provider, account) {
  const res = await fetch('/api/auth/demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      email: account.email,
      name: account.name
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Sign in failed');
  return data;
}

async function fetchAuthConfig() {
  const res = await fetch('/api/auth/config');
  if (!res.ok) throw new Error('Unable to load sign-in configuration.');
  return res.json();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      if (existing.dataset.loaded === 'true') resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function initAppNav() {
  const page = document.body.dataset.page;
  if (!page) return;

  document.querySelectorAll('.nav-links [data-nav]').forEach((link) => {
    if (link.dataset.nav === page) {
      link.classList.add('is-current');
      link.setAttribute('aria-current', 'page');
    }
  });

  if (page === 'signin') {
    window.location.replace('index.html?signin=1');
  }
}

function updateNavAuth() {
  const signInLink = document.querySelector('.topbar .nav-signin');
  const sidebarUserBtn = document.querySelector('.app-sidebar-user.nav-signin');

  document.querySelector('.topbar .nav-user-wrap')?.remove();
  document.querySelector('.app-sidebar-footer .sidebar-user-actions')?.remove();

  const user = getCurrentUser();

  if (sidebarUserBtn) {
    const nameEl = sidebarUserBtn.querySelector('.sidebar-user-name');
    const emailEl = sidebarUserBtn.querySelector('.sidebar-user-email');
    const avatarEl = sidebarUserBtn.querySelector('.app-sidebar-avatar');

    if (user) {
      sidebarUserBtn.removeAttribute('data-signin-open');
      sidebarUserBtn.type = 'button';
      if (nameEl) nameEl.textContent = user.name || user.email;
      if (emailEl) emailEl.textContent = user.email || 'Signed in';
      if (avatarEl) {
        avatarEl.textContent = (user.name || user.email || '?')
          .split(' ')
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase() || '')
          .join('') || '?';
      }

      const actions = document.createElement('div');
      actions.className = 'sidebar-user-actions';
      const signOutBtn = document.createElement('button');
      signOutBtn.type = 'button';
      signOutBtn.className = 'app-sidebar-signout';
      signOutBtn.setAttribute('aria-label', 'Sign out');
      signOutBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';
      signOutBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await signOutUser();
        window.location.href = 'index.html';
      });
      actions.appendChild(signOutBtn);
      sidebarUserBtn.after(actions);
    } else {
      sidebarUserBtn.setAttribute('data-signin-open', '');
      if (nameEl) nameEl.textContent = 'Sign in';
      if (emailEl) emailEl.textContent = 'Access your account';
      if (avatarEl) avatarEl.textContent = '?';
    }
  }

  if (!signInLink || !user) return;

  const wrap = document.createElement('span');
  wrap.className = 'nav-user-wrap';

  const userLabel = document.createElement('span');
  userLabel.className = 'nav-user';
  userLabel.textContent = user.name || user.email;

  const signOutBtn = document.createElement('button');
  signOutBtn.type = 'button';
  signOutBtn.className = 'nav-signout';
  signOutBtn.textContent = 'Sign out';
  signOutBtn.addEventListener('click', async () => {
    await signOutUser();
    window.location.href = 'index.html';
  });

  wrap.append(userLabel, signOutBtn);
  signInLink.replaceWith(wrap);
}

function initAppSidebar() {
  const sidebar = document.querySelector('.app-sidebar');
  if (!sidebar) return;

  const isDashboard = document.body.dataset.page === 'dashboard';
  const dashPanels = isDashboard ? Array.from(document.querySelectorAll('[data-dash-panel]')) : [];
  const sectionLinks = sidebar.querySelectorAll('[data-sidebar-section]');

  function dashPanelKey(link) {
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('#dashboard-')) return null;
    return href.replace('#dashboard-', '');
  }

  function showDashPanel(key) {
    exitDashboardStudyView();
    dashPanels.forEach((panel) => {
      panel.hidden = panel.dataset.dashPanel !== key;
    });
    sectionLinks.forEach((item) => {
      item.classList.toggle('is-active', dashPanelKey(item) === key);
    });
    history.replaceState(null, '', `#dashboard-${key}`);
    notifyDashboardPanelChange(key);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  sectionLinks.forEach((link) => {
    link.addEventListener('click', (event) => {
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('#')) return;

      if (dashPanels.length) {
        const key = dashPanelKey(link);
        if (key) {
          event.preventDefault();
          showDashPanel(key);
          return;
        }
      }

      const target = document.querySelector(href);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      sectionLinks.forEach((item) => item.classList.toggle('is-active', item === link));
    });
  });

  if (dashPanels.length) {
    const hasSessionView = sessionStorage.getItem(PENDING_STUDY_KEY)
      || new URLSearchParams(location.search).get('session');
    if (!hasSessionView) {
      const hashKey = location.hash.replace('#dashboard-', '');
      const validKeys = dashPanels.map((panel) => panel.dataset.dashPanel);
      showDashPanel(validKeys.includes(hashKey) ? hashKey : 'overview');
    }
    window.addEventListener('hashchange', () => {
      const hashKey = location.hash.replace('#dashboard-', '');
      const validKeys = dashPanels.map((panel) => panel.dataset.dashPanel);
      if (validKeys.includes(hashKey)) showDashPanel(hashKey);
    });
  }

  const searchInput = sidebar.querySelector('.app-sidebar-search input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      sidebar.querySelectorAll('.app-sidebar-nav .app-sidebar-link').forEach((link) => {
        const text = link.textContent.trim().toLowerCase();
        link.style.display = !query || text.includes(query) ? '' : 'none';
      });
    });
  }
}

async function generateStudyFromVideo(url) {
  const res = await fetch('/api/video', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url })});
  return res.json();
}

function downloadAnki() {
  window.location = '/api/export/anki';
}

// Expose for simple testing in browser console
window.bipai = { uploadFile, uploadAudio, uploadNotesFile, uploadNotesFiles, detectFileType, fileTypeLabel, generateNotesFromText, generateQuizFromText, generatePodcast, solveProblem, createStudySession, createStudySessionStaged, sendTutorMessage, signIn, signUp, signInWithProvider, fetchAuthConfig, getCurrentUser, clearCurrentUser, downloadAnki, getFolders, saveFolder, deleteFolder, getDecks, saveDeck, deleteDeck };

// Simple UI binding if upload elements exist
document.addEventListener('DOMContentLoaded', () => {
  const uploader = document.querySelector('#file-upload');
  const out = document.querySelector('#processing-output');
  if (uploader && out) {
    uploader.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      out.innerText = 'Uploading...';
      try {
        const res = await uploadFile(file);
        out.innerText = JSON.stringify(res, null, 2);
        // Save to local deck store
        const deck = { id: 'deck-' + Date.now(), name: file.name, cards: res.items.map((it, i) => ({ id: 'c'+i+'-'+Date.now(), q: it.q, a: it.a, tags: [], ef:2.5, interval:0, repetitions:0, due:Date.now() })) };
        saveDeck(deck);
        alert('Saved mock deck: ' + deck.name + '\nOpen Study > Start Session to review it.');
      } catch (err) {
        out.innerText = 'Error: ' + err.message;
      }
    });
  }
});

/* Deck storage — Supabase API with localStorage fallback */
function getDecks() {
  if (_decksCache) return _decksCache;
  try {
    const stored = localStorage.getItem(userDataKey('decks')) || localStorage.getItem('bipai.decks') || localStorage.getItem('laxu.decks') || '[]';
    return JSON.parse(stored);
  } catch (e) { return []; }
}

async function saveDeck(deck) {
  if (await checkDatabase()) {
    const { deck: saved } = await apiDataFetch('/api/decks', { method: 'POST', body: JSON.stringify(deck) });
    const decks = getDecks().slice();
    const idx = decks.findIndex((d) => d.id === saved.id);
    if (idx >= 0) decks[idx] = saved;
    else decks.push(saved);
    _decksCache = decks;
    return saved;
  }
  const decks = getDecks();
  const idx = decks.findIndex((d) => d.id === deck.id);
  if (idx >= 0) decks[idx] = deck;
  else decks.push(deck);
  localStorage.setItem(userDataKey('decks'), JSON.stringify(decks));
  localStorage.removeItem('bipai.decks');
  localStorage.removeItem('laxu.decks');
  _decksCache = decks;
  return deck;
}

async function deleteDeck(id) {
  if (await checkDatabase()) {
    await apiDataFetch(`/api/decks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    _decksCache = getDecks().filter((d) => d.id !== id);
    return;
  }
  const decks = getDecks().filter((d) => d.id !== id);
  localStorage.setItem(userDataKey('decks'), JSON.stringify(decks));
  localStorage.removeItem('bipai.decks');
  localStorage.removeItem('laxu.decks');
  _decksCache = decks;
}

function getFolders() {
  if (_foldersCache) return _foldersCache;
  try {
    return JSON.parse(localStorage.getItem(userDataKey('folders')) || localStorage.getItem('bipai.folders') || '[]');
  } catch (e) {
    return [];
  }
}

async function saveFolder(folder) {
  if (await checkDatabase()) {
    const { folder: saved } = await apiDataFetch('/api/folders', { method: 'POST', body: JSON.stringify(folder) });
    const folders = getFolders().slice();
    const idx = folders.findIndex((item) => item.id === saved.id);
    if (idx >= 0) folders[idx] = saved;
    else folders.push(saved);
    _foldersCache = folders;
    return saved;
  }
  const folders = getFolders();
  const idx = folders.findIndex((item) => item.id === folder.id);
  if (idx >= 0) folders[idx] = folder;
  else folders.push(folder);
  localStorage.setItem(userDataKey('folders'), JSON.stringify(folders));
  _foldersCache = folders;
  return folder;
}

async function deleteFolder(id) {
  if (await checkDatabase()) {
    await apiDataFetch(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    _foldersCache = getFolders().filter((item) => item.id !== id);
    return;
  }
  localStorage.setItem(userDataKey('folders'), JSON.stringify(getFolders().filter((item) => item.id !== id)));
  _foldersCache = getFolders();
}

async function saveStudySessionToDb(session) {
  const payload = slimSessionForDb(session);
  if (await checkDatabase()) {
    try {
      const { session: saved } = await apiDataFetch('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
      const list = (_sessionsCache || []).slice();
      const idx = list.findIndex((s) => s.id === saved.id);
      if (idx >= 0) list[idx] = saved;
      else list.unshift(saved);
      _sessionsCache = list.slice(0, 50);
      return saved;
    } catch (err) {
      console.warn('Database session save failed:', err.message);
    }
  }
  const key = userDataKey('sessions');
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  list.unshift(payload);
  localStorage.setItem(key, JSON.stringify(list.slice(0, 20)));
  _sessionsCache = list.slice(0, 20);
  return payload;
}

async function deleteStudySessionFromDb(id) {
  if (await checkDatabase()) {
    try {
      await apiDataFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      console.warn('Database session delete failed:', err.message);
      throw err;
    }
  }
  const key = userDataKey('sessions');
  const list = getStudySessionsFromCache().filter((s) => s.id !== id);
  localStorage.setItem(key, JSON.stringify(list));
  _sessionsCache = list;
}

async function fetchStudySessionById(id) {
  const cached = getStudySessionsFromCache().find((s) => s.id === id);
  if (cached) return cached;

  if (!(await checkDatabase())) return null;

  try {
    const { session } = await apiDataFetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!session) return null;
    const list = (_sessionsCache || []).slice();
    const idx = list.findIndex((s) => s.id === session.id);
    if (idx >= 0) list[idx] = session;
    else list.unshift(session);
    _sessionsCache = list.slice(0, 50);
    return session;
  } catch (err) {
    console.warn('Session fetch failed:', err.message);
    return null;
  }
}

function getStudySessionsFromCache() {
  if (_sessionsCache) return _sessionsCache;
  try {
    return JSON.parse(localStorage.getItem(userDataKey('sessions')) || localStorage.getItem('bipai.sessions') || '[]');
  } catch {
    return [];
  }
}

function upsertSessionCache(session) {
  const list = getStudySessionsFromCache().slice();
  const idx = list.findIndex((s) => s.id === session.id);
  if (idx >= 0) list[idx] = session;
  else list.unshift(session);
  _sessionsCache = list.slice(0, 50);
  try {
    localStorage.setItem(userDataKey('sessions'), JSON.stringify(_sessionsCache));
  } catch { /* quota */ }
}

function escapeDashboardText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sm2(card, quality){
  // card: {ef, repetitions, interval}
  if(quality<3){
    card.repetitions=0;
    card.interval=1;
  } else {
    card.repetitions = (card.repetitions||0)+1;
    if(card.repetitions===1) card.interval=1;
    else if(card.repetitions===2) card.interval=6;
    else card.interval = Math.round(card.interval * (card.ef || 2.5));
    card.ef = Math.max(1.3, (card.ef || 2.5) + 0.1 - (5-quality)*(0.08 + (5-quality)*0.02));
  }
  card.due = Date.now() + card.interval*24*60*60*1000;
  return card;
}

/* Study page bindings */
document.addEventListener('DOMContentLoaded', () => {
  const deckSelect = document.querySelector('#deck-select');
  const startBtn = document.querySelector('#start-study');
  const createBtn = document.querySelector('#create-deck');
  const deckEditor = document.querySelector('#deck-editor');
  const deckNameInput = document.querySelector('#deck-name');
  const addCardBtn = document.querySelector('#add-card');
  const newQ = document.querySelector('#new-q');
  const newA = document.querySelector('#new-a');
  const deckCards = document.querySelector('#deck-cards');
  const saveDeckBtn = document.querySelector('#save-deck');
  const cancelDeckBtn = document.querySelector('#cancel-deck');

  if(deckSelect){
    function refreshDecks(){
      const decks = getDecks();
      deckSelect.innerHTML = '';
      decks.forEach(d=>{
        const opt = document.createElement('option'); opt.value=d.id; opt.textContent=d.name; deckSelect.appendChild(opt);
      });
    }
    refreshDecks();

    createBtn?.addEventListener('click', ()=>{
      deckEditor.style.display='block';
      deckNameInput.value = 'New Deck';
      deckCards.innerHTML='';
      deckEditor.dataset.editing = '';
    });

    addCardBtn?.addEventListener('click', ()=>{
      const q=newQ.value.trim(); const a=newA.value.trim(); if(!q||!a) return alert('Enter both Q and A');
      const id='c'+Date.now();
      const div = document.createElement('div'); div.textContent = q + ' — ' + a; div.dataset.id=id; div.style.padding='0.5rem 0';
      deckCards.appendChild(div);
      // store temporarily on editor element
      const editing = deckEditor.dataset.cards? JSON.parse(deckEditor.dataset.cards) : [];
      editing.push({id,q,a,ef:2.5,interval:0,repetitions:0,due:Date.now()});
      deckEditor.dataset.cards = JSON.stringify(editing);
      newQ.value=''; newA.value='';
    });

    saveDeckBtn?.addEventListener('click', ()=>{
      const name = deckNameInput.value.trim()||('Deck '+Date.now());
      const editing = deckEditor.dataset.cards? JSON.parse(deckEditor.dataset.cards) : [];
      const deck = { id: 'deck-'+Date.now(), name, cards: editing };
      saveDeck(deck); deckEditor.style.display='none'; refreshDecks(); alert('Deck saved');
    });

    cancelDeckBtn?.addEventListener('click', ()=>{ deckEditor.style.display='none'; });

    // Study session
    const studyArea = document.querySelector('#study-area');
    const cardQuestion = document.querySelector('#card-question');
    const cardAnswer = document.querySelector('#card-answer');
    const showAnswerBtn = document.querySelector('#show-answer');
    const markKnownBtn = document.querySelector('#mark-known');
    const markAgainBtn = document.querySelector('#mark-again');
    const progress = document.querySelector('#study-progress');

    let session = null; // {deck, queue, index, stats}

    startBtn?.addEventListener('click', ()=>{
      const deckId = deckSelect.value; const decks = getDecks(); const deck = decks.find(d=>d.id===deckId);
      if(!deck) return alert('Choose or create a deck first');
      // build queue: cards due now or all
      const now = Date.now();
      const queue = deck.cards.slice();
      session = { deckId: deck.id, deckName: deck.name, queue, index:0, stats:{seen:0, correct:0} };
      studyArea.style.display='block';
      showCard();
    });

    function showCard(){
      const card = session.queue[session.index];
      if(!card){ cardQuestion.textContent='Session complete'; cardAnswer.style.display='none'; progress.textContent=`Seen ${session.stats.seen}, correct ${session.stats.correct}`; return; }
      cardQuestion.textContent = card.q;
      cardAnswer.textContent = card.a; cardAnswer.style.display='none'; progress.textContent=`Card ${session.index+1}/${session.queue.length} — seen ${session.stats.seen}`;
    }

    showAnswerBtn?.addEventListener('click', ()=>{ cardAnswer.style.display='block'; });

    markKnownBtn?.addEventListener('click', ()=>{ handleResponse(5); });
    markAgainBtn?.addEventListener('click', ()=>{ handleResponse(2); });

    function handleResponse(quality){
      const card = session.queue[session.index];
      sm2(card, quality);
      session.stats.seen++; if(quality>=4) session.stats.correct++;
      // save card changes back to deck
      const decks = getDecks(); const dk = decks.find(d=>d.id===session.deckId); if(dk){ const ci = dk.cards.findIndex(c=>c.id===card.id); if(ci>=0) dk.cards[ci]=card; saveDeck(dk); }
      session.index++; showCard();
    }
  }
});

/* Dashboard bindings */
document.addEventListener('DOMContentLoaded', ()=>{
  const totalEl = document.querySelector('#total-cards');
  const dueEl = document.querySelector('#due-cards');
  const retentionEl = document.querySelector('#retention');
  const folderCountEl = document.querySelector('#folder-count');
  const deckCountEl = document.querySelector('#deck-count');
  const sessionCountEl = document.querySelector('#session-count');
  const foldersPanelCountEl = document.querySelector('#folders-panel-count');
  const decksPanelCountEl = document.querySelector('#decks-panel-count');
  const recentEl = document.querySelector('#recent-decks');
  const sessionsEl = document.querySelector('#recent-sessions');
  const sessionsPanelCountEl = document.querySelector('#sessions-panel-count');
  const folderListEl = document.querySelector('#folder-list');
  const folderModal = document.querySelector('#folder-modal');
  const createFolderBtn = document.querySelector('#create-folder-btn');
  const saveFolderBtn = document.querySelector('#save-folder-btn');
  const cancelFolderBtn = document.querySelector('#cancel-folder-btn');
  const folderNameInput = document.querySelector('#folder-name');
  const folderDescriptionInput = document.querySelector('#folder-description');
  const dashboardSearch = document.querySelector('#dashboard-search');
  const greetingEl = document.querySelector('#dashboard-greeting');

  if (!totalEl && !folderListEl && !sessionsEl) return;

  let dashboardQuery = '';

  function dashboardGreeting() {
    const h = new Date().getHours();
    let timeGreeting = 'Good evening';
    if (h < 12) timeGreeting = 'Good morning';
    else if (h < 17) timeGreeting = 'Good afternoon';
    return `${timeGreeting} — Ai Study +`;
  }

  if (greetingEl) greetingEl.textContent = dashboardGreeting();

  function matchesQuery(text) {
    if (!dashboardQuery) return true;
    return String(text || '').toLowerCase().includes(dashboardQuery);
  }

  dashboardSearch?.addEventListener('input', () => {
    dashboardQuery = dashboardSearch.value.trim().toLowerCase();
    renderSessions();
  });

  function deckDueCount(deck) {
    return deck.cards ? deck.cards.filter((card) => (card.due || 0) <= Date.now()).length : 0;
  }

  function renderFolders() {
    if (!folderListEl) return;
    const folders = getFolders().slice().reverse().filter((f) => matchesQuery(f.name) || matchesQuery(f.description));
    if (folderCountEl) folderCountEl.textContent = getFolders().length;
    if (foldersPanelCountEl) foldersPanelCountEl.textContent = getFolders().length;

    if (!folders.length) {
      folderListEl.innerHTML = dashboardQuery
        ? `<div class="dashboard-empty"><strong>No folders match</strong><p>Try a different search term.</p></div>`
        : `<div class="dashboard-empty dashboard-empty-mg">
            <span class="dashboard-empty-icon" aria-hidden="true">📁</span>
            <strong>No folders yet</strong>
            <p>Group materials by class or topic.</p>
            <button type="button" class="button button-soft button-sm" data-open-folder-form>New folder</button>
          </div>`;
      return;
    }

    folderListEl.innerHTML = folders.map((folder) => `
      <article class="dashboard-folder-card" data-searchable>
        <div class="dashboard-folder-card-head">
          <div class="dashboard-folder-card-title">
            <span class="dashboard-folder-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            </span>
            <div class="dashboard-folder-card-copy">
              <strong>${escapeDashboardText(folder.name)}</strong>
              <span class="dashboard-folder-meta">Created ${new Date(folder.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
          <button type="button" class="dashboard-folder-delete" data-folder-delete="${folder.id}" aria-label="Delete ${escapeDashboardText(folder.name)}" title="Delete folder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <p>${escapeDashboardText(folder.description || 'No description added.')}</p>
      </article>
    `).join('');
  }

  function getStudySessions() {
    return getStudySessionsFromCache();
  }

  function renderSessions() {
    if (!sessionsEl) return;
    const sessions = getStudySessions().filter((s) => matchesQuery(s.name) || matchesQuery(s.source));
    if (sessionsPanelCountEl) sessionsPanelCountEl.textContent = getStudySessions().length;
    if (sessionCountEl) sessionCountEl.textContent = getStudySessions().length;

    if (!sessions.length) {
      sessionsEl.innerHTML = dashboardQuery
        ? `<div class="dashboard-empty dashboard-empty-mg dashboard-empty-wide"><strong>No sessions match</strong><p>Try a different search term.</p></div>`
        : `<div class="dashboard-empty dashboard-empty-mg dashboard-empty-wide">
            <span class="dashboard-empty-icon" aria-hidden="true">📚</span>
            <strong>No study sessions yet</strong>
            <p>Upload a lecture, PDF, or notes to get notes, flashcards, quizzes, podcast, and an AI tutor — all in one session.</p>
            <button type="button" class="button button-primary" data-dash-session-open="materials">New study session</button>
          </div>`;
      return;
    }

    sessionsEl.innerHTML = sessions.slice(0, 12).map((session) => {
      const date = new Date(session.createdAt);
      const dateLabel = formatSessionDate(date);

      return `
      <article class="mg-session-row">
        <h3 class="mg-session-title">${escapeDashboardText(session.name)}</h3>
        <time class="mg-session-date" datetime="${date.toISOString()}">${dateLabel}</time>
        <div class="mg-session-actions">
          <a class="button button-soft button-sm mg-session-open" href="dashboard.html?session=${encodeURIComponent(session.id)}">Open</a>
          <button type="button" class="mg-session-delete" data-session-delete="${escapeDashboardText(session.id)}" aria-label="Delete ${escapeDashboardText(session.name)}" title="Delete session">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </article>`;
    }).join('');
  }

  function formatSessionDate(date) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderDecks() {
    if (!recentEl) return;
    const decks = getDecks().filter((d) => matchesQuery(d.name));
    if (decksPanelCountEl) decksPanelCountEl.textContent = getDecks().length;

    if (!decks.length) {
      recentEl.innerHTML = dashboardQuery
        ? `<div class="dashboard-empty"><strong>No decks match</strong><p>Try a different search term.</p></div>`
        : `<div class="dashboard-empty dashboard-empty-mg">
            <span class="dashboard-empty-icon" aria-hidden="true">🃏</span>
            <strong>No flashcard decks yet</strong>
            <p>Generate flashcards from any upload in AI Study +.</p>
            <button type="button" class="button button-soft button-sm" data-dash-session-open="materials">Create study session</button>
          </div>`;
      return;
    }

    recentEl.innerHTML = decks.slice(-6).reverse().map((deck) => {
      const cardCount = deck.cards ? deck.cards.length : 0;
      const dueCount = deckDueCount(deck);
      const dueBadge = dueCount
        ? `<span class="dashboard-deck-badge">${dueCount} due</span>`
        : `<span class="dashboard-deck-badge dashboard-deck-badge-muted">Up to date</span>`;

      return `
      <article class="dashboard-deck-card">
        <span class="dashboard-deck-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>
        </span>
        <span class="dashboard-deck-copy">
          <strong>${escapeDashboardText(deck.name)}</strong>
          <span>${cardCount} card${cardCount === 1 ? '' : 's'}</span>
        </span>
        ${dueBadge}
      </article>`;
    }).join('');
  }

  function renderDashboardStats() {
    const decks = getDecks();
    const total = decks.reduce((sum, deck) => sum + (deck.cards ? deck.cards.length : 0), 0);
    const due = decks.reduce((sum, deck) => sum + deckDueCount(deck), 0);

    if (totalEl) totalEl.textContent = total;
    if (dueEl) dueEl.textContent = due;
    if (deckCountEl) deckCountEl.textContent = decks.length;
    if (sessionCountEl) sessionCountEl.textContent = getStudySessions().length;
    if (retentionEl) retentionEl.textContent = total ? `${Math.round(((total - due) / total) * 100)}%` : '—';
    if (folderCountEl) folderCountEl.textContent = getFolders().length;
    if (foldersPanelCountEl) foldersPanelCountEl.textContent = getFolders().length;
    if (decksPanelCountEl) decksPanelCountEl.textContent = decks.length;
  }

  function openFolderForm() {
    if (!folderModal) return;
    folderModal.hidden = false;
    folderModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    createFolderBtn?.setAttribute('aria-expanded', 'true');
    if (folderNameInput) folderNameInput.value = '';
    if (folderDescriptionInput) folderDescriptionInput.value = '';
    window.setTimeout(() => folderNameInput?.focus(), 50);
  }

  function closeFolderForm() {
    if (!folderModal) return;
    folderModal.hidden = true;
    folderModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    createFolderBtn?.setAttribute('aria-expanded', 'false');
    if (folderNameInput) folderNameInput.value = '';
    if (folderDescriptionInput) folderDescriptionInput.value = '';
  }

  createFolderBtn?.setAttribute('aria-expanded', 'false');
  createFolderBtn?.addEventListener('click', openFolderForm);
  cancelFolderBtn?.addEventListener('click', closeFolderForm);

  folderModal?.querySelectorAll('[data-folder-modal-close]').forEach((el) => {
    el.addEventListener('click', closeFolderForm);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && folderModal && !folderModal.hidden) closeFolderForm();
  });

  saveFolderBtn?.addEventListener('click', async () => {
    const name = folderNameInput?.value.trim();
    const description = folderDescriptionInput?.value.trim();
    if (!name) return alert('Enter a folder name.');
    await saveFolder({
      id: `folder-${Date.now()}`,
      name,
      description: description || '',
      createdAt: Date.now()
    });
    closeFolderForm();
    renderFolders();
    renderDashboardStats();
  });

  folderListEl?.addEventListener('click', async (event) => {
    if (event.target.closest('[data-open-folder-form]')) {
      openFolderForm();
      return;
    }

    const deleteBtn = event.target.closest('[data-folder-delete]');
    if (!deleteBtn) return;
    const folder = getFolders().find((item) => item.id === deleteBtn.dataset.folderDelete);
    if (!folder) return;
    if (!confirm(`Delete folder "${folder.name}"?`)) return;
    await deleteFolder(folder.id);
    renderFolders();
    renderDashboardStats();
  });

  sessionsEl?.addEventListener('click', async (event) => {
    const deleteBtn = event.target.closest('[data-session-delete]');
    if (!deleteBtn) return;
    event.preventDefault();
    const session = getStudySessions().find((item) => item.id === deleteBtn.dataset.sessionDelete);
    if (!session) return;
    if (!confirm(`Delete "${session.name}"? This cannot be undone.`)) return;
    try {
      await deleteStudySessionFromDb(session.id);
      renderSessions();
      renderDashboardStats();
    } catch {
      alert('Could not delete session. Try again.');
    }
  });

  window.addEventListener('bipai:dashboard-panel', async () => {
    await refreshAllData();
    renderDashboardStats();
    renderSessions();
    renderDecks();
    renderFolders();
  });

  (async () => {
    await refreshAllData();
    renderDashboardStats();
    renderSessions();
    renderDecks();
    renderFolders();
  })();
});

/* Dashboard: upload / record session modal */
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('dash-session-modal');
  if (!modal) return;

  const openButtons = document.querySelectorAll('[data-dash-session-open]');
  const modalTitle = document.getElementById('dash-session-modal-title');
  const modalDesc = document.getElementById('dash-session-modal-desc');
  const modalIcon = document.getElementById('dash-session-modal-icon');
  const modePanels = modal.querySelectorAll('[data-dash-mode-panel]');
  const sessionNameInput = document.getElementById('dash-session-name');
  const fileInput = document.getElementById('dash-file-input');
  const fileTrigger = document.getElementById('dash-file-trigger');
  const dropZone = document.getElementById('dash-drop-zone');
  const fileListEl = document.getElementById('dash-file-list');
  const audioFileInput = document.getElementById('dash-audio-file-input');
  const audioFileTrigger = document.getElementById('dash-audio-file-trigger');
  const audioFileName = document.getElementById('dash-audio-file-name');
  const recordStart = document.getElementById('dash-record-start');
  const recordStop = document.getElementById('dash-record-stop');
  const recordReset = document.getElementById('dash-record-reset');
  const recordDot = document.getElementById('dash-recorder-dot');
  const recordTime = document.getElementById('dash-recorder-time');
  const recordPreview = document.getElementById('dash-record-preview');
  const loadingPanel = document.getElementById('dash-loading');
  const loadingText = document.getElementById('dash-loading-text');
  const loadingBar = document.getElementById('dash-loading-bar');
  const generateBtn = document.getElementById('dash-generate-btn');
  const statusEl = document.getElementById('dash-generate-status');
  const dropTitleEl = document.getElementById('dash-drop-title');
  const dropHintEl = document.getElementById('dash-drop-hint');
  const audioLayout = document.getElementById('dash-audio-layout');
  const audioStack = document.getElementById('dash-audio-stack');
  const audioRecordBox = document.getElementById('dash-audio-record-box');
  const audioUploadBox = document.getElementById('dash-audio-upload-box');
  const youtubeUrlInput = document.getElementById('dash-youtube-url');
  const websiteUrlInput = document.getElementById('dash-website-url');

  let activeMode = 'files';
  let activeVariant = 'materials';
  let selectedFiles = [];
  let uploadedAudioFile = null;
  let mediaRecorder = null;
  let recordStream = null;
  let audioChunks = [];
  let recordedBlob = null;
  let recordTimerId = null;
  let recordStartTime = 0;

  const MODE_CONFIG = {
    materials: {
      uploadKind: 'files',
      panel: 'files',
      audioView: 'upload',
      title: 'Upload study materials',
      desc: 'Add PDFs, slides, or images — or upload audio below',
      icon: '📚',
      accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.ppt,.pptx',
      dropTitle: 'Drop study materials or click to upload',
      dropHint: 'PDF · Slides · Images · Text'
    },
    files: {
      uploadKind: 'files',
      panel: 'files',
      audioView: 'upload',
      title: 'Upload study materials',
      desc: 'Add PDFs, slides, or images — or upload audio below',
      icon: '📚',
      accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.ppt,.pptx',
      dropTitle: 'Drop study materials or click to upload',
      dropHint: 'PDF · Slides · Images · Text'
    },
    audio: {
      uploadKind: 'files',
      panel: 'files',
      audioView: 'upload',
      title: 'Upload audio',
      desc: 'Add lecture audio below, or attach study materials above',
      icon: '🎧',
      accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.ppt,.pptx',
      dropTitle: 'Drop study materials or click to upload',
      dropHint: 'PDF · Slides · Images · Text'
    },
    record: {
      uploadKind: 'files',
      panel: 'files',
      audioView: 'record',
      title: 'Record lecture',
      desc: 'Record below, or attach study materials above',
      icon: '🎙️',
      accept: '.pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.ppt,.pptx',
      dropTitle: 'Drop study materials or click to upload',
      dropHint: 'PDF · Slides · Images · Text'
    },
    youtube: {
      uploadKind: 'url',
      panel: 'youtube',
      urlType: 'youtube',
      title: 'YouTube video link',
      desc: 'Paste a lecture or tutorial link to build a study session',
      icon: '▶️'
    },
    website: {
      uploadKind: 'url',
      panel: 'website',
      urlType: 'website',
      title: 'Website link',
      desc: 'Paste an article or web page to turn into study materials',
      icon: '🌐'
    }
  };

  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', isError);
  }

  function setMode(variant) {
    const config = MODE_CONFIG[variant] || MODE_CONFIG.materials;
    activeVariant = variant;
    activeMode = config.uploadKind;

    modePanels.forEach((panel) => {
      panel.hidden = panel.dataset.dashModePanel !== config.panel;
    });

    if (modalTitle) modalTitle.textContent = config.title;
    if (modalDesc) modalDesc.textContent = config.desc;
    if (modalIcon) modalIcon.textContent = config.icon;

    if (config.panel === 'files' && fileInput) {
      fileInput.accept = config.accept;
      if (dropTitleEl) dropTitleEl.textContent = config.dropTitle;
      if (dropHintEl) dropHintEl.textContent = config.dropHint;
    }

    if (config.panel === 'files') {
      const uploadOnly = config.audioView === 'upload';
      const recordOnly = config.audioView === 'record';
      if (dropZone) dropZone.hidden = false;
      if (audioStack) audioStack.hidden = false;
      if (audioRecordBox) audioRecordBox.hidden = uploadOnly;
      if (audioUploadBox) audioUploadBox.hidden = recordOnly;
      audioLayout?.classList.toggle('is-single-column', uploadOnly || recordOnly);
    }
  }

  function resetModalState() {
    resetRecording();
    selectedFiles = [];
    renderFileList();
    uploadedAudioFile = null;
    if (audioFileInput) audioFileInput.value = '';
    if (audioFileName) audioFileName.textContent = '';
    if (youtubeUrlInput) youtubeUrlInput.value = '';
    if (websiteUrlInput) websiteUrlInput.value = '';
    setStatus('');
  }

  function openModal(variant) {
    resetModalState();
    setMode(variant);
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    window.setTimeout(() => sessionNameInput?.focus(), 50);
  }

  function closeModal() {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    recordStream?.getTracks().forEach((t) => t.stop());
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    setStatus('');
  }

  function renderFileList() {
    if (!fileListEl) return;
    if (!selectedFiles.length) {
      fileListEl.hidden = true;
      fileListEl.innerHTML = '';
      return;
    }
    fileListEl.hidden = false;
    fileListEl.innerHTML = selectedFiles.map((file, i) => `
      <li class="study-file-chip"><span>${esc(file.name)}</span>
      <button type="button" class="study-file-chip-remove" data-dash-remove-index="${i}" aria-label="Remove">×</button></li>`).join('');
  }

  function addFiles(files) {
    files.forEach((file) => {
      if (!selectedFiles.some((f) => f.name === file.name && f.size === file.size)) selectedFiles.push(file);
    });
    renderFileList();
  }

  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function resetRecording() {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    recordStream?.getTracks().forEach((t) => t.stop());
    clearInterval(recordTimerId);
    mediaRecorder = null;
    recordStream = null;
    audioChunks = [];
    recordedBlob = null;
    if (recordTime) recordTime.textContent = '00:00';
    if (recordPreview) { recordPreview.hidden = true; recordPreview.removeAttribute('src'); }
    recordDot?.classList.remove('is-recording');
    if (recordStart) recordStart.hidden = false;
    if (recordStop) recordStop.hidden = true;
    if (recordReset) recordReset.hidden = true;
  }

  function setDashLoadingProgress(percent) {
    if (loadingBar) loadingBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  function showLoading(messages) {
    if (!loadingPanel) return;
    loadingPanel.hidden = false;
    if (generateBtn) generateBtn.disabled = true;
    setDashLoadingProgress(10);
    let i = 0;
    if (loadingText) loadingText.textContent = messages[0] || 'Working…';
    clearInterval(loadingPanel._msgTimer);
    clearInterval(loadingPanel._progressTimer);
    loadingPanel._msgTimer = setInterval(() => {
      i = (i + 1) % messages.length;
      if (loadingText) loadingText.textContent = messages[i];
    }, 2800);
    let progress = 10;
    loadingPanel._progressTimer = setInterval(() => {
      if (progress < 38) {
        progress += 1.2;
        setDashLoadingProgress(progress);
      }
    }, 700);
  }

  function hideLoading() {
    if (!loadingPanel) return;
    clearInterval(loadingPanel._msgTimer);
    clearInterval(loadingPanel._progressTimer);
    setDashLoadingProgress(100);
    window.setTimeout(() => {
      loadingPanel.hidden = true;
      if (loadingBar) loadingBar.style.width = '0%';
    }, 450);
    if (generateBtn) generateBtn.disabled = false;
  }

  function getAudioFile() {
    if (uploadedAudioFile) return uploadedAudioFile;
    if (recordedBlob) {
      const ext = recordedBlob.type.includes('webm') ? 'webm' : 'm4a';
      return new File([recordedBlob], `recording-${Date.now()}.${ext}`, { type: recordedBlob.type });
    }
    return null;
  }

  document.body.addEventListener('click', (event) => {
    const openBtn = event.target.closest('[data-dash-session-open]');
    if (!openBtn || openBtn.closest('#dash-session-modal')) return;
    event.preventDefault();
    openModal(openBtn.dataset.dashSessionOpen || 'materials');
  });

  modal.querySelectorAll('[data-dash-session-close]').forEach((el) => {
    el.addEventListener('click', closeModal);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });

  fileTrigger?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files || []));
    fileInput.value = '';
  });
  dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-dragover'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('is-dragover'));
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
    addFiles(Array.from(e.dataTransfer?.files || []));
  });
  fileListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dash-remove-index]');
    if (!btn) return;
    selectedFiles.splice(Number(btn.dataset.dashRemoveIndex), 1);
    renderFileList();
  });

  audioFileTrigger?.addEventListener('click', () => audioFileInput?.click());
  audioFileInput?.addEventListener('change', () => {
    uploadedAudioFile = audioFileInput.files?.[0] || null;
    if (audioFileName) audioFileName.textContent = uploadedAudioFile ? uploadedAudioFile.name : '';
    resetRecording();
  });

  recordStart?.addEventListener('click', async () => {
    try {
      uploadedAudioFile = null;
      if (audioFileInput) audioFileInput.value = '';
      if (audioFileName) audioFileName.textContent = '';
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      mediaRecorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        recordedBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        if (recordPreview) {
          recordPreview.src = URL.createObjectURL(recordedBlob);
          recordPreview.hidden = false;
        }
        recordDot?.classList.remove('is-recording');
        if (recordStart) recordStart.hidden = true;
        if (recordStop) recordStop.hidden = true;
        if (recordReset) recordReset.hidden = false;
      };
      mediaRecorder.start();
      recordStartTime = Date.now();
      recordTimerId = setInterval(() => {
        if (recordTime) recordTime.textContent = formatTime(Date.now() - recordStartTime);
      }, 500);
      recordDot?.classList.add('is-recording');
      if (recordStart) recordStart.hidden = true;
      if (recordStop) recordStop.hidden = false;
    } catch (err) {
      setStatus('Microphone access denied or unavailable.', true);
    }
  });

  recordStop?.addEventListener('click', () => {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  });
  recordReset?.addEventListener('click', resetRecording);

  generateBtn?.addEventListener('click', async () => {
    let files = [];
    let text = '';
    let url = '';
    let urlType = '';
    const config = MODE_CONFIG[activeVariant] || MODE_CONFIG.materials;

    if (activeMode === 'files') {
      files = selectedFiles.slice();
      const audio = getAudioFile();
      if (audio) files.push(audio);
      if (!files.length) return setStatus('Add study materials or audio.', true);
    } else if (activeMode === 'audio') {
      const audio = getAudioFile();
      if (!audio) return setStatus('Record or upload audio first.', true);
      files = [audio];
    } else {
      url = (config.urlType === 'youtube' ? youtubeUrlInput : websiteUrlInput)?.value.trim() || '';
      urlType = config.urlType || '';
      if (!url) return setStatus('Paste a link first.', true);
    }

    let generate;
    try {
      generate = validateGenerateOptions(readGenerateOptions('dash-'));
    } catch (err) {
      return setStatus(err.message, true);
    }

    const hasAudioOnly = activeMode === 'files'
      && !selectedFiles.length
      && Boolean(getAudioFile());
    const contentMode = activeMode === 'url' ? 'url' : hasAudioOnly ? 'audio' : 'files';
    const loadMsgs = loadingMessagesForGenerate(generate, contentMode);
    showLoading(loadMsgs);
    setStatus('');

    try {
      let opened = false;
      const sessionTitleBase = sessionNameInput?.value.trim() || '';
      const mode = contentMode;
      const data = await createStudySessionStaged({
        files,
        text,
        url,
        urlType,
        sessionName: sessionTitleBase,
        generate
      }, {
        onProgress: (msg, percent) => {
          if (loadingText) loadingText.textContent = msg;
          if (typeof percent === 'number') setDashLoadingProgress(percent);
        },
        onPartial: (partial) => {
          if (typeof partial === 'object') setDashLoadingProgress(42);
          if (!opened) {
            setDashLoadingProgress(100);
            window.setTimeout(() => {
              hideLoading();
              closeModal();
            }, 350);
            opened = true;
          }
          window.dispatchEvent(new CustomEvent('bipai:study-session-ready', {
            detail: {
              sessionTitle: resolveSessionTitle(sessionTitleBase, partial, mode, files),
              data: partial,
              activeMode: mode,
              partial: Boolean(partial._pendingFlashcards || partial._pendingPodcast)
            }
          }));
        }
      });
      if (!opened) {
        hideLoading();
        closeModal();
      }
      window.dispatchEvent(new CustomEvent('bipai:study-session-ready', {
        detail: {
          sessionTitle: resolveSessionTitle(sessionTitleBase, data, mode, files),
          data,
          activeMode: mode,
          partial: false
        }
      }));
    } catch (err) {
      hideLoading();
      setStatus(formatApiError(err.message), true);
    }
  });
});

// Features quick-access panel (keyboard accessible)
(function(){
  function createPanel(){
    const panel = document.createElement('div');
    panel.id = 'features-panel';
    panel.setAttribute('role','menu');
    panel.tabIndex = -1;
    panel.innerHTML = `
      <ul style="list-style:none;margin:0;padding:6px;">
        <li role="menuitem" data-action="flashcards" tabindex="0"><a href="#">Flashcards</a></li>
        <li role="menuitem" data-action="notes" tabindex="0"><a href="#">Notes</a></li>
        <li role="menuitem" data-action="quiz" tabindex="0"><a href="#">Quiz</a></li>
        <li role="menuitem" data-action="solver" tabindex="0"><a href="#">Problem Solver</a></li>
        <li role="menuitem" data-action="test" tabindex="0"><a href="#">Test</a></li>
        <li role="separator" style="height:1px;background:rgba(2,6,23,0.06);margin:8px 0"></li>
        <li role="menuitem" tabindex="0"><a href="features.html">All features</a></li>
        <li role="menuitem" tabindex="0"><a href="dashboard.html">Ai Study +</a></li>
      </ul>`;
    Object.assign(panel.style,{
      position:'absolute',minWidth:'220px',background:'#fff',borderRadius:'12px',boxShadow:'0 8px 30px rgba(2,6,23,0.12)',padding:'8px',zIndex:9999,display:'none'
    });
    document.body.appendChild(panel);
    return panel;
  }

  function openPanel(anchor){
    const rect = anchor.getBoundingClientRect();
    panel.style.left = (rect.left) + 'px';
    panel.style.top = (rect.bottom + 8 + window.scrollY) + 'px';
    panel.style.display = 'block';
    panel.focus();
  }

  function closePanel(){ panel.style.display='none'; }

  const featuresLink = Array.from(document.querySelectorAll('.nav-links a')).find(a=>/features/i.test(a.textContent||a.innerText));
  if(!featuresLink) return;
  const panel = createPanel();

  featuresLink.addEventListener('click', (e)=>{
    e.preventDefault();
    if(panel.style.display==='block') closePanel(); else openPanel(featuresLink);
  });

  // keyboard: Esc to close, arrows to navigate
  panel.addEventListener('keydown', (ev)=>{
    const items = Array.from(panel.querySelectorAll('[role="menuitem"]'));
    const idx = items.indexOf(document.activeElement);
    if(ev.key === 'ArrowDown'){ ev.preventDefault(); const ni = (idx+1) % items.length; items[ni].focus(); }
    if(ev.key === 'ArrowUp'){ ev.preventDefault(); const ni = (idx-1+items.length) % items.length; items[ni].focus(); }
    if(ev.key === 'Escape') closePanel();
  });

  // click outside closes
  document.addEventListener('click', (ev)=>{ if(panel.style.display==='block' && !panel.contains(ev.target) && !featuresLink.contains(ev.target)) closePanel(); });

  // click on a menu item: trigger corresponding feature Try button if present
  panel.addEventListener('click', (ev)=>{
    const li = ev.target.closest('[role="menuitem"]');
    if(!li) return;
    ev.preventDefault();
    const action = li.getAttribute('data-action');
    if(action){
      const btn = document.getElementById('feat-' + action);
      if(btn){ btn.click(); closePanel(); return; }
    }
    const a = li.querySelector('a'); if(a && a.getAttribute('href')){ window.location = a.getAttribute('href'); }
  });

  // make items activate links on Enter/Space
  panel.addEventListener('keyup', (ev)=>{ if(ev.key==='Enter' || ev.key===' ') { const a = document.activeElement.querySelector('a'); if(a) window.location = a.getAttribute('href'); } });
})();

/* AI Features modal actions (Features page) */
document.addEventListener('DOMContentLoaded', ()=>{
  const modal = document.getElementById('ai-modal');
  if(!modal) return;
  const panel = document.getElementById('ai-modal-panel');
  const content = document.getElementById('ai-modal-content');
  const closeBtn = document.getElementById('ai-modal-close');
  function showModal(html){ content.innerHTML = html; modal.style.display = 'flex'; }
  function hideModal(){ modal.style.display = 'none'; }
  closeBtn?.addEventListener('click', hideModal);
  document.getElementById('ai-modal-backdrop')?.addEventListener('click', hideModal);

  // Flashcards: file upload
  const fb = document.getElementById('feat-flashcards');
  fb?.addEventListener('click', ()=>{
    showModal(`<h3>Generate Flashcards</h3>
      <p>Select a PDF or text file to generate flashcards.</p>
      <input type="file" id="ai-file-input" />
      <div style="margin-top:0.75rem"><button id="ai-upload-file" class="button button-primary">Upload & Generate</button></div>
      <pre id="ai-result" style="margin-top:0.75rem;color:var(--muted)"></pre>`);
    document.getElementById('ai-upload-file')?.addEventListener('click', async ()=>{
      const inp = document.getElementById('ai-file-input'); const file = inp.files && inp.files[0]; if(!file) return alert('Choose a file');
      const res = await uploadFile(file);
      document.getElementById('ai-result').textContent = JSON.stringify(res, null, 2);
      // save deck
      const deck = { id: 'deck-' + Date.now(), name: file.name, cards: res.items.map((it, i) => ({ id: 'c'+i+'-'+Date.now(), q: it.q, a: it.a, tags: [], ef:2.5, interval:0, repetitions:0, due:Date.now() })) };
      saveDeck(deck);
    });
  });

  // Notes: audio upload
  const notes = document.getElementById('feat-notes');
  notes?.addEventListener('click', ()=>{
    showModal(`<h3>Generate Notes from Audio</h3>
      <p>Upload an audio file recorded on your phone.</p>
      <input type="file" id="ai-audio-input" accept="audio/*" />
      <div style="margin-top:0.75rem"><button id="ai-upload-audio" class="button button-primary">Upload & Summarize</button></div>
      <pre id="ai-result-audio" style="margin-top:0.75rem;color:var(--muted)"></pre>`);
    document.getElementById('ai-upload-audio')?.addEventListener('click', async ()=>{
      const inp = document.getElementById('ai-audio-input'); const file = inp.files && inp.files[0]; if(!file) return alert('Choose an audio file');
      const res = await uploadAudio(file);
      document.getElementById('ai-result-audio').textContent = JSON.stringify(res, null, 2);
    });
  });

  // Quiz: text -> quiz
  const qbtn = document.getElementById('feat-quiz');
  qbtn?.addEventListener('click', ()=>{
    showModal(`<h3>Generate Quiz</h3>
      <p>Paste text or notes to generate quiz questions.</p>
      <textarea id="ai-quiz-text" rows="8" style="width:100%"></textarea>
      <div style="margin-top:0.75rem"><button id="ai-gen-quiz" class="button button-primary">Generate Quiz</button></div>
      <div id="ai-quiz-result" style="margin-top:0.75rem;color:var(--muted)"></div>`);
    document.getElementById('ai-gen-quiz')?.addEventListener('click', async ()=>{
      const txt = document.getElementById('ai-quiz-text').value.trim(); if(!txt) return alert('Enter some text');
      const res = await generateQuizFromText(txt);
      document.getElementById('ai-quiz-result').innerHTML = `<pre>${JSON.stringify(res, null, 2)}</pre>`;
      // store in session for quick test
      window.__bipai_quiz = res.quiz || res;
    });
  });

  // Problem solver: math, physics, complex problems
  const solverBtn = document.getElementById('feat-solver');
  solverBtn?.addEventListener('click', ()=>{
    showModal(`<h3>Step-by-Step Problem Solver</h3>
      <p>Paste a math, physics, or complex problem to get a guided solution.</p>
      <label style="display:block;font-weight:600;margin-bottom:0.35rem">Problem</label>
      <textarea id="ai-solver-problem" rows="6" style="width:100%" placeholder="Example: A car travels 60 meters in 5 seconds. What is its velocity?"></textarea>
      <div style="margin-top:0.75rem"><button id="ai-solve-problem" class="button button-primary">Solve step by step</button></div>
      <div id="ai-solver-result" style="margin-top:0.75rem;color:var(--muted)"></div>`);
    document.getElementById('ai-solve-problem')?.addEventListener('click', async ()=>{
      const problem = document.getElementById('ai-solver-problem').value.trim();
      if(!problem) return alert('Enter a problem to solve');
      const res = await solveProblem(problem);
      const solution = res.solution || {};
      const steps = (solution.steps || []).map((s) =>
        `<div style="margin-top:0.75rem;padding:0.85rem 1rem;border-radius:12px;background:#f8fafc;border:1px solid rgba(15,23,42,0.06)">
          <strong>Step ${s.step}: ${s.title}</strong>
          <p style="margin:0.35rem 0 0">${s.detail}</p>
        </div>`
      ).join('');
      document.getElementById('ai-solver-result').innerHTML = `
        <p><strong>${solution.title || 'Solution'}</strong></p>
        ${solution.problem ? `<p style="margin-top:0.5rem">Problem: ${solution.problem}</p>` : ''}
        ${steps}
        <p style="margin-top:0.85rem"><strong>Final answer:</strong> ${solution.answer || 'See steps above'}</p>`;
    });
  });

  // Test: run quiz (uses existing generated quiz if present)
  const tbtn = document.getElementById('feat-test');
  tbtn?.addEventListener('click', async ()=>{
    let quiz = window.__bipai_quiz;
    if(!quiz){
      // prompt for text first
      const txt = prompt('No quiz in memory. Paste source text to generate quiz:');
      if(!txt) return; const res = await generateQuizFromText(txt); quiz = res.quiz || res; window.__bipai_quiz = quiz;
    }
    if(!quiz.questions || !quiz.questions.length) return alert('Quiz has no questions');
    // render simple test UI
    let idx = 0; let score = 0;
    function renderQuestion(){
      const q = quiz.questions[idx];
      let html = `<h3>Q${idx+1}: ${q.q}</h3>`;
      html += '<div id="ai-test-opts">';
      q.options.forEach((opt,i)=> html += `<div><label><input type="radio" name="aiopt" value="${i}" /> ${opt}</label></div>`);
      html += '</div>';
      html += '<div style="margin-top:0.75rem"><button id="ai-next" class="button button-primary">Submit</button></div>';
      showModal(html);
      document.getElementById('ai-next').addEventListener('click', ()=>{
        const sel = document.querySelector('input[name="aiopt"]:checked'); if(!sel) return alert('Choose an option');
        const v = parseInt(sel.value,10); if(v===q.answer) score++;
        idx++; if(idx<quiz.questions.length) renderQuestion(); else { showModal(`<h3>Test complete</h3><p>Your score: ${score}/${quiz.questions.length}</p>`); }
      });
    }
    renderQuestion();
  });

});

/* Study workspace tools */
document.addEventListener('DOMContentLoaded', () => {
  const toolCards = document.querySelectorAll('.study-tool-card, .sidebar-tool[data-tool]');
  const modal = document.getElementById('study-tool-modal');
  const modalBody = document.getElementById('study-modal-body');
  const modalTitle = document.getElementById('study-modal-title');
  const modalDesc = document.getElementById('study-modal-desc');
  const modalIcon = document.getElementById('study-modal-icon');
  const workspace = document.getElementById('study-workspace');
  const workspaceTitle = document.getElementById('study-workspace-title');
  const workspaceDesc = document.getElementById('study-workspace-desc');
  const workspaceResult = document.getElementById('study-workspace-result');

  if (!toolCards.length || !modal || !modalBody) return;

  initFilePreviewModal();

  const TOOL_META = {
    audio: {
      title: 'Audio upload or record',
      desc: 'Upload a lecture file or record audio from your microphone.',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/></svg>'
    },
    notes: {
      title: 'Smart notes',
      desc: 'Generate structured notes from PDF, Word, images, or text files.',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>'
    },
    quiz: {
      title: 'Quiz builder',
      desc: 'Build practice quizzes from uploaded files or pasted text.',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M9 11l2 2 4-4"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>'
    },
    solver: {
      title: 'Step-by-step solver',
      desc: 'Solve math, physics, and complex problems with step-by-step explanations.',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M4 7h16"/><path d="M7 4v6"/><path d="M17 4v6"/><path d="M6 20h12"/><path d="M9 16h6"/></svg>'
    },
    podcast: {
      title: 'Podcast generate',
      desc: 'Generate a study podcast episode with chapters and a script from your material.',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/><path d="M8 22h8"/></svg>'
    }
  };

  let activeTool = null;
  let mediaRecorder = null;
  let recordStream = null;
  let audioChunks = [];
  let recordedBlob = null;
  let recordTimerId = null;
  let recordStartTime = 0;
  let resettingRecorder = false;

  function renderNotesResult(container, data) {
    const notes = data.notes || data;
    const fileList = notes.files || [];
    const previewGrid = fileList.length
      ? `<div class="study-upload-preview-grid study-result-preview-grid">${fileList.filter((f) => f.fileType === 'image').map((f) =>
          `<figure class="study-preview-item"><img class="study-upload-preview" src="${f.url}" alt="${f.name}" /><figcaption>Page ${f.page || ''}</figcaption></figure>`
        ).join('')}</div>`
      : notes.file && notes.fileType === 'image'
        ? `<img class="study-result-preview" src="${notes.file}" alt="Source image preview" />`
        : '';
    const pageInfo = notes.pageCount > 1
      ? `<p class="study-result-meta">${notes.pageCount} files uploaded</p>`
      : '';
    const typeSummary = (notes.detectedTypes || []).length
      ? `<div class="study-detected-types study-detected-types-inline">${notes.detectedTypes.map((item) =>
          `<span class="study-type-chip" data-type="${item.type}">${item.count} ${fileTypeLabel(item.type)}${item.count > 1 ? 's' : ''}</span>`
        ).join('')}</div>`
      : '';
    container.innerHTML = `
      ${previewGrid}
      <h4>${notes.title || 'Smart notes'}</h4>
      ${typeSummary}
      ${pageInfo}
      <ul>${(notes.bullets || []).map((item) => `<li>${item}</li>`).join('')}</ul>
      ${notes.source ? `<p class="study-result-meta">Source: ${notes.source}</p>` : ''}`;
  }

  function renderQuizResult(container, data) {
    const quiz = data.quiz || data;
    window.__bipai_quiz = quiz;
    container.innerHTML = `
      <h4>${quiz.title || 'Generated quiz'}</h4>
      ${(quiz.questions || []).map((q, i) => `
        <div class="study-quiz-item">
          <strong>Q${i + 1}. ${q.q}</strong>
          <ul>${(q.options || []).map((opt, idx) => `<li>${idx === q.answer ? `<em>${opt}</em>` : opt}</li>`).join('')}</ul>
        </div>`).join('')}`;
  }

  function showWorkspaceResult(tool, html) {
    const meta = TOOL_META[tool];
    workspace.hidden = false;
    workspaceTitle.textContent = meta?.title || 'Results';
    workspaceDesc.textContent = 'Your generated content is ready below.';
    workspaceResult.innerHTML = html;
    workspace.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setLoading(container, message) {
    container.innerHTML = `<p class="study-loading">${message}</p>`;
  }

  function uploadPlusHtml({ id, accept, hint, label = 'Choose file', multiple = false }) {
    if (multiple) {
      return `
        <div class="study-upload-dialog" data-upload-id="${id}" data-multiple="true">
          <input type="file" id="${id}" accept="${accept}" multiple hidden />
          <button type="button" class="study-upload-plus" data-file-trigger="${id}">
            <span class="study-upload-plus-ring"><span class="study-upload-plus-icon">+</span></span>
            <span class="study-upload-plus-label">${label}</span>
            <span class="study-upload-plus-hint">${hint}</span>
          </button>
          <div class="study-file-list" id="${id}-list" hidden></div>
        </div>`;
    }

    return `
      <div class="study-upload-dialog" data-upload-id="${id}" data-multiple="false">
        <input type="file" id="${id}" accept="${accept}" hidden />
        <button type="button" class="study-upload-plus" data-file-trigger="${id}">
          <span class="study-upload-plus-ring"><span class="study-upload-plus-icon">+</span></span>
          <span class="study-upload-plus-label">${label}</span>
          <span class="study-upload-plus-hint">${hint}</span>
        </button>
        <div class="study-file-selected" id="${id}-selected" hidden>
          <span class="study-file-selected-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
          </span>
          <span class="study-file-name" id="${id}-name"></span>
          <button type="button" class="study-file-remove" data-file-clear="${id}" aria-label="Remove file">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </div>`;
  }

  function getUploadDialog(inputId) {
    return document.querySelector(`.study-upload-dialog[data-upload-id="${inputId}"]`);
  }

  function getSelectedFiles(inputId) {
    return getUploadDialog(inputId)?._selectedFiles || [];
  }

  function setSelectedFiles(inputId, files) {
    const dialog = getUploadDialog(inputId);
    if (dialog) dialog._selectedFiles = files;
  }

  function revokePreviewUrls(inputId) {
    const dialog = getUploadDialog(inputId);
    (dialog?._previewUrls || []).forEach((url) => URL.revokeObjectURL(url));
    if (dialog) dialog._previewUrls = [];
  }

  function smartUploadHtml(id) {
    return uploadPlusHtml({
      id,
      accept: SMART_UPLOAD_ACCEPT,
      hint: 'PDF, Word, images, or text — no type selection needed',
      label: 'Add files',
      multiple: true
    });
  }

  let filePreviewObjectUrl = null;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function closeFilePreview() {
    const modal = document.getElementById('study-file-preview-modal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('preview-open');
    if (filePreviewObjectUrl) {
      URL.revokeObjectURL(filePreviewObjectUrl);
      filePreviewObjectUrl = null;
    }
    const body = document.getElementById('study-file-preview-body');
    if (body) body.innerHTML = '';
  }

  async function openFilePreview(inputId, index) {
    const files = getSelectedFiles(inputId);
    const file = files[index];
    if (!file) return;

    const modal = document.getElementById('study-file-preview-modal');
    const titleEl = document.getElementById('study-file-preview-title');
    const bodyEl = document.getElementById('study-file-preview-body');
    if (!modal || !titleEl || !bodyEl) return;

    closeFilePreview();

    titleEl.textContent = file.name;
    const type = detectFileType(file);

    if (type === 'image') {
      filePreviewObjectUrl = URL.createObjectURL(file);
      bodyEl.innerHTML = `<img class="study-file-preview-image" src="${filePreviewObjectUrl}" alt="${escapeHtml(file.name)}" />`;
    } else if (type === 'pdf') {
      filePreviewObjectUrl = URL.createObjectURL(file);
      bodyEl.innerHTML = `<iframe class="study-file-preview-doc" src="${filePreviewObjectUrl}" title="${escapeHtml(file.name)}"></iframe>`;
    } else if (type === 'text') {
      const text = await file.text();
      bodyEl.innerHTML = `<pre class="study-file-preview-text">${escapeHtml(text)}</pre>`;
    } else if (type === 'audio') {
      filePreviewObjectUrl = URL.createObjectURL(file);
      bodyEl.innerHTML = `<audio class="study-file-preview-audio" controls src="${filePreviewObjectUrl}"></audio>`;
    } else {
      bodyEl.innerHTML = `
        <div class="study-file-preview-placeholder">
          <strong>${fileTypeLabel(type)} file</strong>
          <p>${escapeHtml(file.name)}</p>
          <span>This file will be processed when you generate notes. In-browser preview is not available for this format.</span>
        </div>`;
    }

    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('preview-open');
  }

  function initFilePreviewModal() {
    const modal = document.getElementById('study-file-preview-modal');
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = 'true';
    modal.querySelectorAll('[data-preview-close]').forEach((el) => {
      el.addEventListener('click', closeFilePreview);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.hidden) closeFilePreview();
    });
  }

  function renderFileList(inputId) {
    const dialog = getUploadDialog(inputId);
    if (!dialog) return;

    const multiple = dialog.dataset.multiple === 'true';
    const input = document.getElementById(inputId);
    if (!multiple) {
      updateSingleFileUploadUi(input);
      return;
    }

    const files = getSelectedFiles(inputId);
    const listEl = document.getElementById(`${inputId}-list`);

    if (listEl) {
      listEl.hidden = files.length === 0;
      listEl.innerHTML = files.map((file, index) => `
        <div class="study-file-row">
          <span class="study-file-name-only" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <div class="study-file-row-actions">
            <button type="button" class="study-file-preview-btn" data-file-preview="${inputId}" data-file-index="${index}" aria-label="Preview ${escapeHtml(file.name)}" title="Preview">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button type="button" class="study-file-remove" data-file-remove="${inputId}" data-file-index="${index}" aria-label="Remove ${escapeHtml(file.name)}" title="Remove">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </div>`).join('');
    }
  }

  function updateSingleFileUploadUi(input) {
    if (!input?.id) return;
    const id = input.id;
    const file = input.files?.[0];
    const dialog = input.closest('.study-upload-dialog');
    const selectedEl = document.getElementById(`${id}-selected`);
    const nameEl = document.getElementById(`${id}-name`);
    const plusBtn = dialog?.querySelector('.study-upload-plus');

    if (selectedEl && plusBtn) {
      selectedEl.hidden = !file;
      plusBtn.hidden = !!file;
    }
    if (nameEl) nameEl.textContent = file ? file.name : '';
  }

  function addSelectedFiles(inputId, newFiles) {
    const existing = getSelectedFiles(inputId);
    const merged = [...existing];
    newFiles.forEach((file) => {
      const duplicate = merged.some(
        (item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified
      );
      if (!duplicate) merged.push(file);
    });
    setSelectedFiles(inputId, merged);
    renderFileList(inputId);
  }

  function removeSelectedFile(inputId, index) {
    const files = getSelectedFiles(inputId);
    files.splice(index, 1);
    setSelectedFiles(inputId, files);
    renderFileList(inputId);
  }

  function clearFileInput(inputId) {
    const dialog = getUploadDialog(inputId);
    const input = document.getElementById(inputId);
    if (dialog?.dataset.multiple === 'true') {
      revokePreviewUrls(inputId);
      setSelectedFiles(inputId, []);
      if (input) input.value = '';
      renderFileList(inputId);
      return;
    }
    if (input) input.value = '';
    updateSingleFileUploadUi(input);
  }

  function bindFileTrigger(container) {
    container.querySelectorAll('[data-file-trigger]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.fileTrigger)?.click();
      });
    });
    container.querySelectorAll('[data-file-clear]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        clearFileInput(btn.dataset.fileClear);
      });
    });
    container.querySelectorAll('input[type="file"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.multiple) {
          addSelectedFiles(input.id, Array.from(input.files || []));
          input.value = '';
        } else {
          updateSingleFileUploadUi(input);
        }
      });
      renderFileList(input.id);
    });
    container.addEventListener('click', (event) => {
      const previewBtn = event.target.closest('[data-file-preview]');
      if (previewBtn && container.contains(previewBtn)) {
        event.stopPropagation();
        openFilePreview(previewBtn.dataset.filePreview, Number(previewBtn.dataset.fileIndex));
        return;
      }
      const removeBtn = event.target.closest('[data-file-remove]');
      if (!removeBtn || !container.contains(removeBtn)) return;
      event.stopPropagation();
      removeSelectedFile(removeBtn.dataset.fileRemove, Number(removeBtn.dataset.fileIndex));
    });
  }

  function modalTabsHtml(tabs) {
    return `<div class="study-modal-tabs">${tabs.map((tab, i) =>
      `<button type="button" class="study-modal-tab${i === 0 ? ' is-active' : ''}" data-tab="${tab.id}">${tab.label}</button>`
    ).join('')}</div>`;
  }

  function buildAudioModal() {
    modalBody.innerHTML = `
      ${modalTabsHtml([
        { id: 'upload', label: 'Upload file' },
        { id: 'record', label: 'Record audio' }
      ])}
      <div class="study-modal-panel" data-panel="upload">
        ${uploadPlusHtml({ id: 'modal-audio-file', accept: 'audio/*', hint: 'MP3, M4A, WAV supported', label: 'Browse audio file' })}
      </div>
      <div class="study-modal-panel" data-panel="record" hidden>
        <div class="study-recorder">
          <div class="study-recorder-status">
            <span class="study-recorder-dot" id="modal-recorder-dot"></span>
            <span id="modal-recorder-status">Ready to record</span>
          </div>
          <div class="study-recorder-timer" id="modal-recorder-timer">00:00</div>
          <div class="study-recorder-actions">
            <button type="button" class="button button-soft" id="modal-record-start">Start recording</button>
            <button type="button" class="button button-outline" id="modal-record-stop" hidden>Stop</button>
            <button type="button" class="button button-outline" id="modal-record-reset" hidden>Re-record</button>
          </div>
          <audio id="modal-record-preview" class="study-record-preview" controls hidden></audio>
        </div>
      </div>
      <div class="study-modal-actions">
        <button type="button" class="button button-primary" id="modal-audio-submit">Generate smart notes</button>
      </div>`;
    bindFileTrigger(modalBody);
    bindModalTabs(modalBody);
    bindAudioRecorder(modalBody);
    modalBody.querySelector('#modal-audio-submit')?.addEventListener('click', handleAudioSubmit);
  }

  function buildNotesModal() {
    modalBody.innerHTML = `
      ${smartUploadHtml('modal-notes-files')}
      <div class="study-modal-actions">
        <button type="button" class="button button-primary" id="modal-notes-submit">Generate notes</button>
      </div>`;
    bindFileTrigger(modalBody);
    modalBody.querySelector('#modal-notes-submit')?.addEventListener('click', handleNotesSubmit);
  }

  function buildQuizModal() {
    modalBody.innerHTML = `
      ${modalTabsHtml([
        { id: 'upload', label: 'Upload' },
        { id: 'text', label: 'Paste text' }
      ])}
      <div class="study-modal-panel" data-panel="upload">
        ${smartUploadHtml('modal-quiz-files')}
        <div class="study-modal-actions">
          <button type="button" class="button button-primary" id="modal-quiz-upload-submit">Build quiz</button>
        </div>
      </div>
      <div class="study-modal-panel" data-panel="text" hidden>
        <label class="study-field">
          Source material
          <textarea id="modal-quiz-text" rows="7" placeholder="Paste notes, definitions, or chapter text..."></textarea>
        </label>
        <div class="study-modal-actions">
          <button type="button" class="button button-primary" id="modal-quiz-text-submit">Build quiz</button>
        </div>
      </div>`;
    bindFileTrigger(modalBody);
    bindModalTabs(modalBody);
    modalBody.querySelector('#modal-quiz-upload-submit')?.addEventListener('click', handleQuizUploadSubmit);
    modalBody.querySelector('#modal-quiz-text-submit')?.addEventListener('click', handleQuizTextSubmit);
  }

  async function problemFromUploadFiles(files) {
    return problemTextFromFiles(files);
  }

  async function problemFromUploadFile(file) {
    return problemFromUploadFiles([file]);
  }

  async function runSolver(problem) {
    const resultEl = document.getElementById('modal-solver-result');
    if (!resultEl) return;
    resultEl.hidden = false;
    setLoading(resultEl, 'Solving step by step...');
    try {
      const data = await solveProblem(problem);
      renderSolverResult(resultEl, data);
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      resultEl.innerHTML = `<p class="study-error">${err.message}</p>`;
    }
  }

  function solverModeTabsHtml(tabs) {
    const meta = {
      type: {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
        desc: 'Paste or write your question'
      },
      upload: {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>',
        desc: 'PDF, photo, or screenshot'
      }
    };
    return `<div class="solver-mode-picker" role="tablist" aria-label="How to add your problem">${tabs.map((tab, i) => {
      const info = meta[tab.id] || { icon: '', desc: '' };
      return `<button type="button" class="study-mode-card study-modal-tab${i === 0 ? ' is-active' : ''}" data-tab="${tab.id}" role="tab" aria-selected="${i === 0 ? 'true' : 'false'}">
        <span class="study-mode-card-icon" aria-hidden="true">${info.icon}</span>
        <span class="study-mode-card-title">${tab.label}</span>
        <span class="study-mode-card-desc">${info.desc}</span>
      </button>`;
    }).join('')}</div>`;
  }

  function buildSolverModal() {
    modalBody.innerHTML = `
      ${solverModeTabsHtml([
        { id: 'type', label: 'Type problem' },
        { id: 'upload', label: 'Upload file' }
      ])}
      <div class="study-modal-panel solver-panel" data-panel="type">
        <textarea id="modal-solver-text" class="study-text-input solver-problem-input" rows="6" placeholder="e.g. A car travels 60 m in 5 s. What is its velocity?"></textarea>
        <div class="study-modal-actions">
          <button type="button" class="button button-primary study-solver-submit" id="modal-solver-type-submit">Solve step by step</button>
        </div>
      </div>
      <div class="study-modal-panel solver-panel" data-panel="upload" hidden>
        ${smartUploadHtml('modal-solver-file')}
        <div class="study-modal-actions">
          <button type="button" class="button button-primary study-solver-submit" id="modal-solver-upload-submit">Solve step by step</button>
        </div>
      </div>
      <div id="modal-solver-result" class="study-solver-result" hidden></div>`;
    bindFileTrigger(modalBody);
    bindModalTabs(modalBody);
    modalBody.querySelector('#modal-solver-upload-submit')?.addEventListener('click', handleSolverUploadSubmit);
    modalBody.querySelector('#modal-solver-type-submit')?.addEventListener('click', handleSolverTypeSubmit);
    initAutoGrowTextareas(modalBody);
  }

  function buildPodcastModal() {
    modalBody.innerHTML = `
      ${modalTabsHtml([
        { id: 'upload', label: 'Upload' },
        { id: 'text', label: 'Paste text' }
      ])}
      <label class="study-field">
        Episode title <span class="study-field-optional">(optional)</span>
        <input id="modal-podcast-title" type="text" placeholder="e.g. Biology midterm review" maxlength="80" />
      </label>
      <label class="study-field">
        Podcast style
        <select id="modal-podcast-style">
          <option value="conversational">Conversational</option>
          <option value="lecture">Lecture style</option>
          <option value="interview">Interview</option>
        </select>
      </label>
      <div class="study-modal-panel" data-panel="upload">
        ${smartUploadHtml('modal-podcast-files')}
        <div class="study-modal-actions">
          <button type="button" class="button button-primary" id="modal-podcast-upload-submit">Generate podcast</button>
        </div>
      </div>
      <div class="study-modal-panel" data-panel="text" hidden>
        <label class="study-field">
          Source material
          <textarea id="modal-podcast-text" rows="7" placeholder="Paste notes, chapter text, or lecture summary..."></textarea>
        </label>
        <div class="study-modal-actions">
          <button type="button" class="button button-primary" id="modal-podcast-text-submit">Generate podcast</button>
        </div>
      </div>`;
    bindFileTrigger(modalBody);
    bindModalTabs(modalBody);
    modalBody.querySelector('#modal-podcast-upload-submit')?.addEventListener('click', handlePodcastUploadSubmit);
    modalBody.querySelector('#modal-podcast-text-submit')?.addEventListener('click', handlePodcastTextSubmit);
  }

  function bindModalTabs(container) {
    const tabs = container.querySelectorAll('.study-modal-tab');
    const panels = container.querySelectorAll('.study-modal-panel');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((item) => {
          const active = item === tab;
          item.classList.toggle('is-active', active);
          if (item.hasAttribute('aria-selected')) {
            item.setAttribute('aria-selected', active ? 'true' : 'false');
          }
        });
        panels.forEach((panel) => {
          panel.hidden = panel.dataset.panel !== tab.dataset.tab;
        });
        if (activeTool === 'audio' && tab.dataset.tab !== 'record' && mediaRecorder?.state === 'recording') {
          stopRecording();
        }
      });
    });
  }

  function formatRecordTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function setRecorderUi(container, state) {
    const dot = container.querySelector('#modal-recorder-dot');
    const status = container.querySelector('#modal-recorder-status');
    const startBtn = container.querySelector('#modal-record-start');
    const stopBtn = container.querySelector('#modal-record-stop');
    const resetBtn = container.querySelector('#modal-record-reset');
    const isRecording = state === 'recording';
    const hasRecording = state === 'ready' && !!recordedBlob;
    dot?.classList.toggle('is-recording', isRecording);
    if (startBtn) startBtn.hidden = isRecording || hasRecording;
    if (stopBtn) stopBtn.hidden = !isRecording;
    if (resetBtn) resetBtn.hidden = !hasRecording;
    if (status) {
      status.textContent = isRecording
        ? 'Recording in progress'
        : hasRecording
          ? 'Recording saved — preview or generate notes'
          : 'Ready to record';
    }
  }

  function stopRecordStream() {
    recordStream?.getTracks().forEach((track) => track.stop());
    recordStream = null;
  }

  function clearRecordTimer() {
    if (recordTimerId) {
      clearInterval(recordTimerId);
      recordTimerId = null;
    }
  }

  function resetRecording() {
    resettingRecorder = true;
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    clearRecordTimer();
    stopRecordStream();
    mediaRecorder = null;
    audioChunks = [];
    recordedBlob = null;
    const timerEl = modalBody.querySelector('#modal-recorder-timer');
    const previewEl = modalBody.querySelector('#modal-record-preview');
    if (timerEl) timerEl.textContent = '00:00';
    if (previewEl) {
      if (previewEl.src) URL.revokeObjectURL(previewEl.src);
      previewEl.removeAttribute('src');
      previewEl.hidden = true;
      previewEl.load();
    }
    resettingRecorder = false;
    setRecorderUi(modalBody, 'idle');
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Recording is not supported in this browser.');
      return;
    }
    resetRecording();
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      mediaRecorder = mimeType ? new MediaRecorder(recordStream, { mimeType }) : new MediaRecorder(recordStream);
      audioChunks = [];
      mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) audioChunks.push(event.data);
      });
      mediaRecorder.addEventListener('stop', () => {
        if (resettingRecorder) return;
        clearRecordTimer();
        stopRecordStream();
        recordedBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const previewEl = modalBody.querySelector('#modal-record-preview');
        if (previewEl) {
          previewEl.src = URL.createObjectURL(recordedBlob);
          previewEl.hidden = false;
          previewEl.load();
        }
        setRecorderUi(modalBody, 'ready');
      });
      mediaRecorder.start();
      recordStartTime = Date.now();
      const timerEl = modalBody.querySelector('#modal-recorder-timer');
      if (timerEl) timerEl.textContent = '00:00';
      recordTimerId = setInterval(() => {
        if (timerEl) timerEl.textContent = formatRecordTime(Date.now() - recordStartTime);
      }, 250);
      setRecorderUi(modalBody, 'recording');
    } catch {
      resetRecording();
      alert('Microphone access was denied or unavailable.');
    }
  }

  function stopRecording() {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  }

  function bindAudioRecorder(container) {
    container.querySelector('#modal-record-start')?.addEventListener('click', startRecording);
    container.querySelector('#modal-record-stop')?.addEventListener('click', stopRecording);
    container.querySelector('#modal-record-reset')?.addEventListener('click', resetRecording);
    setRecorderUi(container, 'idle');
  }

  async function handleAudioSubmit() {
    const uploadPanel = modalBody.querySelector('[data-panel="upload"]');
    const isUpload = !uploadPanel?.hidden;
    let file = null;

    if (isUpload) {
      file = document.getElementById('modal-audio-file')?.files?.[0];
      if (!file) return alert('Choose an audio file first.');
    } else {
      if (mediaRecorder?.state === 'recording') return alert('Stop recording first.');
      if (!recordedBlob) return alert('Record audio first.');
      const ext = recordedBlob.type.includes('webm') ? 'webm' : 'm4a';
      file = new File([recordedBlob], `lecture-recording-${Date.now()}.${ext}`, { type: recordedBlob.type });
    }

    closeModal();
    showWorkspaceResult('audio', '');
    setLoading(workspaceResult, 'Generating smart notes...');
    try {
      const data = await uploadAudio(file);
      renderNotesResult(workspaceResult, data);
    } catch (err) {
      workspaceResult.textContent = err.message;
    }
  }

  async function handleNotesSubmit() {
    const files = getSelectedFiles('modal-notes-files');
    if (!files.length) return alert('Add at least one file — PDF, Word, image, or text.');
    closeModal();
    showWorkspaceResult('notes', '');
    setLoading(workspaceResult, `Generating notes from ${files.length} file${files.length > 1 ? 's' : ''}...`);
    try {
      const data = await uploadNotesFiles(files);
      renderNotesResult(workspaceResult, data);
    } catch (err) {
      workspaceResult.textContent = err.message;
    }
  }

  async function handleQuizUploadSubmit() {
    const files = getSelectedFiles('modal-quiz-files');
    if (!files.length) return alert('Add at least one file first.');
    closeModal();
    showWorkspaceResult('quiz', '');
    setLoading(workspaceResult, `Building quiz from ${files.length} file${files.length > 1 ? 's' : ''}...`);
    try {
      const notesData = await uploadNotesFiles(files);
      const source = (notesData.notes?.bullets || []).join('\n');
      const data = await generateQuizFromText(source || files.map((f) => f.name).join(', '));
      renderQuizResult(workspaceResult, data);
    } catch (err) {
      workspaceResult.textContent = err.message;
    }
  }

  async function handleSolverUploadSubmit() {
    const files = getSelectedFiles('modal-solver-file');
    if (!files.length) return alert('Add at least one file first, or switch to Type.');
    try {
      const problem = await problemFromUploadFiles(files);
      if (!problem) return alert('Could not read a problem from those files.');
      await runSolver(problem);
    } catch (err) {
      alert(err.message || 'Upload failed.');
    }
  }

  async function handleSolverTypeSubmit() {
    const problem = document.getElementById('modal-solver-text')?.value.trim();
    if (!problem) return alert('Enter a problem to solve.');
    await runSolver(problem);
  }

  async function runPodcast(sourceText, options = {}) {
    closeModal();
    showWorkspaceResult('podcast', '');
    setLoading(workspaceResult, 'Generating your study podcast...');
    try {
      const data = await generatePodcast({
        text: sourceText,
        title: options.title || '',
        style: options.style || 'conversational'
      });
      renderPodcastResult(workspaceResult, data);
    } catch (err) {
      workspaceResult.textContent = err.message;
    }
  }

  async function handlePodcastUploadSubmit() {
    const files = getSelectedFiles('modal-podcast-files');
    const title = document.getElementById('modal-podcast-title')?.value.trim() || '';
    const style = document.getElementById('modal-podcast-style')?.value || 'conversational';
    if (!files.length) return alert('Add at least one file first.');
    try {
      const notesData = await uploadNotesFiles(files);
      const source = (notesData.notes?.bullets || []).join('\n');
      await runPodcast(source || files.map((f) => f.name).join(', '), { title, style });
    } catch (err) {
      alert(err.message || 'Upload failed.');
    }
  }

  async function handlePodcastTextSubmit() {
    const text = document.getElementById('modal-podcast-text')?.value.trim();
    const title = document.getElementById('modal-podcast-title')?.value.trim() || '';
    const style = document.getElementById('modal-podcast-style')?.value || 'conversational';
    if (!text) return alert('Paste some source material first.');
    await runPodcast(text, { title, style });
  }

  function openModal(tool) {
    activeTool = tool;
    const meta = TOOL_META[tool];
    modalTitle.textContent = meta.title;
    modalDesc.textContent = meta.desc;
    modalIcon.innerHTML = meta.icon;
    resetRecording();

    if (tool === 'audio') buildAudioModal();
    else if (tool === 'notes') buildNotesModal();
    else if (tool === 'quiz') buildQuizModal();
    else if (tool === 'solver') buildSolverModal();
    else if (tool === 'podcast') buildPodcastModal();

    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    toolCards.forEach((card) => card.classList.toggle('is-active', card.dataset.tool === tool));
  }

  function closeModal() {
    closeFilePreview();
    if (mediaRecorder?.state === 'recording') stopRecording();
    else stopRecordStream();
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    toolCards.forEach((card) => card.classList.remove('is-active'));
    activeTool = null;
  }

  toolCards.forEach((card) => {
    card.addEventListener('click', () => openModal(card.dataset.tool));
  });

  modal.querySelectorAll('[data-modal-close]').forEach((el) => {
    el.addEventListener('click', closeModal);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });

  window.addEventListener('beforeunload', () => {
    if (mediaRecorder?.state === 'recording') stopRecording();
    else stopRecordStream();
  });
});

/* Sign in modal */
function getSignInModalMarkup() {
  return `
    <div id="signin-modal" class="study-modal signin-modal" hidden aria-hidden="true">
      <div class="study-modal-backdrop" data-signin-close></div>
      <div class="study-modal-dialog signin-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="signin-title">
        <button type="button" class="study-modal-close" data-signin-close aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="signin-card">
          <div class="signin-modal-head">
            <p class="eyebrow">Account</p>
            <h2 id="signin-title">Sign in to BipoAi</h2>
            <p class="signin-modal-desc">Access your study sets, Ai Study +, and saved progress.</p>
          </div>

          <div class="signin-oauth">
            <div class="oauth-provider-block">
              <button type="button" class="oauth-btn oauth-google button-soft" id="signin-google" aria-expanded="false" aria-controls="google-account-panel">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                Continue with Google
              </button>
              <div id="google-account-panel" class="provider-account-panel provider-google" hidden>
                <p class="provider-account-label">Choose a Google account</p>
                <div id="google-account-list" class="provider-account-list"></div>
                <button type="button" class="provider-account-add" data-provider="google">Use another Google account</button>
              </div>
            </div>

            <div class="oauth-provider-block">
              <button type="button" class="oauth-btn oauth-apple button-soft" id="signin-apple" aria-expanded="false" aria-controls="apple-account-panel">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.365 1.43c0 1.14-.417 2.087-1.25 2.84-.898.812-1.966 1.21-3.115 1.137-.045-1.098.417-2.11 1.242-2.886.884-.84 2.03-1.31 3.123-1.091zm3.08 16.64c-.735 1.68-1.08 2.43-2.02 3.92-1.31 2.01-3.16 4.52-5.45 4.54-1.02.01-1.75-.67-3.26-.67-1.52 0-2.06.65-3.17.68-2.28.08-4.02-2.18-5.33-4.18-2.92-4.47-3.24-9.71-1.43-12.49 1.27-1.84 3.28-2.93 5.16-2.93 1.21 0 2.22.67 3.35.67 1.1 0 1.78-.67 3.36-.67 1.2 0 2.47.65 3.74 1.78-3.29 1.8-2.76 6.48.53 7.97z"/></svg>
                Continue with Apple
              </button>
              <div id="apple-account-panel" class="provider-account-panel provider-apple" hidden>
                <p class="provider-account-label">Choose an Apple account</p>
                <div id="apple-account-list" class="provider-account-list"></div>
                <button type="button" class="provider-account-add" data-provider="apple">Use another Apple ID</button>
              </div>
            </div>
          </div>
          <p id="signin-oauth-result" class="signin-oauth-result" hidden></p>
          <p id="signin-oauth-note" class="signin-oauth-note" hidden></p>

          <div class="signin-divider"><span>or continue with email</span></div>

          <form id="signin-form" class="form-grid" novalidate>
            <label id="signin-name-field" style="display:none">
              Full name
              <input name="name" placeholder="Your name" />
            </label>
            <label>
              Email
              <input name="email" type="email" required placeholder="you@domain.com" />
            </label>
            <label>
              Password
              <input name="password" type="password" required placeholder="Enter your password" minlength="6" />
            </label>

            <div class="signin-actions">
              <button type="submit" class="button button-soft" id="signin-submit">Sign in</button>
              <div id="signin-result" style="color:var(--muted)"></div>
            </div>
          </form>

          <p class="signin-switch">
            <span id="signin-switch-text">Don't have an account?</span>
            <button type="button" class="signin-toggle" id="signin-toggle">Create one</button>
          </p>
        </div>
      </div>
    </div>`;
}

function ensureSignInModal() {
  if (document.getElementById('signin-modal')) return;
  document.body.insertAdjacentHTML('beforeend', getSignInModalMarkup());
}

function openSignInModal() {
  ensureSignInModal();
  const modal = document.getElementById('signin-modal');
  if (!modal || getCurrentUser()) return;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  document.getElementById('signin-form')?.email?.focus();
}

function closeSignInModal() {
  const modal = document.getElementById('signin-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  document.getElementById('google-account-panel') && (document.getElementById('google-account-panel').hidden = true);
  document.getElementById('apple-account-panel') && (document.getElementById('apple-account-panel').hidden = true);
  document.getElementById('signin-google')?.setAttribute('aria-expanded', 'false');
  document.getElementById('signin-apple')?.setAttribute('aria-expanded', 'false');
  if (location.hash === '#signin') {
    history.replaceState({}, '', location.pathname + location.search);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  ensureSignInModal();
  const form = document.getElementById('signin-form');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = 'true';

  let mode = 'signin';
  const modal = document.getElementById('signin-modal');
  const title = document.getElementById('signin-title');
  const submitBtn = document.getElementById('signin-submit');
  const toggleBtn = document.getElementById('signin-toggle');
  const switchText = document.getElementById('signin-switch-text');
  const nameField = document.getElementById('signin-name-field');
  const result = document.getElementById('signin-result');
  const googleBtn = document.getElementById('signin-google');
  const appleBtn = document.getElementById('signin-apple');
  const oauthNote = document.getElementById('signin-oauth-note');
  const oauthResult = document.getElementById('signin-oauth-result');

  function showOAuthMessage(message, state = 'info') {
    if (!oauthResult) {
      result.textContent = message;
      return;
    }
    oauthResult.hidden = !message;
    oauthResult.textContent = message || '';
    oauthResult.dataset.state = state;
  }

  async function completeAuth(data) {
    if (data?.user?.provider && data.user.email) {
      saveProviderAccount(data.user.provider, {
        email: data.user.email,
        name: data.user.name || data.user.email
      });
    }
    setCurrentUser(data.user, data.token);
    resetUserDataCache();
    await migrateGuestToUser();
    await refreshAllData();
    showOAuthMessage(
      data?.supabase ? 'Signed in and saved to your account.' : 'Signed in successfully.',
      'success'
    );
    closeSignInModal();
    updateNavAuth();
  }

  const defaultAccounts = {
    google: [
      { email: 'student@gmail.com', name: 'Student Gmail' },
      { email: 'study.bipai@gmail.com', name: 'BipoAi Study' },
      { email: 'workspace@gmail.com', name: 'Work Gmail' }
    ],
    apple: [
      { email: 'student@icloud.com', name: 'Student iCloud' },
      { email: 'study@privaterelay.appleid.com', name: 'Hide My Email' },
      { email: 'family@icloud.com', name: 'Family Apple ID' }
    ]
  };

  function getSavedProviderAccounts(provider) {
    try {
      return JSON.parse(localStorage.getItem(`bipai.accounts.${provider}`) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveProviderAccount(provider, account) {
    const saved = getSavedProviderAccounts(provider).filter((item) => item.email !== account.email);
    saved.unshift(account);
    localStorage.setItem(`bipai.accounts.${provider}`, JSON.stringify(saved.slice(0, 5)));
  }

  function mergeAccounts(provider) {
    const seen = new Set();
    return [...getSavedProviderAccounts(provider), ...defaultAccounts[provider]].filter((account) => {
      if (seen.has(account.email)) return false;
      seen.add(account.email);
      return true;
    });
  }

  function getInitials(name) {
    return (name || '?')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || '')
      .join('') || '?';
  }

  const googlePanel = document.getElementById('google-account-panel');
  const applePanel = document.getElementById('apple-account-panel');
  const googleList = document.getElementById('google-account-list');
  const appleList = document.getElementById('apple-account-list');
  let googleCodeClient = null;
  let appleReady = false;

  function closeAllProviderPanels() {
    if (googlePanel) googlePanel.hidden = true;
    if (applePanel) applePanel.hidden = true;
    googleBtn?.setAttribute('aria-expanded', 'false');
    appleBtn?.setAttribute('aria-expanded', 'false');
  }

  function openProviderPanel(provider) {
    const panel = provider === 'google' ? googlePanel : applePanel;
    const button = provider === 'google' ? googleBtn : appleBtn;
    const otherPanel = provider === 'google' ? applePanel : googlePanel;
    const otherButton = provider === 'google' ? appleBtn : googleBtn;

    if (!panel || !button) return;

    if (otherPanel) otherPanel.hidden = true;
    otherButton?.setAttribute('aria-expanded', 'false');
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  function toggleProviderPanel(provider) {
    const panel = provider === 'google' ? googlePanel : applePanel;
    if (!panel) return;
    if (panel.hidden) openProviderPanel(provider);
    else closeAllProviderPanels();
  }

  function renderProviderAccounts(provider, listEl, onSelect) {
    if (!listEl) return;

    const accounts = mergeAccounts(provider);
    listEl.innerHTML = accounts.map((account) => `
      <button type="button" class="account-option" data-email="${account.email}">
        <span class="account-avatar ${provider}">${getInitials(account.name)}</span>
        <span>
          <strong>${account.name}</strong>
          <span>${account.email}</span>
        </span>
      </button>
    `).join('');

    listEl.querySelectorAll('.account-option').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const account = accounts.find((item) => item.email === button.dataset.email);
        if (!account) return;
        button.disabled = true;
        try {
          await onSelect(account);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  async function signInWithDemoAccount(provider, account) {
    showOAuthMessage(`Signing in as ${account.email}...`, 'info');
    const data = await signInWithDemo(provider, account);
    await completeAuth(data);
  }

  async function handleGoogleAccount(account) {
    closeAllProviderPanels();
    try {
      await signInWithDemoAccount('google', account);
    } catch (err) {
      showOAuthMessage(err.message, 'error');
    }
  }

  async function startGoogleOAuth() {
    if (!googleCodeClient) {
      showOAuthMessage('Google OAuth is not configured. Pick an account from the list instead.', 'error');
      return;
    }

    showOAuthMessage('Opening Google sign-in...', 'info');
    googleCodeClient.requestCode();
  }

  async function handleAppleAccount(account) {
    closeAllProviderPanels();
    if (appleReady) {
      showOAuthMessage(`Continue in Apple as ${account.email}...`, 'info');
      try {
        const response = await AppleID.auth.signIn();
        const idToken = response?.authorization?.id_token;
        if (!idToken) throw new Error('Apple did not return an identity token.');

        const appleName = response?.user?.name;
        const name = appleName
          ? `${appleName.firstName || ''} ${appleName.lastName || ''}`.trim()
          : account.name;

        showOAuthMessage('Signing in with Apple...', 'info');
        const data = await signInWithProvider('apple', { idToken, name });
        await completeAuth(data);
      } catch (err) {
        if (err?.error === 'popup_closed_by_user') return;
        showOAuthMessage(err.message || 'Apple sign-in failed.', 'error');
      }
      return;
    }

    try {
      await signInWithDemoAccount('apple', account);
    } catch (err) {
      showOAuthMessage(err.message, 'error');
    }
  }

  async function handleAnotherAccount(provider) {
    closeAllProviderPanels();

    if (provider === 'google') {
      if (googleCodeClient) {
        await startGoogleOAuth();
        return;
      }

      const email = prompt('Enter your Google email address:');
      if (!email) return;
      const name = email.split('@')[0].replace(/[._-]/g, ' ');
      try {
        await signInWithDemoAccount('google', { email, name });
      } catch (err) {
        showOAuthMessage(err.message, 'error');
      }
      return;
    }

    if (provider === 'apple' && appleReady) {
      showOAuthMessage('Choose an account in Apple...', 'info');
      try {
        const response = await AppleID.auth.signIn();
        const idToken = response?.authorization?.id_token;
        if (!idToken) throw new Error('Apple did not return an identity token.');
        const appleName = response?.user?.name;
        const name = appleName
          ? `${appleName.firstName || ''} ${appleName.lastName || ''}`.trim()
          : undefined;
        const data = await signInWithProvider('apple', { idToken, name });
        await completeAuth(data);
      } catch (err) {
        if (err?.error === 'popup_closed_by_user') return;
        showOAuthMessage(err.message || 'Apple sign-in failed.', 'error');
      }
      return;
    }

    const email = prompt('Enter your Apple ID email address:');
    if (!email) return;
    const name = email.split('@')[0].replace(/[._-]/g, ' ');
    try {
      await signInWithDemoAccount('apple', { email, name });
    } catch (err) {
      showOAuthMessage(err.message, 'error');
    }
  }

  renderProviderAccounts('google', googleList, handleGoogleAccount);
  renderProviderAccounts('apple', appleList, handleAppleAccount);

  googleBtn?.addEventListener('click', () => {
    showOAuthMessage('');
    toggleProviderPanel('google');
  });

  appleBtn?.addEventListener('click', () => {
    showOAuthMessage('');
    toggleProviderPanel('apple');
  });

  document.querySelectorAll('.provider-account-add').forEach((button) => {
    button.addEventListener('click', () => {
      handleAnotherAccount(button.dataset.provider);
    });
  });

  async function initOAuthProviders() {
    let config = { googleEnabled: false, appleEnabled: false };
    try {
      config = await fetchAuthConfig();
    } catch (err) {
      return;
    }

    const notes = [];

    if (config.googleEnabled) {
      try {
        await loadScript('https://accounts.google.com/gsi/client');
        googleCodeClient = google.accounts.oauth2.initCodeClient({
          client_id: config.googleClientId,
          scope: 'openid email profile',
          ux_mode: 'popup',
          callback: async (response) => {
            if (response.error) {
              showOAuthMessage(response.error, 'error');
              return;
            }
            showOAuthMessage('Signing in with Google...', 'info');
            try {
              const data = await signInWithProvider('google', { code: response.code });
              await completeAuth(data);
            } catch (err) {
              showOAuthMessage(err.message, 'error');
            }
          }
        });
      } catch (err) {
        notes.push('Google popup sign-in could not be initialized.');
      }
    }

    if (config.appleEnabled) {
      try {
        await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js');
        AppleID.auth.init({
          clientId: config.appleClientId,
          scope: 'name email',
          redirectURI: config.appleRedirectUri,
          usePopup: true
        });
        appleReady = true;
      } catch (err) {
        notes.push('Apple popup sign-in could not be initialized.');
      }
    }

    if (notes.length) {
      oauthNote.hidden = false;
      oauthNote.textContent = notes.join(' ');
    } else if (config.supabaseAuth) {
      oauthNote.hidden = false;
      oauthNote.textContent = 'Email sign-in is secured with Supabase Auth.';
    }
  }

  initOAuthProviders();

  toggleBtn?.addEventListener('click', () => {
    mode = mode === 'signin' ? 'signup' : 'signin';
    title.textContent = mode === 'signin' ? 'Sign in to BipoAi' : 'Create your BipoAi account';
    submitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    switchText.textContent = mode === 'signin' ? "Don't have an account?" : 'Already have an account?';
    toggleBtn.textContent = mode === 'signin' ? 'Create one' : 'Sign in';
    nameField.style.display = mode === 'signup' ? 'block' : 'none';
    result.textContent = '';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    result.textContent = 'Please wait...';

    const email = form.email.value.trim();
    const password = form.password.value;
    const name = form.name?.value.trim();

    try {
      const data = mode === 'signin'
        ? await signIn(email, password)
        : await signUp(email, password, name);

      if (data.needsEmailConfirmation) {
        result.textContent = data.message || 'Check your email to confirm your account, then sign in.';
        mode = 'signin';
        title.textContent = 'Sign in to BipoAi';
        submitBtn.textContent = 'Sign in';
        switchText.textContent = "Don't have an account?";
        toggleBtn.textContent = 'Create one';
        nameField.style.display = 'none';
        return;
      }

      await completeAuth(data);
    } catch (err) {
      result.textContent = err.message;
    }
  });

  modal?.querySelectorAll('[data-signin-close]').forEach((el) => {
    el.addEventListener('click', closeSignInModal);
  });

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-signin-open]');
    if (!trigger) return;
    event.preventDefault();
    openSignInModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && !modal.hidden) closeSignInModal();
  });

  if (new URLSearchParams(window.location.search).get('signin') === '1') {
    openSignInModal();
    const url = new URL(window.location.href);
    url.searchParams.delete('signin');
    history.replaceState({}, '', url.pathname + url.hash);
  } else if (window.location.hash === '#signin') {
    openSignInModal();
  }
});

/* Study session results: notes, flashcards, quiz, podcast */
document.addEventListener('DOMContentLoaded', () => {
  const resultsEl = document.getElementById('study-results');
  if (!resultsEl) return;

  const isDashboard = document.body.dataset.page === 'dashboard';
  const workspaceEl = document.getElementById('study-workspace');
  const dashPanels = isDashboard ? Array.from(document.querySelectorAll('[data-dash-panel]')) : [];
  const hub = document.getElementById('study-session');
  const modeButtons = document.querySelectorAll('.study-session-card .file-type-picker:not(.study-solver-modes) .file-type-btn');
  const modePanels = document.querySelectorAll('.study-mode-panel');
  const sessionNameInput = document.getElementById('session-name');
  const progressItems = document.querySelectorAll('#session-progress .session-check-item');
  const loadingPanel = document.getElementById('study-loading');
  const loadingText = document.getElementById('study-loading-text');
  const loadingBar = document.getElementById('study-loading-bar');
  const loadingSteps = document.querySelectorAll('#study-loading-steps [data-load-step]');
  const fileInput = document.getElementById('study-file-input');
  const fileTrigger = document.getElementById('study-file-trigger');
  const dropZone = document.getElementById('study-drop-zone');
  const fileListEl = document.getElementById('study-file-list');
  const pasteEl = document.getElementById('study-paste-text');
  const urlInput = document.getElementById('study-url-input');
  const generateBtn = document.getElementById('study-generate-btn');
  const statusEl = document.getElementById('study-generate-status');
  const resultsTitle = document.getElementById('study-results-title');
  const resultsMeta = document.getElementById('study-results-meta');
  const tabButtons = document.querySelectorAll('#study-results .study-tab');
  const panels = {
    notes: document.getElementById('study-tab-notes'),
    flashcards: document.getElementById('study-tab-flashcards'),
    quiz: document.getElementById('study-tab-quiz'),
    podcast: document.getElementById('study-tab-podcast')
  };
  const newSessionBtn = document.getElementById('study-new-session-btn');
  const deleteSessionBtn = document.getElementById('study-delete-session-btn');
  const sessionProgressCard = document.getElementById('session-progress');

  let currentSessionId = null;

  const audioFileInput = document.getElementById('audio-file-input');
  const audioFileTrigger = document.getElementById('audio-file-trigger');
  const audioFileName = document.getElementById('audio-file-name');
  const recordStart = document.getElementById('record-start');
  const recordStop = document.getElementById('record-stop');
  const recordReset = document.getElementById('record-reset');
  const recordDot = document.getElementById('recorder-dot');
  const recordTime = document.getElementById('recorder-time');
  const recordPreview = document.getElementById('record-preview');

  let activeMode = 'files';
  let selectedFiles = [];
  let uploadedAudioFile = null;
  let sessionData = null;
  let mediaRecorder = null;
  let recordStream = null;
  let audioChunks = [];
  let recordedBlob = null;
  let recordTimerId = null;
  let recordStartTime = 0;

  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      activeMode = btn.dataset.mode;
      modeButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      modePanels.forEach((p) => { p.hidden = p.dataset.modePanel !== activeMode; });
      setStatus('');
    });
  });

  function showDashOverview() {
    exitDashboardStudyView();
    dashPanels.forEach((panel) => {
      panel.hidden = panel.dataset.dashPanel !== 'overview';
    });
    document.querySelectorAll('[data-sidebar-section]').forEach((item) => {
      const href = item.getAttribute('href') || '';
      item.classList.toggle('is-active', href === '#dashboard-overview');
    });
    history.replaceState(null, '', '#dashboard-overview');
    notifyDashboardPanelChange('overview');
  }

  function showResultsOnly() {
    document.body.classList.add('study-has-session');
    if (workspaceEl) workspaceEl.hidden = false;
    resultsEl.hidden = false;
    if (isDashboard) {
      dashPanels.forEach((panel) => { panel.hidden = true; });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showCreateForm() {
    sessionData = null;
    currentSessionId = null;
    if (deleteSessionBtn) deleteSessionBtn.hidden = true;
    if (isDashboard) {
      showDashOverview();
    } else {
      exitDashboardStudyView();
      history.replaceState({}, '', 'dashboard.html');
      hub?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  window.addEventListener('bipai:dashboard-panel', () => {
    sessionData = null;
    currentSessionId = null;
    if (deleteSessionBtn) deleteSessionBtn.hidden = true;
  });

  function syncReadingTabs(flags) {
    const {
      hasNotes,
      hasFlashcards,
      hasQuiz,
      hasPodcast,
      pendingNotes = false,
      pendingFlashcards = false,
      pendingPodcast = false
    } = flags;
    const visible = {
      notes: hasNotes || pendingNotes,
      flashcards: hasFlashcards || pendingFlashcards,
      quiz: hasQuiz,
      podcast: hasPodcast || pendingPodcast
    };
    const ready = {
      notes: hasNotes && !pendingNotes,
      flashcards: hasFlashcards && !pendingFlashcards,
      quiz: hasQuiz,
      podcast: hasPodcast && !pendingPodcast
    };
    tabButtons.forEach((btn) => {
      btn.hidden = !visible[btn.dataset.tab];
      btn.classList.remove('is-active');
    });
    progressItems.forEach((item) => {
      const tab = item.dataset.goto;
      const show = visible[tab];
      item.hidden = !show;
      item.classList.remove('is-done', 'is-pending');
      if (show) {
        if (ready[tab]) item.classList.add('is-done');
        else item.classList.add('is-pending');
      }
      const icon = item.querySelector('.check-icon');
      if (icon) icon.textContent = ready[tab] ? '✓' : show ? '…' : '○';
    });
    if (sessionProgressCard) {
      sessionProgressCard.hidden = !Object.values(visible).some(Boolean);
    }
    return visible;
  }

  function firstReadingTab(map) {
    return ['notes', 'flashcards', 'quiz', 'podcast'].find((tab) => map[tab]) || null;
  }

  async function loadSavedSessionById(id) {
    await ensureDataReady();
    const session = await fetchStudySessionById(id);
    if (!session) return false;
    applyGeneratedSession(session.name, {
      notes: session.notes || {},
      quiz: session.quiz || {},
      flashcards: session.flashcards || [],
      podcast: session.podcast || {},
      sourceText: session.sourceText || session.inputText || '',
      inputType: session.inputType,
      inputText: session.inputText,
      audioUrl: session.audioUrl,
      sessionId: session.id
    }, session.inputType || 'files', { save: false });
    return true;
  }

  newSessionBtn?.addEventListener('click', showCreateForm);

  deleteSessionBtn?.addEventListener('click', async () => {
    if (!currentSessionId) return;
    const title = resultsTitle?.textContent || 'this session';
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      await deleteStudySessionFromDb(currentSessionId);
      showCreateForm();
    } catch {
      setStatus('Could not delete session. Try again.', true);
    }
  });

  function setHowStep() { /* progress shown in session checklist */ }

  function saveStudySession(session) {
    saveStudySessionToDb(session);
  }

  function markProgress(tab) {
    progressItems.forEach((item) => {
      if (item.dataset.goto === tab) {
        item.classList.add('is-done');
        item.querySelector('.check-icon').textContent = '✓';
      }
    });
  }

  progressItems.forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.goto) switchTab(item.dataset.goto);
    });
  });

  function setLoadingProgress(percent) {
    if (loadingBar) loadingBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    const stepIndex = percent < 35 ? 0 : percent < 55 ? 1 : percent < 75 ? 2 : 3;
    loadingSteps.forEach((el, i) => {
      el.classList.toggle('is-active', i === stepIndex);
      el.classList.toggle('is-done', i < stepIndex);
    });
  }

  function clearLoadingTimers() {
    if (!loadingPanel) return;
    if (loadingPanel._msgTimer) clearInterval(loadingPanel._msgTimer);
    if (loadingPanel._progressTimer) clearInterval(loadingPanel._progressTimer);
    loadingPanel._msgTimer = null;
    loadingPanel._progressTimer = null;
  }

  function showLoading(messages) {
    if (!loadingPanel) return;
    loadingPanel.hidden = false;
    if (generateBtn) generateBtn.disabled = true;
    setLoadingProgress(8);

    let i = 0;
    if (loadingText) loadingText.textContent = messages[0] || 'Working…';

    loadingPanel._msgTimer = setInterval(() => {
      i = (i + 1) % messages.length;
      if (loadingText) loadingText.textContent = messages[i];
    }, 2800);

    let progress = 8;
    loadingPanel._progressTimer = setInterval(() => {
      if (progress < 36) {
        progress += 1.2;
        setLoadingProgress(progress);
      }
    }, 700);
  }

  function hideLoading() {
    if (!loadingPanel) return;
    clearLoadingTimers();
    setLoadingProgress(100);
    window.setTimeout(() => {
      loadingPanel.hidden = true;
      if (loadingBar) loadingBar.style.width = '0%';
      loadingSteps.forEach((el) => el.classList.remove('is-active', 'is-done'));
    }, 350);
    if (generateBtn) generateBtn.disabled = false;
  }

  function renderFileList() {
    if (!fileListEl) return;
    if (!selectedFiles.length) { fileListEl.hidden = true; fileListEl.innerHTML = ''; return; }
    fileListEl.hidden = false;
    fileListEl.innerHTML = selectedFiles.map((file, i) => `
      <li class="study-file-chip"><span>${esc(file.name)}</span>
      <button type="button" class="study-file-chip-remove" data-remove-index="${i}" aria-label="Remove">×</button></li>`).join('');
  }

  function addFiles(files) {
    files.forEach((file) => {
      if (!selectedFiles.some((f) => f.name === file.name && f.size === file.size)) selectedFiles.push(file);
    });
    renderFileList();
  }

  fileTrigger?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => { addFiles(Array.from(fileInput.files || [])); fileInput.value = ''; });
  dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-dragover'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('is-dragover'));
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('is-dragover');
    addFiles(Array.from(e.dataTransfer?.files || []));
  });
  fileListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-index]');
    if (!btn) return;
    selectedFiles.splice(Number(btn.dataset.removeIndex), 1);
    renderFileList();
  });

  audioFileTrigger?.addEventListener('click', () => audioFileInput?.click());
  audioFileInput?.addEventListener('change', () => {
    uploadedAudioFile = audioFileInput.files?.[0] || null;
    if (audioFileName) audioFileName.textContent = uploadedAudioFile ? uploadedAudioFile.name : '';
    resetRecording();
  });

  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function resetRecording() {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    recordStream?.getTracks().forEach((t) => t.stop());
    clearInterval(recordTimerId);
    mediaRecorder = null; recordStream = null; audioChunks = []; recordedBlob = null;
    if (recordTime) recordTime.textContent = '00:00';
    if (recordPreview) { recordPreview.hidden = true; recordPreview.removeAttribute('src'); }
    recordDot?.classList.remove('is-recording');
    if (recordStart) recordStart.hidden = false;
    if (recordStop) recordStop.hidden = true;
    if (recordReset) recordReset.hidden = true;
  }

  recordStart?.addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) return alert('Recording not supported in this browser.');
    resetRecording();
    uploadedAudioFile = null;
    if (audioFileName) audioFileName.textContent = '';
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      mediaRecorder = new MediaRecorder(recordStream, { mimeType: mime });
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        clearInterval(recordTimerId);
        recordStream?.getTracks().forEach((t) => t.stop());
        recordedBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
        if (recordPreview) {
          recordPreview.src = URL.createObjectURL(recordedBlob);
          recordPreview.hidden = false;
        }
        recordDot?.classList.remove('is-recording');
        if (recordStart) recordStart.hidden = true;
        if (recordStop) recordStop.hidden = true;
        if (recordReset) recordReset.hidden = false;
      };
      mediaRecorder.start();
      recordStartTime = Date.now();
      recordTimerId = setInterval(() => {
        if (recordTime) recordTime.textContent = formatTime(Date.now() - recordStartTime);
      }, 250);
      recordDot?.classList.add('is-recording');
      if (recordStart) recordStart.hidden = true;
      if (recordStop) recordStop.hidden = false;
    } catch {
      alert('Microphone access denied.');
    }
  });

  recordStop?.addEventListener('click', () => { if (mediaRecorder?.state === 'recording') mediaRecorder.stop(); });
  recordReset?.addEventListener('click', resetRecording);

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.hidden = !msg;
    statusEl.textContent = msg || '';
    statusEl.className = 'study-status-msg' + (isError ? ' study-error' : ' study-success');
  }

  function setLoading(panel, msg) {
    if (panel) panel.innerHTML = `<p class="study-loading">${esc(msg)}</p>`;
  }

  function renderNotesPanel(notes) {
    panels.notes.innerHTML = `
      <h3>${esc(notes.title || 'Notes')}</h3>
      <ul>${(notes.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
  }

  function renderFlashcardsPanel(items) {
    if (!items?.length) {
      panels.flashcards.innerHTML = '<p class="study-result-meta">No flashcards.</p>';
      return;
    }

    panels.flashcards.innerHTML = `
      <div class="study-flashcard-deck" data-fc-deck>
        <div class="study-flashcard-deck-head">
          <p class="study-flashcard-progress">Card <strong data-fc-current>1</strong> of <strong>${items.length}</strong></p>
          <p class="study-result-meta">Swipe or use arrows · tap card to flip</p>
        </div>
        <div class="study-flashcard-stage">
          <button type="button" class="study-flashcard-nav study-flashcard-prev" data-fc-prev aria-label="Previous card">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div class="study-flashcard-viewport" data-fc-viewport>
            <div class="study-flashcard-track" data-fc-track>
              ${items.map((c) => `
                <div class="study-flashcard-slide">
                  <button type="button" class="study-flashcard" data-flip-card>
                    <span class="study-flashcard-label">Question</span>
                    <span class="study-flashcard-front">${esc(c.q)}</span>
                    <span class="study-flashcard-back">${esc(c.a)}</span>
                  </button>
                </div>`).join('')}
            </div>
          </div>
          <button type="button" class="study-flashcard-nav study-flashcard-next" data-fc-next aria-label="Next card">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
        <div class="study-flashcard-dots" data-fc-dots>
          ${items.map((_, i) => `<button type="button" class="study-flashcard-dot${i === 0 ? ' is-active' : ''}" data-fc-dot="${i}" aria-label="Go to card ${i + 1}"></button>`).join('')}
        </div>
      </div>`;

    const deck = panels.flashcards.querySelector('[data-fc-deck]');
    const track = deck.querySelector('[data-fc-track]');
    const viewport = deck.querySelector('[data-fc-viewport]');
    const currentEl = deck.querySelector('[data-fc-current]');
    const prevBtn = deck.querySelector('[data-fc-prev]');
    const nextBtn = deck.querySelector('[data-fc-next]');
    const dots = deck.querySelectorAll('[data-fc-dot]');
    let index = 0;
    let startX = 0;
    let dragging = false;

    function slideWidth() {
      return viewport.offsetWidth || 1;
    }

    function updateTrack(animate = true) {
      track.style.transition = animate ? 'transform 0.32s cubic-bezier(0.4, 0, 0.2, 1)' : 'none';
      track.style.transform = `translateX(-${index * slideWidth()}px)`;
    }

    function syncViewportHeight() {
      const slide = track.children[index];
      if (slide) viewport.style.height = `${slide.offsetHeight}px`;
    }

    function goTo(i, animate = true) {
      index = Math.max(0, Math.min(items.length - 1, i));
      updateTrack(animate);
      currentEl.textContent = String(index + 1);
      dots.forEach((d, di) => d.classList.toggle('is-active', di === index));
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === items.length - 1;
      deck.querySelectorAll('.study-flashcard.is-flipped').forEach((c) => c.classList.remove('is-flipped'));
      deck.querySelectorAll('.study-flashcard-slide').forEach((slide, si) => {
        const label = slide.querySelector('.study-flashcard-label');
        if (label) label.textContent = si === index ? 'Question' : '';
      });
      requestAnimationFrame(syncViewportHeight);
    }

    prevBtn.addEventListener('click', () => goTo(index - 1));
    nextBtn.addEventListener('click', () => goTo(index + 1));
    dots.forEach((d) => d.addEventListener('click', () => goTo(Number(d.dataset.fcDot))));

    deck.querySelectorAll('[data-flip-card]').forEach((card) => {
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('is-flipped');
        const label = card.querySelector('.study-flashcard-label');
        if (label) label.textContent = card.classList.contains('is-flipped') ? 'Answer' : 'Question';
        requestAnimationFrame(syncViewportHeight);
      });
    });

    viewport.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      track.style.transition = 'none';
      viewport.setPointerCapture(e.pointerId);
    });

    viewport.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const base = -index * slideWidth();
      const resistance = (index === 0 && dx > 0) || (index === items.length - 1 && dx < 0) ? 0.35 : 1;
      track.style.transform = `translateX(${base + dx * resistance}px)`;
    });

    viewport.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.clientX - startX;
      if (dx < -50) goTo(index + 1);
      else if (dx > 50) goTo(index - 1);
      else updateTrack(true);
      try { viewport.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    viewport.addEventListener('pointercancel', () => {
      if (!dragging) return;
      dragging = false;
      updateTrack(true);
    });

    window.addEventListener('resize', () => updateTrack(false));
    goTo(0, false);
    window.addEventListener('resize', syncViewportHeight);
  }

  function saveFlashcardsDeck(title, items) {
    saveDeck({
      id: 'deck-' + Date.now(),
      name: title || 'Study session',
      cards: items.map((item, i) => ({
        id: 'c' + Date.now() + i, q: item.q, a: item.a,
        ef: 2.5, interval: 0, repetitions: 0, due: Date.now()
      }))
    });
  }

  async function persistStudySession(sessionTitle, data, activeMode) {
    const { notes = {}, quiz = {}, flashcards = [], podcast = {} } = data;
    const inputType = data.inputType || inputTypeFromMode(activeMode);
    return saveStudySessionToDb({
      id: data.sessionId || `session-${Date.now()}`,
      name: sessionTitle,
      createdAt: Date.now(),
      source: notes.source || (activeMode === 'audio' ? 'Audio' : activeMode === 'url' ? 'Web link' : activeMode === 'text' ? 'Text' : 'Files'),
      inputType,
      inputText: data.inputText || data.sourceText || '',
      audioUrl: data.audioUrl || null,
      cardCount: flashcards.length,
      quizCount: quiz.questions?.length || 0,
      notes,
      quiz,
      flashcards,
      podcast,
      sourceText: data.sourceText || data.inputText || ''
    });
  }

  function renderQuizPanel(quiz) {
    const questions = quiz?.questions || [];
    if (!questions.length) { panels.quiz.innerHTML = '<p class="study-result-meta">No quiz.</p>'; return; }

    const answers = new Array(questions.length).fill(null);

    function answeredCount() {
      return answers.filter((value) => value !== null).length;
    }

    function score() {
      return answers.reduce((total, chosen, i) => (
        chosen === questions[i]?.answer ? total + 1 : total
      ), 0);
    }

    function render() {
      const done = answeredCount() === questions.length;
      panels.quiz.innerHTML = `
        <div class="study-quiz-list">
          ${questions.map((q, i) => `
            <article class="study-quiz-card">
              <p class="study-result-meta">Question ${i + 1}</p>
              <h3 class="study-quiz-question">${esc(q.q)}</h3>
              <div class="study-quiz-options">${(q.options || []).map((opt, oi) => {
                const chosen = answers[i];
                const classes = ['study-quiz-option'];
                if (chosen !== null) {
                  if (oi === q.answer) classes.push('is-correct');
                  else if (oi === chosen) classes.push('is-wrong');
                }
                return `<button type="button" class="${classes.join(' ')}" data-q="${i}" data-opt="${oi}"${chosen !== null ? ' disabled' : ''}>${esc(opt)}</button>`;
              }).join('')}</div>
              ${answers[i] !== null ? `<p class="study-quiz-feedback">${answers[i] === q.answer ? 'Correct!' : 'See highlighted answer.'}</p>` : ''}
            </article>
          `).join('')}
        </div>
        ${done
          ? `<p class="study-quiz-score">Score: <strong>${score()}/${questions.length}</strong></p>
             <button type="button" class="button button-soft" id="quiz-retry">Try again</button>`
          : `<p class="study-result-meta study-quiz-progress">${answeredCount()} of ${questions.length} answered</p>`}`;

      panels.quiz.querySelectorAll('.study-quiz-option:not(:disabled)').forEach((btn) => {
        btn.addEventListener('click', () => {
          const qi = Number(btn.dataset.q);
          if (answers[qi] !== null) return;
          answers[qi] = Number(btn.dataset.opt);
          render();
        });
      });

      panels.quiz.querySelector('#quiz-retry')?.addEventListener('click', () => {
        answers.fill(null);
        render();
      });
    }

    render();
  }

  function switchTab(id) {
    tabButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.tab === id && !b.hidden));
    Object.entries(panels).forEach(([k, p]) => { if (p) p.hidden = k !== id; });
  }

  tabButtons.forEach((b) => b.addEventListener('click', () => {
    if (b.hidden) return;
    switchTab(b.dataset.tab);
    markProgress(b.dataset.tab);
    if (b.dataset.tab === 'podcast' && panels.podcast?._podcastData) {
      const wrap = panels.podcast.querySelector('#podcast-audio-wrap');
      const btn = wrap?.querySelector('#podcast-play-btn');
      const player = wrap?.querySelector('audio');
      const needsAudio = panels.podcast._podcastData.script?.length
        && (btn?.disabled || !player?.src);
      if (needsAudio) {
        loadPodcastAudio(panels.podcast, panels.podcast._podcastData, ++podcastAudioFetchId);
      }
    }
  }));

  function getAudioFile() {
    if (uploadedAudioFile) return uploadedAudioFile;
    if (recordedBlob) {
      const ext = recordedBlob.type.includes('webm') ? 'webm' : 'm4a';
      return new File([recordedBlob], `recording-${Date.now()}.${ext}`, { type: recordedBlob.type });
    }
    return null;
  }

  function updateAiBanner(data) {
    const banner = document.getElementById('study-ai-banner');
    const successBanner = document.getElementById('study-success-banner');
    if (!banner) return;
    const showMockWarning = Boolean(data?.usedMockFallback);
    if (!showMockWarning) {
      refreshDashboardAiBanner();
      return;
    }
    banner.hidden = false;
    if (!data?.aiConfigured) {
      banner.textContent = 'Sample content only — add GEMINI_API_KEY in Vercel (AIzaSy… key from aistudio.google.com/apikey), then redeploy.';
    } else {
      banner.textContent = 'Gemini could not run — showing sample content. Check your API key on Vercel.';
    }
    if (successBanner) {
      const line = successBanner.querySelector('p');
      if (line) {
        line.textContent = 'Session ready with placeholder content.';
      }
    }
  }

  async function applyGeneratedSession(sessionTitle, data, mode, { save = true, partial = false } = {}) {
    sessionData = { ...(sessionData || {}), ...data };
    const { notes = {}, quiz = {}, flashcards = [], podcast = {} } = sessionData;
    const pendingFlashcards = Boolean(sessionData._pendingFlashcards);
    const pendingPodcast = Boolean(sessionData._pendingPodcast);
    const hasNotes = (notes.bullets || []).length > 0;
    const hasFlashcards = flashcards.length > 0;
    const hasPodcast = Boolean(podcast.title || podcast.script?.length || podcast.audio?.audioUrl);
    const hasQuiz = (quiz.questions || []).length > 0;
    const readingMap = syncReadingTabs({
      hasNotes,
      hasFlashcards,
      hasQuiz,
      hasPodcast,
      pendingFlashcards,
      pendingPodcast
    });
    updateAiBanner(sessionData);

    const displayTitle = sessionData.sessionName || sessionTitle;
    resultsTitle.textContent = displayTitle;
    const metaParts = [
      mode === 'audio' ? 'From lecture audio' : mode === 'url' ? (notes.source || 'From web link') : notes.source,
      hasFlashcards ? `${flashcards.length} flashcards` : pendingFlashcards ? 'flashcards loading…' : '',
      hasQuiz ? `${quiz.questions.length} quiz questions` : '',
      hasPodcast && podcast.audio?.audioUrl ? 'podcast ready' : hasPodcast ? 'podcast included' : pendingPodcast ? 'podcast loading…' : ''
    ].filter(Boolean);
    resultsMeta.textContent = metaParts.join(' · ');

    if (hasNotes) renderNotesPanel(notes);
    if (pendingFlashcards && panels.flashcards) {
      panels.flashcards.innerHTML = '<p class="study-loading">Building flashcards…</p>';
    } else if (hasFlashcards) {
      renderFlashcardsPanel(flashcards);
      if (save && !partial) saveFlashcardsDeck(displayTitle, flashcards);
    } else if (sessionData._flashcardsError && panels.flashcards) {
      panels.flashcards.innerHTML = `<p class="study-result-meta">${esc(sessionData._flashcardsError)}</p>`;
    }
    if (hasQuiz) renderQuizPanel(quiz);
    if (pendingPodcast && panels.podcast) {
      panels.podcast.innerHTML = '<p class="study-loading">Creating podcast script…</p>';
    } else if (hasPodcast) {
      renderPodcastResult(panels.podcast, { podcast });
    } else if (sessionData._podcastError && panels.podcast) {
      panels.podcast.innerHTML = `<p class="study-result-meta">${esc(sessionData._podcastError)}</p>`;
    }

    const firstTab = firstReadingTab(readingMap);
    if (firstTab && !partial) switchTab(firstTab);
    else if (firstTab && partial && !document.querySelector('#study-results .study-tab.is-active:not([hidden])')) {
      switchTab(firstTab);
    }

    if (save && !partial) {
      if (sessionData.savedToDatabase && sessionData.sessionId) {
        currentSessionId = sessionData.sessionId;
        upsertSessionCache({
          id: sessionData.sessionId,
          name: displayTitle,
          createdAt: Date.now(),
          source: notes.source || '',
          inputType: sessionData.inputType || inputTypeFromMode(mode),
          inputText: sessionData.inputText || sessionData.sourceText || '',
          audioUrl: sessionData.audioUrl || null,
          cardCount: flashcards.length,
          quizCount: quiz.questions?.length || 0,
          notes,
          quiz,
          flashcards,
          podcast,
          sourceText: sessionData.sourceText || sessionData.inputText || ''
        });
      } else {
        const saved = await persistStudySession(displayTitle, { ...sessionData, sessionId: sessionData.sessionId }, mode);
        currentSessionId = saved?.id || sessionData.sessionId || null;
      }
    } else if (!partial) {
      currentSessionId = sessionData.sessionId || null;
    }
    if (deleteSessionBtn) deleteSessionBtn.hidden = !currentSessionId;
    showResultsOnly();
  }

  generateBtn?.addEventListener('click', async () => {
    let files = [];
    let text = '';
    let url = '';

    if (activeMode === 'files') {
      files = selectedFiles.slice();
      if (!files.length) return setStatus('Add at least one file.', true);
    } else if (activeMode === 'audio') {
      const audio = getAudioFile();
      if (!audio) return setStatus('Record or upload audio first.', true);
      files = [audio];
    } else if (activeMode === 'url') {
      url = urlInput?.value.trim() || '';
      if (!url) return setStatus('Paste a web link first.', true);
    } else {
      text = pasteEl?.value.trim() || '';
      if (!text) return setStatus('Paste some text first.', true);
    }

    let generate;
    try {
      generate = validateGenerateOptions(readGenerateOptions('study-'));
    } catch (err) {
      return setStatus(err.message, true);
    }

    if (generateBtn) generateBtn.disabled = true;
    const loadMsgs = loadingMessagesForGenerate(
      generate,
      activeMode === 'url' ? 'url' : activeMode === 'audio' ? 'audio' : 'files'
    );
    showLoading(loadMsgs);
    setStatus('');

    try {
      let firstResult = false;
      const sessionTitleBase = sessionNameInput?.value.trim() || '';
      const mode = activeMode === 'url' ? 'url' : activeMode === 'audio' ? 'audio' : activeMode === 'text' ? 'text' : 'files';
      const data = await createStudySessionStaged({
        files,
        text,
        url,
        sessionName: sessionTitleBase,
        generate
      }, {
        onProgress: (msg, percent) => {
          if (loadingText) loadingText.textContent = msg;
          if (typeof percent === 'number') setLoadingProgress(percent);
        },
        onPartial: async (partial) => {
          if (!firstResult) {
            setLoadingProgress(100);
            window.setTimeout(() => hideLoading(), 400);
            firstResult = true;
          } else if (typeof partial === 'object') {
            const pct = partial._pendingPodcast ? 78 : partial._pendingFlashcards ? 42 : 100;
            setLoadingProgress(pct);
          }
          await applyGeneratedSession(
            resolveSessionTitle(sessionTitleBase, partial, mode, files),
            partial,
            activeMode,
            { save: false, partial: true }
          );
        }
      });
      const sessionTitle = resolveSessionTitle(sessionTitleBase, data, mode, files);
      await applyGeneratedSession(sessionTitle, data, activeMode, { partial: false });
      hideLoading();
    } catch (err) {
      hideLoading();
      setHowStep();
      setStatus(err.message, true);
    } finally {
      if (generateBtn) generateBtn.disabled = false;
    }
  });

  const pending = takePendingStudy();
  const sessionId = new URLSearchParams(window.location.search).get('session');
  window.addEventListener('bipai:study-session-ready', async (event) => {
    const { sessionTitle, data, activeMode: mode, partial } = event.detail || {};
    if (!data) return;
    await applyGeneratedSession(sessionTitle, data, mode || 'files', { save: !partial, partial: Boolean(partial) });
  });
  if (pending) {
    const { sessionTitle, data, activeMode: pendingMode } = pending;
    applyGeneratedSession(sessionTitle, data, pendingMode || 'files');
  } else if (sessionId) {
    loadSavedSessionById(sessionId).then((found) => {
      if (!found) {
        const msg = 'That session could not be found.';
        if (statusEl) setStatus(msg, true);
        else alert(msg);
      }
    });
  }
});

/* Step-by-step solver section */
document.addEventListener('DOMContentLoaded', () => {
  const section = document.getElementById('solver');
  if (!section) return;

  const tabButtons = section.querySelectorAll('[data-solver-tab]');
  const panels = section.querySelectorAll('[data-solver-panel]');
  const problemText = document.getElementById('solver-problem-text');
  const typeSubmit = document.getElementById('solver-type-submit');
  const uploadSubmit = document.getElementById('solver-upload-submit');
  const resultEl = document.getElementById('solver-result');
  const fileInput = document.getElementById('solver-file-input');
  const fileTrigger = document.getElementById('solver-file-trigger');
  const dropZone = document.getElementById('solver-drop-zone');
  const fileListEl = document.getElementById('solver-file-list');

  let solverFiles = [];
  initAutoGrowTextareas(section);

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabButtons.forEach((item) => {
        const active = item === btn;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.solverPanel !== btn.dataset.solverTab;
      });
    });
  });

  function renderSolverFileList() {
    if (!solverFiles.length) {
      fileListEl.hidden = true;
      fileListEl.innerHTML = '';
      return;
    }
    fileListEl.hidden = false;
    fileListEl.innerHTML = solverFiles.map((file, index) => `
      <li class="study-file-chip"><span>${escapeHtml(file.name)}</span>
      <button type="button" class="study-file-chip-remove" data-solver-remove="${index}" aria-label="Remove">×</button></li>`).join('');
  }

  function addSolverFiles(files) {
    files.forEach((file) => {
      const dup = solverFiles.some(
        (item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified
      );
      if (!dup) solverFiles.push(file);
    });
    renderSolverFileList();
  }

  fileTrigger?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    addSolverFiles(Array.from(fileInput.files || []));
    fileInput.value = '';
  });
  dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-dragover'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('is-dragover'));
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
    addSolverFiles(Array.from(e.dataTransfer?.files || []));
  });
  fileListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-solver-remove]');
    if (!btn) return;
    solverFiles.splice(Number(btn.dataset.solverRemove), 1);
    renderSolverFileList();
  });

  async function runSolver(problem) {
    if (!problem) return alert('Enter or upload a problem first.');
    resultEl.hidden = false;
    resultEl.innerHTML = '<p class="study-loading">Solving step by step…</p>';
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      const data = await solveProblem(problem);
      renderSolverResult(resultEl, data);
    } catch (err) {
      resultEl.innerHTML = `<p class="study-error">${escapeHtml(formatApiError(err.message))}</p>`;
    }
  }

  typeSubmit?.addEventListener('click', () => {
    const problem = problemText?.value.trim();
    if (!problem) return alert('Enter a problem to solve.');
    runSolver(problem);
  });

  uploadSubmit?.addEventListener('click', async () => {
    if (!solverFiles.length) return alert('Add at least one file first.');
    uploadSubmit.disabled = true;
    resultEl.hidden = false;
    resultEl.innerHTML = '<p class="study-loading">Reading your file and solving step by step…</p>';
    try {
      const problem = await problemTextFromFiles(solverFiles);
      if (!problem) return alert('Could not read a problem from those files.');
      await runSolver(problem);
    } catch (err) {
      resultEl.innerHTML = `<p class="study-error">${escapeHtml(formatApiError(err.message))}</p>`;
    } finally {
      uploadSubmit.disabled = false;
    }
  });
});
