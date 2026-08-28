// Interface de test du backend App Reprises — vanilla JS, sans framework
// ni étape de build, pour rester simple à servir/déboguer. Ce n'est PAS le
// client mobile final (Flutter, prévu au cahier des charges) : c'est un
// moyen concret pour un humain d'utiliser toutes les briques déjà testées
// via curl, dans un navigateur.

const state = { token: localStorage.getItem('token'), user: null, karaokeSessionId: null };

// --- Helpers API -------------------------------------------------------

async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    if (contentType.includes('application/json')) {
      const data = await res.json().catch(() => null);
      if (data && data.error) message = data.error;
    }
    throw new Error(message);
  }
  if (contentType.includes('application/json')) return res.json();
  return res.blob();
}

// Les <audio>/<a> ne peuvent pas envoyer l'en-tête Authorization — on
// récupère donc le fichier en blob via fetch authentifié, puis on
// l'attache comme object URL.
async function loadAudioInto(path, audioEl) {
  const blob = await api(path);
  audioEl.src = URL.createObjectURL(blob);
  audioEl.classList.remove('hidden');
}

// --- Auth ----------------------------------------------------------------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${tab.dataset.tab}Form`).classList.add('active');
  });
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    onAuthSuccess(result.token);
  } catch (err) {
    document.getElementById('loginError').textContent = err.message;
  }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('registerEmail').value;
  const password = document.getElementById('registerPassword').value;
  const referralCode = document.getElementById('registerReferral').value || undefined;
  try {
    const result = await api('/api/auth/register', { method: 'POST', body: { email, password, referralCode } });
    onAuthSuccess(result.token);
  } catch (err) {
    document.getElementById('registerError').textContent = err.message;
  }
});

function onAuthSuccess(token) {
  state.token = token;
  localStorage.setItem('token', token);
  boot();
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('token');
  location.reload();
});

// --- Navigation ------------------------------------------------------------

document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

function showView(name) {
  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'catalogue') loadCatalogue();
  if (name === 'generate') loadGenerateTrackOptions();
  if (name === 'karaoke') loadKaraokeTrackOptions();
  if (name === 'creations') loadCreations();
  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'referral') loadReferral();
  if (name === 'settings') loadSettings();
  if (name === 'admin') loadAdmin();
}

// --- Boot --------------------------------------------------------------

async function boot() {
  if (!state.token) return;
  try {
    state.user = await api('/api/auth/me');
  } catch (_) {
    localStorage.removeItem('token');
    return;
  }
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('userBadge').textContent = `${state.user.email} · ${state.user.credits} crédits`;
  if (state.user.role === 'admin') document.querySelector('.admin-only').classList.remove('hidden');
  showView('catalogue');
}

// --- Catalogue (écrans 3-5, 15) ---------------------------------------

