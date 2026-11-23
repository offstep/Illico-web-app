// ---------- Verrouillage : mot de passe + PIN + biométrie ----------
// Les secrets sont vérifiés par Supabase (security-lock.sql), jamais ici : cet écran n'est
// qu'une porte d'entrée. Sans déverrouillage, la base elle-même refuse de répondre.
//   - Mot de passe + PIN : fonctions SQL unlock / setup_lock / change_lock
//   - Biométrie : un appareil enregistré (jeton secret + empreinte/Face ID du téléphone via
//     WebAuthn) remplace la saisie. C'est un raccourci local : le navigateur vérifie la
//     biométrie, la base vérifie le jeton de l'appareil.
// Dépend de : utils.js, sheet.js. Optionnel : control.js (carte Sécurité).
// Si security-lock.sql n'est pas installé, tout fonctionne comme avant (aucun écran de verrouillage).

const LOCK_DEVICE_KEY = 'illico.device';     // { id, token, cred }
const LOCK_IDLE_KEY = 'illico.lockIdleMin';  // verrouillage automatique (minutes, 0 = jamais)
const LOCK_SKIP_KEY = 'illico.lockSkip';     // « plus tard » (valable jusqu'à la fermeture de l'onglet)
const LOCK_TICK_MS = 10000;
const LOCK_SERVER_EVERY_MS = 30000;
const LOCK_IDLE_CHOICES = [[2, '2 min'], [5, '5 min'], [10, '10 min'], [30, '30 min'], [0, 'Jamais']];

const lockState = { status: null, locked: false, watching: false, lastActive: Date.now(), lastServer: 0, lastKey: null, screen: null, resolvers: [] };

// ---------- Petits outils ----------
const lockGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lockSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* facultatif */ } };
const lockSkipped = () => { try { return sessionStorage.getItem(LOCK_SKIP_KEY) === '1'; } catch (e) { return false; } };
const lockSkip = () => { try { sessionStorage.setItem(LOCK_SKIP_KEY, '1'); } catch (e) { /* facultatif */ } };
const lockDevice = () => { try { return JSON.parse(lockGet(LOCK_DEVICE_KEY) || 'null'); } catch (e) { return null; } };
const lockIdleMin = () => {
  const raw = lockGet(LOCK_IDLE_KEY);
  const n = Number(raw);
  return raw !== null && LOCK_IDLE_CHOICES.some(c => c[0] === n) ? n : 10;
};
const lockIsLocked = () => lockState.locked;

const lockB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const lockUnb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function lockRpc(name, args) {
  const { data, error } = await window.sb.rpc(name, args || {});
  if (error) throw error;
  return data;
}
const lockAbsent = e => !!e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function|does not exist/i.test(e.message || ''));
const lockMsg = e => (e && e.message) || String(e);

// ---------- État ----------
async function lockFetchStatus() {
  let s;
  try {
    s = await lockRpc('lock_status');
    lockState.locked = !!(s && s.allowed && s.configured && !s.unlocked);
  } catch (e) {
    s = { error: lockAbsent(e) ? 'absent' : 'unknown', message: e && e.message };
    lockState.locked = false;
  }
  lockState.status = s;
  lockState.lastServer = Date.now();
  // On ne prévient les autres fichiers que si l'état a changé (évite les boucles d'affichage)
  const key = JSON.stringify([s.error || null, !!s.allowed, !!s.configured, !!s.unlocked]);
  if (key !== lockState.lastKey) {
    lockState.lastKey = key;
    window.dispatchEvent(new CustomEvent('illico:lock', { detail: s }));
  }
  return s;
}

