
// ---------- Données réelles lues dans Supabase ----------
// Dépend de : utils.js, sheet.js. Optionnels (s'ils manquent, la fonction concernée est
// simplement absente) : notify.js (cloche), missions.js (créer/publier), review.js
// (évaluer), wallet.js (portefeuille).
// loadDashboardData() est appelée par auth.js dès que l'admin est connecté.

const REFRESH_MS = 30000;          // rafraîchissement automatique
const PENDING_STATES = ['SUBMITTED', 'IN_REVIEW'];

// Doit rester tout en haut : lu par auth.js et les autres fichiers même si la suite échoue
let lastLoad = 0;

const WORKER_STATUS = {
  NEW:          ['Nouveau',         'bg-zinc-100 text-zinc-600'],
  TRAINING:     ['En formation',    'bg-amber-100 text-amber-700'],
  QUIZ_PENDING: ['Quiz en attente', 'bg-amber-100 text-amber-700'],
  TRIAL:        ["À l'essai",       'bg-blue-100 text-blue-700'],
  VERIFIED:     ['Vérifié',         'bg-emerald-100 text-emerald-700'],
  SUSPENDED:    ['Suspendu',        'bg-red-100 text-red-600']
};
const MISSION_STATUS = {
  DRAFT:     ['Brouillon', 'bg-violet-100 text-violet-700'],
  PUBLISHED: ['Publiée',   'bg-blue-100 text-blue-700'],
  CLOSED:    ['Clôturée',  'bg-emerald-100 text-emerald-700']
};
const DELIVERY_STATUS = {
  SUBMITTED:  ['À vérifier', 'bg-amber-100 text-amber-700'],
  IN_REVIEW:  ['En revue',   'bg-blue-100 text-blue-700'],
  CORRECTION: ['À corriger', 'bg-red-100 text-red-600'],
  VALIDATED:  ['Validée',    'bg-emerald-100 text-emerald-700']
};

// Une mission d'essai ou à 0 $ n'est pas rémunérée (comme dans le bot)
const rewardLabel = m => (m.type === 'TRIAL' || !m.reward) ? 'Non rémunérée' : usd(m.reward);

// Recharge tout l'écran tout de suite (utilisé après une action : publier, évaluer, payer…)
function refreshDashboard() {
  lastLoad = 0;
  return loadDashboardData();
}

// Compte les lignes sans les télécharger
async function countRows(table, apply) {
  let q = window.sb.from(table).select('*', { count: 'exact', head: true });
  if (apply) q = apply(q);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

// ----- Accueil -----
// Paiements : isolés, pour qu'une table absente ne bloque pas le reste de l'accueil.
// (La base renvoie au plus 1000 lignes : à remplacer par une vue SQL si les paiements deviennent nombreux.)
async function loadPayments() {
  const { data, error } = await window.sb.from('Payment').select('amount, status');
  if (error) throw error;
  const sum = status => (data || []).filter(p => p.status === status).reduce((t, p) => t + (p.amount || 0), 0);
  document.getElementById('stat-payments').textContent = usd(sum('PAID'));
  document.getElementById('stat-due').textContent = usd(sum('PENDING'));
}

async function loadCounts() {
  const [workers, published, drafts] = await Promise.all([
    countRows('WorkerProfile', q => q.in('status', ['TRIAL', 'VERIFIED'])),
    countRows('Mission', q => q.eq('status', 'PUBLISHED')),
    countRows('Mission', q => q.eq('status', 'DRAFT'))
  ]);
  pilot.activeWorkers = workers;   // sert à la Prévision et au contrôle avant publication
  document.getElementById('stat-workers').textContent = workers;
  document.getElementById('stat-missions').textContent = published;

  document.getElementById('home-card-title').textContent =
    drafts > 0 ? plural(drafts, 'mission en brouillon', 'missions en brouillon') : 'Aucune mission en brouillon';
  document.getElementById('home-card-sub').textContent =
    drafts > 0 ? (drafts > 1 ? 'Prêtes à être publiées' : 'Prête à être publiée') : 'Tout est publié';
}

// ----- Workers (avec solde du portefeuille) -----
async function loadWorkers() {
  const { data, error } = await window.sb
    .from('WorkerProfile')
    .select('id, userId, status, User(username, MissionWorker(count), Payment(amount, status))')
    .order('createdAt', { ascending: false })
    .limit(200);
  if (error) throw error;

  const list = document.getElementById('worker-list');
  list.replaceChildren();

  (data || []).forEach(w => {
    const name = (w.User && w.User.username) || 'Inconnu';
    const missions = (w.User && w.User.MissionWorker && w.User.MissionWorker[0] && w.User.MissionWorker[0].count) || 0;
    const due = sumDue((w.User && w.User.Payment) || []);

    const row = el('div', 'worker-item card tap p-4 flex items-center gap-3');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const open = () => {
      if (typeof openWallet === 'function') openWallet(w.userId, name);
      else toast('Fichier wallet.js manquant sur le site.');
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });

    row.appendChild(el('div', 'w-11 h-11 rounded-full bg-gradient-to-br from-zinc-700 to-black text-white flex items-center justify-center font-bold text-sm shrink-0', name.slice(0, 2).toUpperCase()));

    const info = el('div', 'flex-1 min-w-0');
    info.appendChild(el('div', 'font-semibold text-sm truncate', name));
    info.appendChild(el('div', 'text-xs text-zinc-500', plural(missions, 'mission prise', 'missions prises') + (due > 0 ? ' · ' + usd(due) + ' à payer' : '')));
    row.appendChild(info);

    row.appendChild(badge(WORKER_STATUS, w.status));
    list.appendChild(row);
  });

  document.getElementById('worker-empty').textContent = "Aucun worker pour l'instant.";
  document.getElementById('worker-empty').classList.toggle('hidden', list.children.length > 0);

  // Réapplique la recherche en cours
  const search = document.getElementById('worker-search');
  if (search && search.value) search.dispatchEvent(new Event('input'));
}

