
// ---------- Données réelles lues dans Supabase ----------
// Appelé par auth.js dès que l'admin est connecté.

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

// ----- Petits outils (textContent partout : pas de HTML injecté) -----
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function icon(name, cls) {
  const i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  i.className = cls;
  return i;
}
function badge(map, key) {
  const [label, cls] = map[key] || [key, 'bg-zinc-100 text-zinc-600'];
  return el('span', 'text-[10px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ' + cls, label);
}
const fcfa = n => Number(n || 0).toLocaleString('fr-FR') + ' FCFA';
const num5 = n => '#' + String(n).padStart(5, '0');
const plural = (n, un, plus) => n + ' ' + (n > 1 ? plus : un);
const shortDate = d => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : '';

function showNotice(msg) {
  const n = document.getElementById('notice');
  n.textContent = msg;
  n.classList.remove('hidden');
}
function hideNotice() {
  document.getElementById('notice').classList.add('hidden');
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
async function loadStats() {
  const [workers, published, drafts, paid] = await Promise.all([
    countRows('WorkerProfile', q => q.in('status', ['TRIAL', 'VERIFIED'])),
    countRows('Mission', q => q.eq('status', 'PUBLISHED')),
    countRows('Mission', q => q.eq('status', 'DRAFT')),
    window.sb.from('Payment').select('amount').eq('status', 'PAID')
  ]);
  if (paid.error) throw paid.error;

  const total = (paid.data || []).reduce((s, p) => s + (p.amount || 0), 0);
  document.getElementById('stat-workers').textContent = workers;
  document.getElementById('stat-missions').textContent = published;
  document.getElementById('stat-payments').textContent = fcfa(total);

  document.getElementById('home-card-title').textContent =
    drafts > 0 ? plural(drafts, 'mission en brouillon', 'missions en brouillon') : 'Aucune mission en brouillon';
  document.getElementById('home-card-sub').textContent =
    drafts > 0 ? (drafts > 1 ? 'Prêtes à être publiées' : 'Prête à être publiée') : 'Tout est publié';
}

// ----- Workers -----
async function loadWorkers() {
  const { data, error } = await window.sb
    .from('WorkerProfile')
    .select('id, status, User(username, MissionWorker(count))')
    .order('createdAt', { ascending: false })
    .limit(200);
  if (error) throw error;

  const list = document.getElementById('worker-list');
  list.replaceChildren();

  (data || []).forEach(w => {
    const name = (w.User && w.User.username) || 'Inconnu';
    const missions = (w.User && w.User.MissionWorker && w.User.MissionWorker[0] && w.User.MissionWorker[0].count) || 0;

    const row = el('div', 'worker-item bg-white border border-zinc-200 rounded-2xl p-4 flex items-center gap-3 shadow-sm');
    row.appendChild(el('div', 'w-11 h-11 rounded-full bg-black text-white flex items-center justify-center font-bold text-sm', name.slice(0, 2).toUpperCase()));

    const info = el('div', 'flex-1 min-w-0');
    info.appendChild(el('div', 'font-semibold text-sm truncate', name));
    info.appendChild(el('div', 'text-xs text-zinc-500', plural(missions, 'mission prise', 'missions prises')));
    row.appendChild(info);

    row.appendChild(badge(WORKER_STATUS, w.status));
    list.appendChild(row);
  });

  document.getElementById('worker-empty').textContent = 'Aucun worker pour l\'instant.';
  document.getElementById('worker-empty').classList.toggle('hidden', list.children.length > 0);

  // Réapplique la recherche en cours
  const search = document.getElementById('worker-search');
  if (search && search.value) search.dispatchEvent(new Event('input'));
}

// ----- Missions -----
async function loadMissions() {
  const { data, error } = await window.sb
    .from('Mission')
    .select('id, number, title, type, status, reward, maxWorkers, MissionWorker(count)')
    .order('createdAt', { ascending: false })
    .limit(200);
  if (error) throw error;

  const list = document.getElementById('mission-list');
  list.replaceChildren();

  (data || []).forEach(m => {
    const taken = (m.MissionWorker && m.MissionWorker[0] && m.MissionWorker[0].count) || 0;

    const card = el('div', 'mission-item bg-white border border-zinc-200 rounded-2xl p-4 shadow-sm');
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
    r.appendChild(document.createTextNode(fcfa(m.reward)));
    meta.appendChild(w);
    meta.appendChild(r);
    card.appendChild(meta);

    list.appendChild(card);
  });

  const empty = document.getElementById('mission-empty');
  empty.textContent = list.children.length === 0 ? 'Aucune mission pour l\'instant.' : 'Aucune mission dans cette catégorie.';
  empty.classList.toggle('hidden', list.children.length > 0);

  // Réapplique le filtre choisi (sinon un rafraîchissement l'efface)
  const activeChip = document.querySelector('[data-filter].bg-black');
  if (activeChip) activeChip.click();
}

// ----- QA (lecture seule) -----
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

  (data || []).forEach(d => {
    if (d.status === 'SUBMITTED' || d.status === 'IN_REVIEW') pending++;
    else if (d.status === 'VALIDATED') ok++;
    else if (d.status === 'CORRECTION') ko++;

    const files = (d.DeliveryFile && d.DeliveryFile[0] && d.DeliveryFile[0].count) || 0;
    const worker = (d.worker && d.worker.username) || 'Inconnu';
    const mission = d.MissionWorker && d.MissionWorker.Mission && d.MissionWorker.Mission.title;

    const reviews = (d.QualityReview || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const lastScore = reviews.length ? reviews[0].score : null;

    const card = el('div', 'bg-white border border-zinc-200 rounded-2xl p-4 shadow-sm flex items-center gap-3');

    const ic = el('div', 'w-11 h-11 rounded-xl bg-zinc-100 flex items-center justify-center shrink-0');
    ic.appendChild(icon('file-check', 'w-5 h-5 text-zinc-500'));
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

  document.getElementById('qa-count-pending').textContent = pending;
  document.getElementById('qa-count-ok').textContent = ok;
  document.getElementById('qa-count-ko').textContent = ko;
  document.getElementById('qa-empty').classList.toggle('hidden', list.children.length > 0);
}

// ----- Point d'entrée (appelé par auth.js) -----
let lastLoad = 0;

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
    hideNotice();

    await Promise.all([loadStats(), loadWorkers(), loadMissions(), loadDeliveries()]);
    lucide.createIcons();
  } catch (e) {
    console.error('Erreur de chargement :', e);
    showNotice('Erreur de chargement : ' + (e.message || e));
  }
}

// Rafraîchit toutes les 60 secondes quand l'onglet est visible
setInterval(async () => {
  if (document.hidden) return;
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) return;
  lastLoad = 0;
  loadDashboardData();
}, 60000);
