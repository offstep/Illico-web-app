
// ---------- Missions : créer, publier et clôturer depuis le site ----------
// Dépend de : utils.js (el, toast). Recharge l'écran avec loadDashboardData() (data.js).
// Seuls les admins peuvent écrire (règle RLS « admin_write » sur Mission).
// Choix volontaires : type STANDARD et livraison en TEXTE uniquement (le bot ne gère pas
// encore l'envoi de fichiers) ; la mission d'essai reste gérée par le bot.

const LIMITS = { title: 80, description: 500, instructions: 3500, items: 100, itemsChars: 3500 };

const missionOverlay = document.getElementById('mission-overlay');
const missionForm = document.getElementById('mission-form');
const missionError = document.getElementById('mf-error');
const f = id => document.getElementById(id);

function showMissionError(msg) {
  missionError.textContent = msg;
  missionError.classList.remove('hidden');
}

function openMissionForm() {
  missionForm.reset();
  f('mf-tasks').dataset.auto = '';
  missionError.classList.add('hidden');
  missionOverlay.classList.remove('hidden');
}
function closeMissionForm() {
  missionOverlay.classList.add('hidden');
}

function setMissionBusy(busy) {
  f('mf-draft').disabled = busy;
  f('mf-publish').disabled = busy;
}

// Lit et vérifie le formulaire -> { row } ou { error }
function readMissionForm() {
  const title = f('mf-title').value.trim();
  const description = f('mf-description').value.trim();
  const instructions = f('mf-instructions').value.trim();
  const items = f('mf-items').value.split('\n').map(s => s.trim()).filter(Boolean);

  const intOf = (id, { required, min, max, label }) => {
    const raw = f(id).value.trim();
    if (raw === '') return required ? { error: label + ' : obligatoire.' } : { value: null };
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return { error: label + ' : entier entre ' + min + ' et ' + max + '.' };
    return { value: n };
  };

  if (!title) return { error: 'Le titre est obligatoire.' };
  if (title.length > LIMITS.title) return { error: 'Titre trop long (' + LIMITS.title + ' caractères max).' };
  if (!description) return { error: 'La description est obligatoire.' };
  if (!instructions) return { error: 'Les instructions sont obligatoires.' };
  if (items.length > LIMITS.items) return { error: 'Trop d\'éléments (' + LIMITS.items + ' max).' };
  if (items.join('\n').length > LIMITS.itemsChars) return { error: 'Les données sont trop longues.' };

  const reward = intOf('mf-reward', { required: true, min: 1, max: 100000, label: 'Récompense' });
  if (reward.error) return reward;
  const tasks = intOf('mf-tasks', { required: true, min: 1, max: 1000, label: 'Nombre de tâches' });
  if (tasks.error) return tasks;
  const max = intOf('mf-max', { required: false, min: 1, max: 10000, label: 'Places max' });
  if (max.error) return max;
  const deadline = intOf('mf-deadline', { required: false, min: 1, max: 720, label: 'Délai' });
  if (deadline.error) return deadline;

  return {
    row: {
      id: crypto.randomUUID(),            // la base n'a pas de valeur par défaut pour l'id
      type: 'STANDARD',
      title,
      description,
      difficulty: f('mf-difficulty').value,
      taskCount: tasks.value,
      reward: reward.value,
      maxWorkers: max.value,
      deadlineHours: deadline.value,
      instructions,
      data: items.length ? { items } : null,
      deliveryFormat: 'TEXT'
    }
  };
}

async function saveMission(status) {
  const r = readMissionForm();
  if (r.error) return showMissionError(r.error);
  if (status === 'PUBLISHED' && !(await confirmPublish(r.row))) return;

  missionError.classList.add('hidden');
  setMissionBusy(true);
  try {
    const { error } = await window.sb.from('Mission').insert({ ...r.row, status });
    if (error) throw error;
    closeMissionForm();
    toast(status === 'PUBLISHED' ? 'Mission publiée.' : 'Brouillon enregistré.');
    lastLoad = 0;
    await loadDashboardData();
  } catch (e) {
    console.error('Création de mission :', e);
    showMissionError('Enregistrement impossible : ' + (e.message || e));
  } finally {
    setMissionBusy(false);
  }
}

// Bouton d'action d'une carte de mission (utilisé par data.js)
function missionActions(m) {
  if (m.type === 'TRIAL') return null;    // la mission d'essai est gérée par le bot
  let label, next, ask, done;
  if (m.status === 'DRAFT') {
    label = 'Publier'; next = 'PUBLISHED'; ask = 'Publier cette mission ?'; done = 'Mission publiée.';
  } else if (m.status === 'PUBLISHED') {
    label = 'Clôturer'; next = 'CLOSED'; ask = 'Clôturer cette mission ?'; done = 'Mission clôturée.';
  } else {
    return null;
  }
  const b = el('button', 'mt-3 w-full border border-zinc-200 rounded-full py-2 text-xs font-semibold active:scale-95 transition', label);
  b.type = 'button';
  b.addEventListener('click', () => setMissionStatus(m, next, ask, done, b));
  return b;
}

async function setMissionStatus(m, status, ask, done, btn) {
  // Publier passe par le contrôle (contournable) ; clôturer demande une simple confirmation
  const go = status === 'PUBLISHED' ? await confirmPublish(m) : confirm(ask);
  if (!go) return;
  btn.disabled = true;
  try {
    const { data, error } = await window.sb.from('Mission').update({ status }).eq('id', m.id).select('id');
    if (error) throw error;
    // Une règle RLS qui refuse ne renvoie pas d'erreur : 0 ligne modifiée
    if (!data || !data.length) throw new Error('aucune ligne modifiée (droits admin ?)');
    toast(done);
    lastLoad = 0;
    await loadDashboardData();
  } catch (e) {
    console.error('Changement de statut :', e);
    toast('Échec : ' + (e.message || e));
    btn.disabled = false;
  }
}

// ----- Branchements -----
f('new-mission-btn').addEventListener('click', openMissionForm);
f('mission-close').addEventListener('click', closeMissionForm);
missionOverlay.addEventListener('click', e => { if (e.target === missionOverlay) closeMissionForm(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMissionForm(); });
missionForm.addEventListener('submit', e => e.preventDefault());
f('mf-draft').addEventListener('click', () => saveMission('DRAFT'));
f('mf-publish').addEventListener('click', () => saveMission('PUBLISHED'));

// Le nombre de tâches se remplit tout seul d'après les données, tant qu'on ne l'a pas modifié
f('mf-items').addEventListener('input', () => {
  const n = f('mf-items').value.split('\n').filter(l => l.trim()).length;
  const t = f('mf-tasks');
  if (n && (t.value === '' || t.dataset.auto === '1')) { t.value = n; t.dataset.auto = '1'; }
});
f('mf-tasks').addEventListener('input', () => { f('mf-tasks').dataset.auto = '0'; });