const sumDue = payments => payments.filter(p => p.status === 'PENDING').reduce((t, p) => t + (p.amount || 0), 0);

// ----- Missions -----
async function loadMissions() {
  const { data, error } = await window.sb
    .from('Mission')
    .select('id, number, title, type, status, reward, maxWorkers, taskCount, deadlineHours, MissionWorker(count)')
    .order('createdAt', { ascending: false })
    .limit(200);
  if (error) throw error;

  const list = document.getElementById('mission-list');
  list.replaceChildren();

  (data || []).forEach(m => {
    const taken = (m.MissionWorker && m.MissionWorker[0] && m.MissionWorker[0].count) || 0;

    const card = el('div', 'mission-item card p-4');
    card.dataset.status = m.status;

    const top = el('div', 'flex items-start justify-between gap-3');
    const left = el('div', 'min-w-0');
    left.appendChild(el('div', 'font-semibold text-sm', m.title));
    left.appendChild(el('div', 'text-xs text-zinc-500 mt-0.5', num5(m.number) + ' · ' + (m.type === 'TRIAL' ? 'Essai' : 'Standard')));
    top.appendChild(left);
    top.appendChild(badge(MISSION_STATUS, m.status));
    card.appendChild(top);

    const meta = el('div', 'flex items-center gap-4 mt-3 text-xs text-zinc-500');
    const w = el('span', 'flex items-center gap-1');
    w.appendChild(icon('users', 'w-3.5 h-3.5'));
    w.appendChild(document.createTextNode(m.maxWorkers ? taken + ' / ' + m.maxWorkers : plural(taken, 'worker', 'workers')));
    const r = el('span', 'flex items-center gap-1');
    r.appendChild(icon('wallet', 'w-3.5 h-3.5'));
    r.appendChild(document.createTextNode(rewardLabel(m)));
    meta.appendChild(w);
    meta.appendChild(r);
    card.appendChild(meta);
    if (m.maxWorkers) {
      const bar = el('div', 'bar mt-2.5');
      const fill = el('span');
      fill.style.width = Math.min(100, taken / m.maxWorkers * 100) + '%';
      fill.style.background = '#0a0a0b';
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    // « Publier » / « Clôturer » (missions.js) : absent = pas de bouton, mais pas d'erreur
    const actions = typeof missionActions === 'function' ? missionActions(m) : null;
    if (actions) card.appendChild(actions);

    list.appendChild(card);
  });

  const empty = document.getElementById('mission-empty');
  empty.textContent = list.children.length === 0 ? "Aucune mission pour l'instant." : 'Aucune mission dans cette catégorie.';
  empty.classList.toggle('hidden', list.children.length > 0);

  // Réapplique le filtre choisi (sinon un rafraîchissement l'efface)
  const activeChip = document.querySelector('[data-filter].bg-black');
  if (activeChip) activeChip.click();
}

// ----- QA : liste + alertes -----
const lastStatus = new Map();   // id de livraison -> dernier statut vu
let firstDeliveryLoad = true;

async function loadDeliveries() {
  const { data, error } = await window.sb
    .from('Delivery')
    .select('id, number, status, submittedAt, createdAt, worker:User!workerId(username), MissionWorker(Mission(title)), DeliveryFile(count), QualityReview(score, createdAt)')
    .not('status', 'in', '(PREPARING,CANCELLED)')
    .order('createdAt', { ascending: false })
    .limit(100);
  if (error) throw error;

  const list = document.getElementById('qa-list');
  list.replaceChildren();

  let pending = 0, ok = 0, ko = 0;
  const fresh = [];

  (data || []).forEach(d => {
    if (PENDING_STATES.includes(d.status)) pending++;
    else if (d.status === 'VALIDATED') ok++;
    else if (d.status === 'CORRECTION') ko++;

    const files = (d.DeliveryFile && d.DeliveryFile[0] && d.DeliveryFile[0].count) || 0;
    const worker = (d.worker && d.worker.username) || 'Inconnu';
    const mission = d.MissionWorker && d.MissionWorker.Mission && d.MissionWorker.Mission.title;

    // Nouvelle livraison (ou re-soumise après correction) depuis le dernier rafraîchissement
    if (!firstDeliveryLoad && d.status === 'SUBMITTED' && lastStatus.get(d.id) !== 'SUBMITTED') {
      fresh.push({ number: d.number, worker, mission });
    }
    lastStatus.set(d.id, d.status);

    const reviews = (d.QualityReview || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const lastScore = reviews.length ? reviews[0].score : null;

    const card = el('div', 'bg-white border border-zinc-200 rounded-2xl p-4 shadow-sm flex items-center gap-3 cursor-pointer active:scale-[0.99] transition');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.addEventListener('click', () => openDelivery(d.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDelivery(d.id); } });

    const ic = el('div', 'chip-icon');
    ic.appendChild(icon('file-check', 'w-5 h-5'));
    card.appendChild(ic);

    const info = el('div', 'flex-1 min-w-0');
    info.appendChild(el('div', 'font-semibold text-sm truncate', num5(d.number) + (mission ? ' · ' + mission : '')));
    let sub = worker + ' · ' + plural(files, 'fichier', 'fichiers');
    const when = shortDate(d.submittedAt || d.createdAt);
    if (when) sub += ' · ' + when;
    if (lastScore !== null) sub += ' · note ' + lastScore + '/100';
    info.appendChild(el('div', 'text-xs text-zinc-500 truncate', sub));
    card.appendChild(info);

    card.appendChild(badge(DELIVERY_STATUS, d.status));
    list.appendChild(card);
  });

  firstDeliveryLoad = false;

  document.getElementById('qa-count-pending').textContent = pending;
  document.getElementById('qa-count-ok').textContent = ok;
  document.getElementById('qa-count-ko').textContent = ko;
  document.getElementById('qa-empty').classList.toggle('hidden', list.children.length > 0);

  // notify.js absent = pas de cloche, mais la liste QA s'affiche quand même
  if (typeof updateBell === 'function') updateBell(pending);
  if (typeof notifyNew === 'function') notifyNew(fresh);
}

// ----- QA : détail d'une livraison + évaluation -----
async function openDelivery(id) {
  const body = openSheet('Chargement…', '');

  try {
    const { data: d, error } = await window.sb
      .from('Delivery')
      .select('id, number, status, rawText, comment, submittedAt, createdAt, worker:User!workerId(username), MissionWorker(Mission(title, number)), DeliveryFile(name, url, size), QualityReview(accuracy, completeness, instructions, format, score, validated, comment, createdAt)')
      .eq('id', id)
      .single();
    if (error) throw error;

    const mission = d.MissionWorker && d.MissionWorker.Mission;
    setSheetHeader(
      num5(d.number) + (mission ? ' · ' + mission.title : ''),
      ((d.worker && d.worker.username) || 'Inconnu') + ' · ' + longDate(d.submittedAt || d.createdAt)
    );

    body.appendChild(badge(DELIVERY_STATUS, d.status));

    if (d.rawText) {
      body.appendChild(sheetSection('Réponse', el('pre', 'whitespace-pre-wrap break-words bg-zinc-50 border border-zinc-200 rounded-xl p-3 text-xs', d.rawText)));
    }
    if (d.comment) {
      body.appendChild(sheetSection('Commentaire du worker', el('p', 'text-sm', d.comment)));
    }

    const files = d.DeliveryFile || [];
    if (files.length) {
      const box = el('div', 'space-y-1.5');
      files.forEach(f => {
        const safe = /^https?:\/\//i.test(f.url || '');
        const a = el(safe ? 'a' : 'span', 'flex items-center gap-2 text-sm bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2' + (safe ? ' text-blue-600' : ' text-zinc-400'));
        if (safe) { a.href = f.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        a.appendChild(icon('paperclip', 'w-4 h-4 shrink-0'));
        a.appendChild(el('span', 'truncate flex-1', f.name));
        a.appendChild(el('span', 'text-[10px] text-zinc-400 shrink-0', Math.max(1, Math.round((f.size || 0) / 1024)) + ' Ko'));
        box.appendChild(a);
      });
      body.appendChild(sheetSection('Fichiers', box));
    }

    const reviews = (d.QualityReview || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (reviews.length) {
      const box = el('div', 'space-y-2');
      reviews.forEach(r => {
        const c = el('div', 'bg-zinc-50 border border-zinc-200 rounded-xl p-3 text-xs space-y-1');
        c.appendChild(el('div', 'font-semibold text-sm', (r.validated ? 'Validée' : 'Correction demandée') + ' · ' + r.score + ' %'));
        c.appendChild(el('div', 'text-zinc-500', 'Exactitude ' + r.accuracy + ' % · Complétude ' + r.completeness + ' % · Consignes ' + r.instructions + ' % · Format ' + r.format + ' %'));
        if (r.comment) c.appendChild(el('div', '', r.comment));
        c.appendChild(el('div', 'text-zinc-400', longDate(r.createdAt)));
        box.appendChild(c);
      });
      body.appendChild(sheetSection('Évaluations', box));
    }

    // Évaluer : seulement si la livraison attend un contrôle
    if (PENDING_STATES.includes(d.status)) {
      const { data: cmds } = await window.sb
        .from('WebCommand')
        .select('id')
        .eq('kind', 'REVIEW')
        .in('status', ['PENDING', 'PROCESSING'])
        .eq('payload->>deliveryId', d.id)
        .limit(1);
      if (cmds && cmds.length) {
        body.appendChild(el('p', 'text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2', 'Une évaluation est déjà en attente du bot.'));
      } else if (typeof buildReviewForm === 'function') {
        body.appendChild(sheetSection('Évaluer', buildReviewForm(d.id)));
      } else {
        body.appendChild(el('p', 'text-xs text-zinc-400', 'Fichier review.js manquant sur le site.'));
      }
    }

    if (body.children.length === 1) {
      body.appendChild(el('p', 'text-sm text-zinc-400', 'Aucun contenu enregistré pour cette livraison.'));
    }
    lucide.createIcons();
  } catch (e) {
    console.error('Détail livraison :', e);
    setSheetHeader('Erreur', '');
    body.appendChild(el('p', 'text-sm text-red-600', 'Impossible de charger : ' + ((e && e.message) || e)));
  }
}

// ----- Point d'entrée (appelé par auth.js) -----
async function loadDashboardData() {
  // auth.js peut l'appeler plusieurs fois de suite : on évite les doublons
  if (Date.now() - lastLoad < 3000) return;
  lastLoad = Date.now();

  try {
    const { data: isAdmin, error: adminError } = await window.sb.rpc('is_admin');
    if (adminError) throw adminError;
    if (!isAdmin) {
      showNotice("Accès refusé : ton email Google n'est pas dans la liste des admins.");
      return;
    }

    // Chaque section se charge seule : une erreur n'empêche pas les autres de s'afficher
    const sections = [
      ['Accueil', loadCounts], ['Paiements', loadPayments], ['Workers', loadWorkers],
      ['Missions', loadMissions], ['QA', loadDeliveries]
    ];
    if (typeof loadPerformance === 'function') sections.push(['Performance', loadPerformance]);
    const results = await Promise.allSettled(sections.map(([, load]) => load()));
    const failed = [];
    results.forEach((r, k) => {
      if (r.status === 'rejected') {
        console.error('Section ' + sections[k][0] + ' :', r.reason);
        failed.push(sections[k][0] + ' : ' + ((r.reason && r.reason.message) || r.reason));
      }
    });
    if (failed.length) showNotice('Chargement incomplet — ' + failed.join(' · '));
    else hideNotice();
    lucide.createIcons();
  } catch (e) {
    console.error('Erreur de chargement :', e);
    showNotice('Erreur de chargement : ' + (e.message || e));
  }
}

// Rafraîchit régulièrement quand l'onglet est visible
setInterval(async () => {
  if (document.hidden) return;
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return;
  lastLoad = 0;
  loadDashboardData();
}, REFRESH_MS);
