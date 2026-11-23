// ---------- Centre de contrôle ----------
// Une seule page pour savoir si tout tourne : santé (bot, base, file d'attente), points
// d'attention, actions rapides, activité récente, sécurité.
// Dépend de : utils.js, sheet.js, wallet.js (openWallet), missions.js (openMissionForm),
// data.js (PENDING_STATES, refreshDashboard, REFRESH_MS). Optionnel : lock.js (carte Sécurité).
// loadControl() est appelée par data.js à chaque rafraîchissement ; tout est préfixé « cc »
// pour ne jamais entrer en conflit avec les autres fichiers (ils partagent la même portée).

const CC_WARN_H = 12;            // livraison en attente depuis plus de 12 h : à surveiller
const CC_BAD_H = 24;             // plus de 24 h : urgent
const CC_PAY_WARN_DAYS = 7;      // paiement dû depuis plus de 7 jours
const CC_PAY_BAD_DAYS = 14;
const CC_PING_WAIT_MS = 15000;   // le bot lit ses commandes toutes les 4 s
const CC_PING_EVERY_MS = 120000; // on ne re-vérifie pas le bot plus d'une fois toutes les 2 min

const ccState = { data: null, ping: { state: 'idle' }, pingAt: 0, busy: false };

const ccSleep = ms => new Promise(r => setTimeout(r, ms));
const ccHours = d => d ? (Date.now() - new Date(d).getTime()) / 3600000 : 0;
const ccAge = h => h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' j';
const ccRows = r => (r && r.status === 'fulfilled' && !r.value.error) ? (r.value.data || []) : null;
const ccIsVisible = () => { const v = document.getElementById('view-control'); return !!v && !v.classList.contains('hidden'); };

const CC_DOT = { ok: 'bg-emerald-500', info: 'bg-zinc-400', warn: 'bg-amber-500', bad: 'bg-red-500' };
const CC_AUDIT = {
  'delivery.created': 'Livraison ouverte',
  'delivery.submitted': 'Livraison soumise',
  'delivery.cancelled': 'Livraison annulée',
  'qa.reviewed': 'Contrôle qualité',
  'quiz.passed': 'Quiz réussi',
  'quiz.failed': 'Quiz échoué',
  'role.assigned': 'Rôle attribué',
  'worker.verified': 'Worker vérifié'
};

// ============ Envoi d'une commande au bot ============
async function ccSend(kind, payload, waitMs) {
  const { data: { session } } = await window.sb.auth.getSession();
  const cmd = { id: crypto.randomUUID(), kind, status: 'PENDING', requestedBy: session ? session.user.email : null, payload: payload || {} };
  const { error } = await window.sb.from('WebCommand').insert(cmd);
  if (error) throw error;

  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await ccSleep(1000);
    const { data, error: e2 } = await window.sb.from('WebCommand').select('status, result').eq('id', cmd.id).single();
    if (e2) throw e2;
    if (data && (data.status === 'DONE' || data.status === 'FAILED')) {
      return { state: data.status === 'DONE' ? 'done' : 'failed', result: data.result, ms: Date.now() - t0 };
    }
  }
  return { state: 'timeout', ms: Date.now() - t0 };
}

const ccUptime = ms => {
  const m = Math.floor(ms / 60000);
  return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + ' h' : Math.floor(m / 1440) + ' j';
};