// ---------- Biométrie (WebAuthn) ----------
async function lockBioAvailable() {
  try {
    return !!(window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch (e) { return false; }
}
const lockBioName = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'Face ID / Touch ID' : 'empreinte ou visage';
const lockDeviceLabel = () => {
  const ua = navigator.userAgent;
  const kind = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : 'Appareil';
  return kind + ' · ' + new Date().toLocaleDateString('fr-FR');
};

// Enregistre cet appareil : jeton secret côté base + identifiant biométrique local
async function lockBioRegister() {
  const reg = await lockRpc('register_device', { p_label: lockDeviceLabel() });
  try {
    const { data: { session } } = await window.sb.auth.getSession();
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'ILLICO', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: session ? session.user.email : 'admin', displayName: 'Admin ILLICO' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
        timeout: 60000
      }
    });
    lockSet(LOCK_DEVICE_KEY, JSON.stringify({ id: reg.id, token: reg.token, cred: lockB64(cred.rawId) }));
  } catch (e) {
    // Annulé ou refusé : on ne laisse pas un jeton orphelin dans la base
    await lockRpc('revoke_device', { p_id: reg.id }).catch(() => {});
    throw e;
  }
}

// Demande la biométrie, puis présente le jeton de l'appareil à la base
async function lockBioUnlock() {
  const dev = lockDevice();
  if (!dev) return false;
  await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: lockUnb64(dev.cred), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000
    }
  });
  const r = await lockRpc('unlock_device', { p_id: dev.id, p_token: dev.token });
  if (!r || !r.ok) { lockSet(LOCK_DEVICE_KEY, null); return false; }
  return true;
}

// ---------- Écrans plein écran ----------
function lockHide() {
  if (lockState.screen) lockState.screen.remove();
  lockState.screen = null;
}

function lockShell(title, subtitle) {
  lockHide();
  const wrap = el('div', 'fixed inset-0 z-[110] bg-black text-white overflow-y-auto');
  wrap.id = 'lock-screen';
  const inner = el('div', 'min-h-full flex flex-col items-center justify-center p-6 text-center max-w-sm mx-auto');
  inner.appendChild(el('h1', 'text-3xl font-black italic mb-1', 'ILLICO'));
  inner.appendChild(icon('lock', 'w-6 h-6 my-3 text-zinc-400'));
  inner.appendChild(el('h2', 'text-lg font-bold', title));
  inner.appendChild(el('p', 'text-sm text-zinc-400 mt-1 mb-5', subtitle || ''));
  wrap.appendChild(inner);
  document.body.appendChild(wrap);
  lockState.screen = wrap;
  lucide.createIcons();
  return inner;
}

function lockInput(type, placeholder, extra) {
  const i = el('input', 'w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-base text-white placeholder-zinc-500 outline-none focus:border-white');
  i.type = type;
  i.placeholder = placeholder;
  Object.assign(i, extra || {});
  return i;
}

function lockBtn(label, primary) {
  const b = el('button', 'w-full rounded-full py-3 font-bold text-sm transition active:scale-95 ' +
    (primary ? 'bg-white text-black' : 'border border-zinc-700 text-zinc-300'), label);
  b.type = 'button';
  return b;
}

const lockWait = () => new Promise(resolve => lockState.resolvers.push(resolve));

// Fin d'un déverrouillage réussi : on ferme l'écran, on prévient ceux qui attendent, on recharge
async function lockFinish() {
  lockHide();
  lockState.locked = false;
  lockState.lastActive = Date.now();
  await lockFetchStatus();
  lockState.resolvers.splice(0).forEach(r => r(true));
  if (typeof refreshDashboard === 'function') refreshDashboard();
}

// Proposition d'activer la biométrie juste après un déverrouillage
async function lockAfterUnlock() {
  const offer = !lockDevice() && !lockOfferedBio && await lockBioAvailable();
  if (!offer) return lockFinish();
  lockOfferedBio = true;
  const inner = lockShell('Activer ' + lockBioName() + ' ?', 'Pour déverrouiller en un geste sur ce téléphone, sans retaper le mot de passe et le PIN.');
  const msg = el('p', 'text-xs min-h-[1rem] text-red-400 mb-2');
  const yes = lockBtn('Activer', true);
  const no = lockBtn('Plus tard', false);
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try { await lockBioRegister(); lockFinish(); }
    catch (e) { yes.disabled = false; msg.textContent = 'Impossible : ' + lockMsg(e); }
  });
  no.addEventListener('click', lockFinish);
  const box = el('div', 'w-full space-y-3');
  [msg, yes, no].forEach(n => box.appendChild(n));
  inner.appendChild(box);
}
let lockOfferedBio = false;