async function loadCatalogue() {
  const search = document.getElementById('catalogueSearch').value;
  const tracks = await api(`/api/catalogue${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  const list = document.getElementById('catalogueList');
  list.innerHTML = tracks.map((t) => `
    <div class="card">
      <div><div class="card-title">${t.title}</div><div class="card-sub">${t.artistName} · ${t.genre || 'genre non précisé'}</div></div>
      <span class="badge">${t.status}</span>
    </div>
  `).join('') || '<p class="muted">Aucun morceau.</p>';
}
document.getElementById('catalogueSearch').addEventListener('input', debounce(loadCatalogue, 300));

document.getElementById('submitTrackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData();
  form.append('title', document.getElementById('submitTitle').value);
  form.append('artistName', document.getElementById('submitArtist').value);
  form.append('genre', document.getElementById('submitGenre').value);
  form.append('rightsCeded', document.getElementById('submitRights').checked);
  form.append('audio', document.getElementById('submitFile').files[0]);
  const statusEl = document.getElementById('submitStatus');
  try {
    await api('/api/catalogue/submit', { method: 'POST', body: form, isForm: true });
    statusEl.textContent = 'Soumis — en attente de modération.';
    e.target.reset();
    loadCatalogue();
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

// --- Génération IA (écran 8) --------------------------------------------

async function loadGenerateTrackOptions() {
  const tracks = await api('/api/catalogue');
  const select = document.getElementById('generateTrackSelect');
  select.innerHTML = tracks.map((t) => `<option value="${t.id}">${t.title} — ${t.artistName}</option>`).join('');
}

document.getElementById('generateBtn').addEventListener('click', async () => {
  const trackId = document.getElementById('generateTrackSelect').value;
  const prompt = document.getElementById('generatePrompt').value;
  const durationSeconds = document.getElementById('generateDuration').value;
  const statusEl = document.getElementById('generateStatus');
  if (!trackId) return (statusEl.textContent = 'Choisis un morceau.');
  statusEl.textContent = 'Génération en cours (peut prendre ~30-60s)...';
  const form = new FormData();
  form.append('prompt', prompt);
  if (durationSeconds) form.append('durationSeconds', durationSeconds);
  try {
    const blob = await api(`/api/catalogue/${trackId}/generate-variant`, { method: 'POST', body: form, isForm: true });
    const audio = document.getElementById('generateAudio');
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove('hidden');
    statusEl.textContent = 'Terminé.';
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

// --- Karaoké (écrans 6-7, 9, 10) -----------------------------------------

async function loadKaraokeTrackOptions() {
  const tracks = await api('/api/catalogue');
  const select = document.getElementById('karaokeTrackSelect');
  select.innerHTML = tracks.map((t) => `<option value="${t.id}">${t.title} — ${t.artistName}</option>`).join('');
}

async function createKaraokeSession() {
  const trackId = document.getElementById('karaokeTrackSelect').value;
  if (!trackId) return;
  const btn = document.getElementById('karaokeCreateBtn');
  btn.disabled = true;
  btn.textContent = 'Préparation (Demucs)...';
  try {
    const form = new FormData();
    form.append('trackId', trackId);
    const session = await api('/api/karaoke/sessions', { method: 'POST', body: form, isForm: true });
    state.karaokeSessionId = session.id;
    document.getElementById('karaokeSession').classList.remove('hidden');
    await loadAudioInto(`/api/karaoke/sessions/${session.id}/backing`, document.getElementById('backingAudio'));
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Créer une session (écran 6)';
  }
}
document.getElementById('karaokeCreateBtn').onclick = createKaraokeSession;

let mediaRecorder, recordedChunks = [];
document.getElementById('recordBtn').addEventListener('click', async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    const preview = document.getElementById('vocalPreview');
    preview.src = URL.createObjectURL(blob);
    preview.classList.remove('hidden');
    document.getElementById('uploadVocalBtn').classList.remove('hidden');
    document.getElementById('uploadVocalBtn').dataset.blobUrl = preview.src;
    stream.getTracks().forEach((t) => t.stop());
  };
  mediaRecorder.start();
  document.getElementById('recordBtn').classList.add('hidden');
  document.getElementById('stopRecordBtn').classList.remove('hidden');
  document.getElementById('recordStatus').textContent = 'Enregistrement en cours...';
});

document.getElementById('stopRecordBtn').addEventListener('click', () => {
  mediaRecorder.stop();
  document.getElementById('stopRecordBtn').classList.add('hidden');
  document.getElementById('recordBtn').classList.remove('hidden');
  document.getElementById('recordStatus').textContent = 'Prise enregistrée.';
});

document.getElementById('uploadVocalBtn').addEventListener('click', async () => {
  const blob = await fetch(document.getElementById('uploadVocalBtn').dataset.blobUrl).then((r) => r.blob());
  const form = new FormData();
  form.append('audio', blob, 'vocal.webm');
  try {
    await api(`/api/karaoke/sessions/${state.karaokeSessionId}/vocal`, { method: 'POST', body: form, isForm: true });
    document.getElementById('autotuneSection').classList.remove('hidden');
    document.getElementById('mixSection').classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('autotuneStrength').addEventListener('input', (e) => {
  document.getElementById('strengthValue').textContent = e.target.value;
});

document.getElementById('applyAutotuneBtn').addEventListener('click', async () => {
  const strength = document.getElementById('autotuneStrength').value;
  const form = new FormData();
  form.append('correctionStrength', strength);
  try {
    await api(`/api/karaoke/sessions/${state.karaokeSessionId}/autotune`, { method: 'POST', body: form, isForm: true });
    document.getElementById('compareBox').classList.remove('hidden');
    await loadAudioInto(`/api/karaoke/sessions/${state.karaokeSessionId}/vocal-raw`, document.getElementById('vocalRawAudio'));
    await loadAudioInto(`/api/karaoke/sessions/${state.karaokeSessionId}/vocal-tuned`, document.getElementById('vocalTunedAudio'));
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('mixBtn').addEventListener('click', async () => {
  try {
    const blob = await api(`/api/karaoke/sessions/${state.karaokeSessionId}/mix`, { method: 'POST', body: new FormData(), isForm: true });
    const audio = document.getElementById('finalMixAudio');
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
});

// --- Mes reprises (écrans 11-13) ----------------------------------------

async function loadCreations() {
  const items = await api('/api/me/creations');
  const list = document.getElementById('creationsList');
  list.innerHTML = items.map((c) => `
    <div class="card" data-id="${c.id}">
      <div>
        <div class="card-title">${c.trackTitle || c.type}</div>
        <div class="card-sub">${c.type} · ${new Date(c.createdAt).toLocaleString('fr-FR')}</div>
        <audio controls class="creation-audio" data-id="${c.id}"></audio>
      </div>
      <button class="btn-secondary delete-creation" data-id="${c.id}">Supprimer</button>
    </div>
  `).join('') || '<p class="muted">Aucune reprise pour l\'instant.</p>';

  for (const el of list.querySelectorAll('.creation-audio')) {
    loadAudioInto(`/api/me/creations/${el.dataset.id}/audio`, el);
  }
  list.querySelectorAll('.delete-creation').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/me/creations/${btn.dataset.id}`, { method: 'DELETE' });
      loadCreations();
    });
  });
}