// Vérifie que le bot répond. Une réponse « commande inconnue » prouve qu'il est en ligne (ancienne version).
async function ccPing(force) {
  if (!force && Date.now() - ccState.pingAt < CC_PING_EVERY_MS) return;
  ccState.pingAt = Date.now();
  ccState.ping = { state: 'checking' };
  ccRender();
  try {
    const out = await ccSend('PING', {}, CC_PING_WAIT_MS);
    if (out.state === 'done') {
      let info = {};
      try { info = JSON.parse(out.result) || {}; } catch (e) { /* texte simple */ }
      ccState.ping = { state: 'online', ws: info.ws, up: info.up, guilds: info.guilds };
    } else if (out.state === 'failed' && /inconnue/i.test(out.result || '')) {
      ccState.ping = { state: 'online', old: true };
    } else if (out.state === 'failed') {
      ccState.ping = { state: 'error', detail: out.result };
    } else {
      ccState.ping = { state: 'silent' };
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    ccState.ping = { state: 'error', detail: /row-level|policy/i.test(msg) ? 'Autorisation manquante : lance control-center.sql dans Supabase.' : msg };
  }
  ccRender();
  ccSummary();
}

// ============ Chargement des données ============
async function loadControl() {
  if (ccState.busy) return;
  ccState.busy = true;
  try {
    const q = window.sb;
    const t0 = performance.now();
    const [dels, pays, miss, cmds, logs] = await Promise.allSettled([
      q.from('Delivery').select('id, number, status, submittedAt').in('status', PENDING_STATES).order('submittedAt', { ascending: true }).limit(100),
      q.from('Payment').select('amount, userId, createdAt, user:User!userId(username)').eq('status', 'PENDING').limit(1000),
      q.from('Mission').select('id, number, title, status, maxWorkers, createdAt, MissionWorker(count)').in('status', ['PUBLISHED', 'DRAFT']).limit(100),
      q.from('WebCommand').select('id, kind, status, result, createdAt').order('createdAt', { ascending: false }).limit(30),
      q.from('AuditLog').select('action, createdAt, metadata, actor:User!actorId(username)').order('createdAt', { ascending: false }).limit(12)
    ]);
    const dbMs = Math.round(performance.now() - t0);
    const failed = [dels, pays, miss, cmds, logs].filter(r => !ccRows(r)).length;
    ccState.data = {
      dbMs, failed,
      deliveries: ccRows(dels), payments: ccRows(pays), missions: ccRows(miss), commands: ccRows(cmds), audit: ccRows(logs)
    };
    ccState.items = ccAttention(ccState.data);
    ccSummary();
    if (ccIsVisible()) ccRender();
  } finally {
    ccState.busy = false;
  }
}

// Regroupe les paiements dus par worker : [{ userId, name, total, count, oldest }]
function ccDueByWorker(payments) {
  const map = new Map();
  (payments || []).forEach(p => {
    const w = map.get(p.userId) || { userId: p.userId, name: (p.user && p.user.username) || 'Inconnu', total: 0, count: 0, oldest: p.createdAt };
    w.total += p.amount || 0;
    w.count += 1;
    if (p.createdAt && new Date(p.createdAt) < new Date(w.oldest)) w.oldest = p.createdAt;
    map.set(p.userId, w);
  });
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// ============ Points d'attention ============
// Renvoie [{ tone, icon, title, detail, go }] ; tone : ok | info | warn | bad
function ccAttention(d) {
  const items = [];

  if (d.deliveries) {
    if (!d.deliveries.length) items.push({ tone: 'ok', icon: 'shield-check', title: 'Aucune livraison en attente', detail: 'Tout est contrôlé.', go: () => ccGo('qa') });
    else {
      const h = ccHours(d.deliveries[0].submittedAt);
      const tone = h >= CC_BAD_H ? 'bad' : h >= CC_WARN_H ? 'warn' : 'info';
      items.push({
        tone, icon: 'shield-check',
        title: plural(d.deliveries.length, 'livraison à vérifier', 'livraisons à vérifier'),
        detail: 'La plus ancienne attend depuis ' + ccAge(h) + '.',
        go: () => ccGo('qa')
      });
    }
  }

  if (d.payments) {
    const due = ccDueByWorker(d.payments);
    if (!due.length) items.push({ tone: 'ok', icon: 'wallet', title: 'Aucun paiement à régler', detail: 'Tous les workers sont à jour.', go: ccOpenDue });
    else {
      const total = due.reduce((t, w) => t + w.total, 0);
      const days = Math.max(...due.map(w => ccHours(w.oldest))) / 24;
      const tone = days >= CC_PAY_BAD_DAYS ? 'bad' : days >= CC_PAY_WARN_DAYS ? 'warn' : 'info';
      items.push({
        tone, icon: 'wallet',
        title: usd(total) + ' à régler · ' + plural(due.length, 'worker', 'workers'),
        detail: 'Le plus ancien gain date de ' + Math.max(1, Math.round(days)) + ' j.',
        go: ccOpenDue
      });
    }
  }

  if (d.missions) {
    const pub = d.missions.filter(m => m.status === 'PUBLISHED');
    const taken = m => (m.MissionWorker && m.MissionWorker[0] && m.MissionWorker[0].count) || 0;
    pub.filter(m => ccHours(m.createdAt) >= 24 && taken(m) === 0).forEach(m => {
      items.push({
        tone: 'warn', icon: 'clipboard-list',
        title: 'Mission ' + num5(m.number) + ' sans preneur',
        detail: m.title + ' · publiée il y a ' + ccAge(ccHours(m.createdAt)) + '.',
        go: () => ccGo('missions')
      });
    });
    const full = pub.filter(m => m.maxWorkers && taken(m) >= m.maxWorkers);
    if (full.length) {
      items.push({
        tone: 'info', icon: 'clipboard-list',
        title: plural(full.length, 'mission complète', 'missions complètes'),
        detail: 'Toutes les places sont prises : pense à la clôturer ou à en publier une autre.',
        go: () => ccGo('missions')
      });
    }
    const drafts = d.missions.filter(m => m.status === 'DRAFT').length;
    if (drafts) items.push({ tone: 'info', icon: 'file-pen', title: plural(drafts, 'brouillon', 'brouillons'), detail: 'Pas encore visible(s) par les workers.', go: () => ccGo('missions') });
  }

  if (d.commands) {
    const stuck = d.commands.filter(c => c.status === 'PENDING' && ccHours(c.createdAt) * 60 > 1);
    const recentFail = d.commands.filter(c => c.status === 'FAILED' && ccHours(c.createdAt) < 24 && !/inconnue/i.test(c.result || ''));
    if (stuck.length) {
      items.push({
        tone: 'bad', icon: 'bot',
        title: 'Le bot ne traite plus les commandes',
        detail: plural(stuck.length, 'commande attend', 'commandes attendent') + ' depuis ' + ccAge(ccHours(stuck[stuck.length - 1].createdAt)) + '. Vérifie Railway.',
        go: () => ccPing(true)
      });
    }
    if (recentFail.length) {
      items.push({
        tone: 'warn', icon: 'triangle-alert',
        title: plural(recentFail.length, 'commande en échec', 'commandes en échec') + ' (24 h)',
        detail: (recentFail[0].kind + ' : ' + (recentFail[0].result || 'raison inconnue')).slice(0, 110),
        go: null
      });
    }
  }

  if (ccState.lock && ccState.lock.error === undefined && ccState.lock.configured === false) {
    items.push({
      tone: 'warn', icon: 'lock', title: 'Verrouillage non activé',
      detail: 'Ajoute un mot de passe et un PIN pour protéger le dashboard.',
      go: () => { if (typeof lockOpenSetup === 'function') lockOpenSetup(); }
    });
  }
  return items;
}

function ccGo(view) {
  const a = document.querySelector('[data-nav="' + view + '"]');
  if (a) a.click();
}

// Résumé pour la carte de l'Accueil
function ccSummary() {
  const dot = document.getElementById('cc-dot');
  const sub = document.getElementById('cc-home-sub');
  if (!dot || !sub) return;
  const items = ccState.items || [];
  const bad = items.filter(i => i.tone === 'bad').length;
  const warn = items.filter(i => i.tone === 'warn').length;
  const botDown = ccState.ping.state === 'silent' || ccState.ping.state === 'error';
  const tone = bad || botDown ? 'bad' : warn ? 'warn' : ccState.data ? 'ok' : 'info';
  dot.className = 'w-2 h-2 rounded-full ' + CC_DOT[tone];
  sub.textContent = !ccState.data ? 'Santé, alertes et actions rapides'
    : bad || botDown ? 'Action requise' + (bad + warn ? ' · ' + plural(bad + warn, 'point', 'points') : '')
    : warn ? plural(warn, "point d'attention", "points d'attention")
    : 'Tout est en ordre';
}

// ============ Affichage ============
function ccTile(iconName, label, value, tone, hint) {
  const t = el('div', 'tone-' + tone + ' rounded-2xl px-3 py-3 min-w-0');
  const head = el('div', 'flex items-center gap-1.5 text-[11px] font-semibold opacity-80');
  head.appendChild(icon(iconName, 'w-3.5 h-3.5'));
  head.appendChild(el('span', 'truncate', label));
  t.appendChild(head);
  t.appendChild(el('div', 'text-base font-extrabold tracking-tight mt-1.5 truncate', value));
  t.appendChild(el('div', 'text-[10px] opacity-80 mt-0.5 truncate', hint || ' '));
  return t;
}

function ccSection(title, node) {
  const s = el('div', 'space-y-2');
  s.appendChild(el('div', 'text-xs font-semibold text-zinc-500 uppercase tracking-wide px-1', title));
  s.appendChild(node);
  return s;
}

function ccBotTile() {
  const p = ccState.ping;
  if (p.state === 'checking') return ccTile('bot', 'Bot', 'Vérification…', 'warn', 'Patiente quelques secondes');
  if (p.state === 'online') {
    const hint = p.old ? 'Version à mettre à jour' : [p.ws != null ? p.ws + ' ms' : null, p.up != null ? 'actif ' + ccUptime(p.up) : null].filter(Boolean).join(' · ');
    return ccTile('bot', 'Bot Discord', 'En ligne', 'ok', hint);
  }
  if (p.state === 'silent') return ccTile('bot', 'Bot Discord', 'Silencieux', 'bad', 'Aucune réponse en ' + CC_PING_WAIT_MS / 1000 + ' s');
  if (p.state === 'error') return ccTile('bot', 'Bot Discord', 'Erreur', 'bad', (p.detail || '').slice(0, 60));
  return ccTile('bot', 'Bot Discord', 'Inconnu', 'warn', 'Touche « Vérifier le bot »');
}

function ccActionBtn(iconName, label, onClick) {
  const b = el('button', 'btn btn-ghost !justify-start !px-3 !py-3 text-left');
  b.type = 'button';
  b.appendChild(icon(iconName, 'w-4 h-4 shrink-0'));
  b.appendChild(el('span', 'text-xs font-semibold leading-tight', label));
  b.addEventListener('click', onClick);
  return b;
}

function ccRender() {
  const root = document.getElementById('cc-root');
  if (!root) return;
  const d = ccState.data;
  root.replaceChildren();
  if (!d) {
    root.appendChild(el('div', 'skeleton'));
    root.appendChild(el('div', 'skeleton'));
    return;
  }

  const sub = document.getElementById('cc-sub');
  if (sub) sub.textContent = 'Mis à jour à ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  // --- Santé ---
  const pending = (d.commands || []).filter(c => c.status === 'PENDING').length;
  const grid = el('div', 'grid grid-cols-3 gap-2');
  grid.appendChild(ccBotTile());
  grid.appendChild(ccTile('database', 'Base', d.failed ? 'Incomplet' : 'OK', d.failed ? 'bad' : d.dbMs > 2500 ? 'warn' : 'ok', d.failed ? d.failed + ' requête(s) en erreur' : d.dbMs + ' ms'));
  grid.appendChild(ccTile('list-checks', 'File du bot', plural(pending, 'en attente', 'en attente'), pending > 3 ? 'warn' : 'ok', 'Commandes du site'));
  root.appendChild(ccSection('Santé', grid));

  // --- À traiter ---
  const list = el('div', 'card divide-y divide-zinc-100');
  const items = ccState.items || [];
  if (!items.length) list.appendChild(el('div', 'px-4 py-4 text-sm text-zinc-400', 'Rien à signaler.'));
  items.forEach(it => {
    const row = el(it.go ? 'button' : 'div', 'w-full flex items-center gap-3 px-4 py-3 text-left');
    if (it.go) { row.type = 'button'; row.addEventListener('click', it.go); }
    row.appendChild(el('span', 'w-2 h-2 rounded-full shrink-0 ' + CC_DOT[it.tone]));
    const info = el('div', 'flex-1 min-w-0');
    info.appendChild(el('div', 'text-sm font-semibold', it.title));
    info.appendChild(el('div', 'text-[11px] text-zinc-500', it.detail));
    row.appendChild(info);
    if (it.go) row.appendChild(icon('chevron-right', 'w-4 h-4 text-zinc-300 shrink-0'));
    list.appendChild(row);
  });
  root.appendChild(ccSection('À traiter', list));

  // --- Actions rapides ---
  const actions = el('div', 'grid grid-cols-2 gap-2');
  actions.appendChild(ccActionBtn('radar', 'Vérifier le bot', () => ccPing(true)));
  actions.appendChild(ccActionBtn('plus', 'Nouvelle mission', () => { ccGo('missions'); if (typeof openMissionForm === 'function') openMissionForm(); }));
  actions.appendChild(ccActionBtn('send', 'Publier les panneaux manquants', () => ccPublishPanels(false)));
  actions.appendChild(ccActionBtn('refresh-cw', 'Tout republier sur Discord', () => ccPublishPanels(true)));
  actions.appendChild(ccActionBtn('wallet', 'Paiements à régler', ccOpenDue));
  actions.appendChild(ccActionBtn('rotate-cw', 'Rafraîchir', async () => { await refreshDashboard(); toast('Mis à jour.'); }));
  root.appendChild(ccSection('Actions rapides', actions));

  // --- Activité récente ---
  const act = el('div', 'card divide-y divide-zinc-100');
  const logs = d.audit || [];
  if (!logs.length) act.appendChild(el('div', 'px-4 py-4 text-sm text-zinc-400', "Pas encore d'activité."));
  logs.forEach(l => {
    const row = el('div', 'flex items-center gap-3 px-4 py-2.5');
    const info = el('div', 'flex-1 min-w-0');
    let label = CC_AUDIT[l.action] || l.action;
    const m = l.metadata || {};
    if (m.deliveryNumber != null) label += ' ' + num5(m.deliveryNumber);
    if (m.score != null) label += ' · ' + m.score + ' %';
    info.appendChild(el('div', 'text-sm font-medium truncate', label));
    info.appendChild(el('div', 'text-[11px] text-zinc-500 truncate', (l.actor && l.actor.username) || 'Système'));
    row.appendChild(info);
    row.appendChild(el('div', 'text-[11px] text-zinc-400 shrink-0', longDate(l.createdAt)));
    act.appendChild(row);
  });
  root.appendChild(ccSection('Activité récente', act));

  // --- Sécurité (lock.js) ---
  if (typeof buildLockCard === 'function') {
    const slot = el('div');
    root.appendChild(ccSection('Sécurité', slot));
    buildLockCard().then(card => { slot.replaceChildren(card); lucide.createIcons(); }).catch(console.error);
  }

  lucide.createIcons();
}

// ============ Actions ============
async function ccPublishPanels(replace) {
  const msg = replace
    ? 'Supprimer et republier TOUS les panneaux du bot sur Discord ?'
    : 'Publier uniquement les panneaux qui manquent sur Discord ?';
  if (!confirm(msg)) return;
  toast('Envoi au bot…');
  try {
    const out = await ccSend('PUBLISH_PANELS', { replace: !!replace }, 60000);
    if (out.state === 'done') toast(out.result || 'Panneaux publiés.');
    else if (out.state === 'failed') toast(/inconnue/i.test(out.result || '') ? 'Le bot doit être mis à jour (webcommands + publishPanels).' : 'Refusé : ' + out.result);
    else toast("Le bot n'a pas répondu.");
  } catch (e) {
    const m = (e && e.message) || String(e);
    toast(/row-level|policy/i.test(m) ? 'Autorisation manquante : lance control-center.sql.' : 'Échec : ' + m);
  }
}

// Paiements à régler, par worker (avec un récapitulatif à copier pour le Mobile Money)
function ccOpenDue() {
  const due = ccDueByWorker(ccState.data && ccState.data.payments);
  const body = openSheet('Paiements à régler', due.length ? plural(due.length, 'worker', 'workers') + ' · ' + usd(due.reduce((t, w) => t + w.total, 0)) : 'Tout est réglé');
  if (!due.length) { body.appendChild(el('p', 'text-sm text-zinc-400', 'Aucun paiement en attente.')); return; }

  const list = el('div', 'space-y-2');
  due.forEach(w => {
    const row = el('button', 'w-full flex items-center gap-3 bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-3 text-left');
    row.type = 'button';
    const info = el('div', 'flex-1 min-w-0');
    info.appendChild(el('div', 'text-sm font-semibold truncate', w.name));
    info.appendChild(el('div', 'text-[11px] text-zinc-500', plural(w.count, 'gain', 'gains') + ' · depuis ' + ccAge(ccHours(w.oldest))));
    row.appendChild(info);
    row.appendChild(el('div', 'text-sm font-bold', usd(w.total)));
    row.addEventListener('click', () => openWallet(w.userId, w.name));
    list.appendChild(row);
  });
  body.appendChild(list);

  const copy = el('button', 'w-full btn btn-ghost btn-block', 'Copier le récapitulatif');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    const text = due.map(w => w.name + ' : ' + usd(w.total)).join('\n') + '\nTotal : ' + usd(due.reduce((t, w) => t + w.total, 0));
    try { await navigator.clipboard.writeText(text); toast('Récapitulatif copié.'); }
    catch (e) { toast('Copie impossible sur cet appareil.'); }
  });
  body.appendChild(copy);
  body.appendChild(el('p', 'text-[11px] text-zinc-400', "Touche un worker pour ouvrir son portefeuille et marquer le paiement comme fait."));
}

// ============ Branchements ============
(function initControl() {
  const link = document.querySelectorAll('[data-nav="control"]');
  link.forEach(a => a.addEventListener('click', () => {
    ccRender();
    loadControl().then(() => ccPing(false)).catch(console.error);
  }));
  // Quand l'état du verrouillage change, on recalcule les points d'attention
  window.addEventListener('illico:lock', e => {
    ccState.lock = e.detail;
    if (ccState.data) { ccState.items = ccAttention(ccState.data); ccSummary(); if (ccIsVisible()) ccRender(); }
  });
})();