// ----- Déverrouillage -----
async function lockShowUnlock() {
  const bio = !!lockDevice() && await lockBioAvailable();
  const inner = lockShell('Accès verrouillé', bio ? 'Déverrouille avec ' + lockBioName() + ' ou avec ton mot de passe.' : 'Entre ton mot de passe et ton PIN.');
  const msg = el('p', 'text-xs min-h-[1.25rem] text-red-400 mb-2');

  const form = el('div', 'w-full space-y-3');
  const pw = lockInput('password', 'Mot de passe', { autocomplete: 'current-password' });
  const pin = lockInput('password', 'PIN à 6 chiffres', { inputMode: 'numeric', maxLength: 6, autocomplete: 'off' });
  const go = lockBtn('Déverrouiller', true);
  [pw, pin, go].forEach(n => form.appendChild(n));

  async function submit() {
    msg.textContent = '';
    if (!pw.value || pin.value.length !== 6) { msg.textContent = 'Entre ton mot de passe et ton PIN (6 chiffres).'; return; }
    go.disabled = true;
    try {
      const r = await lockRpc('unlock', { p_password: pw.value, p_pin: pin.value });
      pw.value = ''; pin.value = '';
      if (r && r.ok) return lockAfterUnlock();
      if (r && r.reason === 'locked') {
        const min = Math.ceil((r.retry_in || 60) / 60);
        msg.textContent = 'Trop d\'essais. Réessaie dans ' + min + ' min.';
      } else {
        msg.textContent = 'Identifiants incorrects.' + (r && r.remaining ? ' Il te reste ' + r.remaining + ' essai' + (r.remaining > 1 ? 's' : '') + ' avant blocage.' : '');
      }
    } catch (e) {
      msg.textContent = lockMsg(e);
    }
    go.disabled = false;
  }
  go.addEventListener('click', submit);
  [pw, pin].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));

  inner.appendChild(msg);
  if (bio) {
    const bioBtn = lockBtn('Utiliser ' + lockBioName(), true);
    const other = lockBtn('Mot de passe et PIN', false);
    form.classList.add('hidden');
    bioBtn.addEventListener('click', async () => {
      msg.textContent = '';
      bioBtn.disabled = true;
      try {
        if (await lockBioUnlock()) return lockFinish();
        msg.textContent = 'Cet appareil n\'est plus reconnu. Utilise le mot de passe.';
        bioBtn.classList.add('hidden');
        form.classList.remove('hidden');
        other.classList.add('hidden');
      } catch (e) {
        msg.textContent = 'Biométrie annulée ou refusée.';
      }
      bioBtn.disabled = false;
    });
    other.addEventListener('click', () => { form.classList.remove('hidden'); other.classList.add('hidden'); bioBtn.classList.add('hidden'); pw.focus(); });
    const stack = el('div', 'w-full space-y-3');
    [bioBtn, other].forEach(n => stack.appendChild(n));
    inner.appendChild(stack);
  }
  inner.appendChild(form);
  const out = el('button', 'mt-6 text-xs text-zinc-500 underline', 'Se déconnecter');
  out.type = 'button';
  out.addEventListener('click', () => { if (typeof logout === 'function') logout(); });
  inner.appendChild(out);
  if (!bio) pw.focus();
}