// --- Classement (écran 19) ----------------------------------------------

async function loadLeaderboard() {
  const rows = await api('/api/leaderboard');
  const tbody = document.querySelector('#leaderboardTable tbody');
  tbody.innerHTML = rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.displayName}</td><td>${r.creationsCount}</td></tr>`).join('');
}

// --- Parrainage (écran 18) -----------------------------------------------

async function loadReferral() {
  document.getElementById('myReferralCode').textContent = state.user.referralCode;
  const refs = await api('/api/me/referrals');
  document.getElementById('referralsList').innerHTML = refs.map((r) => `
    <div class="card"><div class="card-title">${r.refereeEmail}</div><div class="card-sub">+${r.creditsAwarded} crédits · ${new Date(r.createdAt).toLocaleDateString('fr-FR')}</div></div>
  `).join('') || '<p class="muted">Aucun filleul pour l\'instant.</p>';
}
document.getElementById('copyReferralBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(state.user.referralCode);
});

// --- Paramètres (écran 17) ------------------------------------------------

async function loadSettings() {
  const s = await api('/api/me/settings');
  document.getElementById('displayNameInput').value = state.user.displayName || '';
  document.getElementById('languageInput').value = s.language || 'fr';
  document.getElementById('notificationsInput').checked = !!s.notifications;
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('settingsStatus');
  try {
    await api('/api/me/settings', {
      method: 'PATCH',
      body: { language: document.getElementById('languageInput').value, notifications: document.getElementById('notificationsInput').checked },
    });
    const displayName = document.getElementById('displayNameInput').value;
    if (displayName) {
      state.user = await api('/api/me/profile', { method: 'PATCH', body: { displayName } });
      document.getElementById('userBadge').textContent = `${state.user.email} · ${state.user.credits} crédits`;
    }
    statusEl.textContent = 'Enregistré.';
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

// --- Modération admin ------------------------------------------------------

async function loadAdmin() {
  const pending = await api('/api/catalogue?status=pending');
  document.getElementById('pendingList').innerHTML = pending.map((t) => `
    <div class="card">
      <div><div class="card-title">${t.title}</div><div class="card-sub">${t.artistName} · ${t.genre || ''}</div></div>
      <button class="btn-primary approve-btn" data-id="${t.id}">Approuver</button>
    </div>
  `).join('') || '<p class="muted">Rien en attente.</p>';
  document.querySelectorAll('.approve-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/catalogue/${btn.dataset.id}/approve`, { method: 'POST' });
      loadAdmin();
    });
  });
}

// --- Utils -----------------------------------------------------------------

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

boot();
