
// ---------- Outils partagés : formatage et petits constructeurs DOM ----------
// Tout le texte venant de la base passe par textContent : aucun HTML n'est injecté.

// Numéro de version affiché dans Compte : sert à vérifier que les fichiers sont à jour
const APP_VERSION = 'v5';
{
  const v = document.getElementById('app-version');
  if (v) v.textContent = 'ILLICO Workforce · version bêta · ' + APP_VERSION;
}

// Montants : toujours en dollars, entiers (la base stocke des entiers)
const usd = n => '$' + Number(n || 0).toLocaleString('en-US');
const num5 = n => '#' + String(n).padStart(5, '0');
const plural = (n, un, plus) => n + ' ' + (n > 1 ? plus : un);
const shortDate = d => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : '';
const longDate = d => d
  ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '';

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

// Pastille de statut : map = { CLE: ['Libellé', 'classes tailwind'] }
function badge(map, key) {
  const [label, cls] = map[key] || [key, 'bg-zinc-100 text-zinc-600'];
  return el('span', 'text-[10px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ' + cls, label);
}

// Bandeau d'erreur en haut de l'écran
function showNotice(msg) {
  const n = document.getElementById('notice');
  n.textContent = msg;
  n.classList.remove('hidden');
}
function hideNotice() {
  document.getElementById('notice').classList.add('hidden');
}

// Petit message temporaire
let toastTimer;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', 'fixed top-4 inset-x-4 mx-auto max-w-sm z-[95] bg-black text-white text-xs font-medium rounded-full px-4 py-3 text-center shadow-lg');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);
}