// ----- Création du mot de passe + PIN -----
// opts : { skippable, onCancel }
function lockShowSetup(opts) {
  opts = opts || {};
  const inner = lockShell('Sécuriser l\'accès', 'Ajoute un mot de passe et un PIN en plus de Google. Ils seront demandés à chaque connexion.');
  const msg = el('p', 'text-xs min-h-[1.25rem] text-red-400 mb-2');
  const pw1 = lockInput('password', 'Mot de passe (10 caractères minimum)', { autocomplete: 'new-password' });
  const pw2 = lockInput('password', 'Confirmer le mot de passe', { autocomplete: 'new-password' });
  const pin1 = lockInput('password', 'PIN (6 chiffres)', { inputMode: 'numeric', maxLength: 6, autocomplete: 'off' });
  const pin2 = lockInput('password', 'Confirmer le PIN', { inputMode: 'numeric', maxLength: 6, autocomplete: 'off' });
  const go = lockBtn('Activer le verrouillage', true);
  const later = lockBtn(opts.skippable ? 'Plus tard' : 'Annuler', false);

  go.addEventListener('click', async () => {
    msg.textContent = '';
    if (pw1.value.length < 10) { msg.textContent = 'Mot de passe : 10 caractères minimum.'; return; }
    if (pw1.value !== pw2.value) { msg.textContent = 'Les deux mots de passe sont différents.'; return; }
    if (!/^\d{6}$/.test(pin1.value)) { msg.textContent = 'Le PIN doit contenir exactement 6 chiffres.'; return; }
    if (pin1.value !== pin2.value) { msg.textContent = 'Les deux PIN sont différents.'; return; }
    go.disabled = true;
    try {
      await lockRpc('setup_lock', { p_password: pw1.value, p_pin: pin1.value });
      [pw1, pw2, pin1, pin2].forEach(i => { i.value = ''; });
      toast('Verrouillage activé.');
      await lockAfterUnlock();
    } catch (e) {
      msg.textContent = lockMsg(e);
      go.disabled = false;
    }
  });
  later.addEventListener('click', () => {
    if (opts.onCancel) opts.onCancel();
  });

  const box = el('div', 'w-full space-y-3');
  [msg, pw1, pw2, pin1, pin2, go, later].forEach(n => box.appendChild(n));
  inner.appendChild(box);
  inner.appendChild(el('p', 'text-[11px] text-zinc-500 mt-4', 'Si tu les oublies : exécute reset-lock.sql dans Supabase pour retirer le verrouillage.'));
}

// Ouvre la création depuis la carte Sécurité
function lockOpenSetup() {
  lockShowSetup({ skippable: false, onCancel: lockHide });
}

// ---------- Point d'entrée : appelé par auth.js après la connexion Google ----------
async function ensureUnlocked() {
  if (lockState.screen) return lockWait();       // un écran est déjà affiché : on attend la fin
  const s = await lockFetchStatus();
  lockStartWatchers();
  if (s.error || !s.allowed) return true;        // pas installé / pas admin : comportement d'avant
  if (!s.configured) {
    if (lockSkipped()) return true;
    lockShowSetup({ skippable: true, onCancel: () => { lockSkip(); lockHide(); lockState.resolvers.splice(0).forEach(r => r(true)); } });
    return lockWait();
  }
  if (s.unlocked) return true;
  lockShowUnlock();
  return lockWait();
}

// Verrouille tout de suite (bouton, inactivité, session expirée)
async function lockNow() {
  try { await lockRpc('lock_now'); } catch (e) { console.warn('lock_now :', e); }
  const s = await lockFetchStatus();
  if (s.allowed && s.configured && !lockState.screen) lockShowUnlock();
}

// À la déconnexion : on oublie le déverrouillage de cette session
async function lockRelease() {
  try { await lockRpc('lock_now'); } catch (e) { /* pas installé */ }
}

// ---------- Surveillance : inactivité, expiration, retour sur l'app ----------
function lockStartWatchers() {
  if (lockState.watching) return;
  lockState.watching = true;
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(ev =>
    document.addEventListener(ev, () => { lockState.lastActive = Date.now(); }, { passive: true, capture: true }));

  async function check() {
    const s = lockState.status;
    if (!s || s.error || !s.allowed || !s.configured || lockState.screen) return;
    const idle = lockIdleMin();
    if (!lockState.locked && idle > 0 && Date.now() - lockState.lastActive > idle * 60000) return lockNow();
    if (Date.now() - lockState.lastServer > LOCK_SERVER_EVERY_MS) {
      const fresh = await lockFetchStatus();
      if (fresh.allowed && fresh.configured && !fresh.unlocked && !lockState.screen) lockShowUnlock();
    }
  }
  setInterval(check, LOCK_TICK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lockState.lastServer = 0; check(); } });
}

