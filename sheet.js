
// ---------- Fenêtre coulissante partagée ----------
// Utilisée par le détail d'une livraison (data.js) et le portefeuille d'un worker (wallet.js).
// openSheet(titre, sous-titre) vide la fenêtre, l'ouvre et renvoie la zone de contenu.

const sheetOverlay = document.getElementById('detail-overlay');
const sheetTitle = document.getElementById('detail-title');
const sheetSub = document.getElementById('detail-sub');
const sheetBody = document.getElementById('detail-body');

function setSheetHeader(title, sub) {
  sheetTitle.textContent = title;
  sheetSub.textContent = sub || '';
}

function openSheet(title, sub) {
  setSheetHeader(title, sub);
  sheetBody.replaceChildren();
  sheetOverlay.classList.remove('hidden');
  return sheetBody;
}

function closeSheet() {
  sheetOverlay.classList.add('hidden');
}

// Bloc avec un petit titre en majuscules
function sheetSection(title, ...children) {
  const s = el('div');
  s.appendChild(el('div', 'text-[11px] font-semibold text-zinc-500 uppercase tracking-wide mb-1.5', title));
  children.forEach(c => s.appendChild(c));
  return s;
}

// Branchements (tolérants : un élément manquant ne bloque pas le reste)
const sheetClose = document.getElementById('detail-close');
if (sheetClose) sheetClose.addEventListener('click', closeSheet);
if (sheetOverlay) sheetOverlay.addEventListener('click', e => { if (e.target === sheetOverlay) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