// ---------- Carte « Sécurité » du Centre de contrôle ----------
async function buildLockCard() {
  const s = await lockFetchStatus();
  const card = el('div', 'card divide-y divide-zinc-100');
  const line = (label, value, good) => {
    const r = el('div', 'flex items-center justify-between gap-3 px-4 py-3');
    r.appendChild(el('span', 'text-sm text-zinc-600', label));
    r.appendChild(el('span', 'text-xs font-semibold px-2.5 py-1 rounded-full ' + (good ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-500'), value));
    return r;
  };
  const actions = el('div', 'p-4 space-y-2');
  const action = (iconName, label, onClick, ghost) => {
    const b = el('button', 'btn btn-block ' + (ghost ? 'btn-ghost' : 'btn-primary'));
    b.type = 'button';
    b.appendChild(icon(iconName, 'w-4 h-4'));
    b.appendChild(el('span', '', label));
    b.addEventListener('click', onClick);
    actions.appendChild(b);
  };
  const rerender = () => { if (typeof ccRender === 'function') ccRender(); };

  if (s.error === 'absent') {
    card.appendChild(el('p', 'px-4 py-4 text-sm text-zinc-500', 'Le verrouillage n\'est pas encore installé : exécute security-lock.sql dans Supabase (SQL Editor).'));
    return card;
  }
  if (s.error || !s.allowed) {
    card.appendChild(el('p', 'px-4 py-4 text-sm text-zinc-500', 'État du verrouillage indisponible pour le moment.'));
    return card;
  }

  const dev = lockDevice();
  const bioOk = await lockBioAvailable();
  card.appendChild(line('Google', 'Connecté', true));
  card.appendChild(line('Mot de passe', s.configured ? 'Actif' : 'Non activé', s.configured));
  card.appendChild(line('PIN', s.configured ? 'Actif' : 'Non activé', s.configured));
  card.appendChild(line('Biométrie', dev ? 'Activée ici' : bioOk ? 'Disponible' : 'Indisponible', !!dev));

  if (!s.configured) {
    action('lock', 'Activer le mot de passe et le PIN', lockOpenSetup, false);
  } else {
    action('lock-keyhole', 'Verrouiller maintenant', () => lockNow(), false);
    if (dev) {
      action('fingerprint', 'Retirer la biométrie de cet appareil', async () => {
        if (!confirm('Retirer ' + lockBioName() + ' de cet appareil ?')) return;
        try { await lockRpc('revoke_device', { p_id: dev.id }); } catch (e) { toast('Échec : ' + lockMsg(e)); return; }
        lockSet(LOCK_DEVICE_KEY, null);
        toast('Biométrie retirée.');
        rerender();
      }, true);
    } else if (bioOk) {
      action('fingerprint', 'Activer ' + lockBioName(), async () => {
        try { await lockBioRegister(); toast('Biométrie activée.'); }
        catch (e) { toast('Impossible : ' + lockMsg(e)); }
        rerender();
      }, true);
    }
    action('key-round', 'Changer le mot de passe et le PIN', lockOpenChange, true);

    const wrap = el('label', 'flex items-center justify-between gap-3 pt-1');
    wrap.appendChild(el('span', 'text-xs text-zinc-500', 'Verrouillage automatique après'));
    const sel = el('select', 'field !w-auto !py-1.5 !text-xs');
    LOCK_IDLE_CHOICES.forEach(([v, label]) => {
      const o = el('option', '', label);
      o.value = String(v);
      if (v === lockIdleMin()) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { lockSet(LOCK_IDLE_KEY, sel.value); toast('Enregistré.'); });
    wrap.appendChild(sel);
    actions.appendChild(wrap);

    if (s.expires_at) actions.appendChild(el('p', 'text-[11px] text-zinc-400', 'Cette session reste déverrouillée jusqu\'à ' + longDate(s.expires_at) + ' au plus tard.'));
  }
  if (s.configured) {
    const list = el('div', 'px-4 py-3 space-y-2 hidden');
    card.appendChild(list);
    lockRpc('list_devices').then(rows => {
      if (!rows || !rows.length) return;
      list.classList.remove('hidden');
      list.appendChild(el('div', 'text-[11px] font-semibold text-zinc-500 uppercase tracking-wide', 'Appareils de confiance'));
      rows.forEach(d => {
        const r = el('div', 'flex items-center gap-3');
        const info = el('div', 'flex-1 min-w-0');
        info.appendChild(el('div', 'text-sm font-medium truncate', (d.label || 'Appareil') + (dev && dev.id === d.id ? ' (celui-ci)' : '')));
        info.appendChild(el('div', 'text-[11px] text-zinc-500', d.last_used ? 'Utilisé ' + longDate(d.last_used) : 'Jamais utilisé'));
        r.appendChild(info);
        const rm = el('button', 'text-xs text-red-500 font-semibold', 'Retirer');
        rm.type = 'button';
        rm.addEventListener('click', async () => {
          if (!confirm('Retirer cet appareil ?')) return;
          try { await lockRpc('revoke_device', { p_id: d.id }); } catch (e) { toast('Échec : ' + lockMsg(e)); return; }
          if (dev && dev.id === d.id) lockSet(LOCK_DEVICE_KEY, null);
          rerender();
        });
        r.appendChild(rm);
        list.appendChild(r);
      });
    }).catch(() => {});
  }
  card.appendChild(actions);
  return card;
}

// Fenêtre « Changer le mot de passe et le PIN »
function lockOpenChange() {
  const body = openSheet('Changer les identifiants', 'Mot de passe et PIN');
  const form = el('div', 'space-y-3');
  const f = (label, type, extra) => {
    const w = el('label', 'block');
    w.appendChild(el('span', 'field-label', label));
    const i = el('input', 'field');
    i.type = type;
    Object.assign(i, extra || {});
    w.appendChild(i);
    form.appendChild(w);
    return i;
  };
  const curPw = f('Mot de passe actuel', 'password', { autocomplete: 'current-password' });
  const curPin = f('PIN actuel', 'password', { inputMode: 'numeric', maxLength: 6, autocomplete: 'off' });
  const newPw = f('Nouveau mot de passe (10 caractères minimum)', 'password', { autocomplete: 'new-password' });
  const newPin = f('Nouveau PIN (6 chiffres)', 'password', { inputMode: 'numeric', maxLength: 6, autocomplete: 'off' });
  const status = el('p', 'hidden text-xs rounded-xl px-3 py-2 text-red-600 bg-red-50 border border-red-200');
  const go = el('button', 'w-full btn btn-primary btn-block', 'Enregistrer');
  go.type = 'button';
  form.appendChild(status);
  form.appendChild(go);
  body.appendChild(form);

  const say = m => { status.textContent = m; status.classList.remove('hidden'); };
  go.addEventListener('click', async () => {
    status.classList.add('hidden');
    if (!curPw.value || !/^\d{6}$/.test(curPin.value)) return say('Entre ton mot de passe et ton PIN actuels.');
    if (newPw.value.length < 10) return say('Nouveau mot de passe : 10 caractères minimum.');
    if (!/^\d{6}$/.test(newPin.value)) return say('Le nouveau PIN doit contenir exactement 6 chiffres.');
    go.disabled = true;
    try {
      const r = await lockRpc('change_lock', { p_cur_password: curPw.value, p_cur_pin: curPin.value, p_new_password: newPw.value, p_new_pin: newPin.value });
      if (r && r.ok) { closeSheet(); toast('Identifiants modifiés. Les autres appareils devront se reconnecter.'); return; }
      say(r && r.reason === 'locked' ? 'Trop d\'essais : réessaie plus tard.' : 'Identifiants actuels incorrects.');
    } catch (e) {
      say(lockMsg(e));
    }
    go.disabled = false;
  });
}
