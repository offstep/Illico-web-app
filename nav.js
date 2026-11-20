
// ---------- Navigation entre les écrans ----------
const views = document.querySelectorAll('.view');
const navLinks = document.querySelectorAll('[data-nav]');

function showView(name) {
  views.forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  navLinks.forEach(a => {
    const active = a.dataset.nav === name;
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });
}

navLinks.forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    showView(a.dataset.nav);
  });
});

// ---------- Workers : recherche ----------
const workerSearch = document.getElementById('worker-search');
if (workerSearch) {
  workerSearch.addEventListener('input', () => {
    const q = workerSearch.value.trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll('.worker-item').forEach(item => {
      const match = item.textContent.toLowerCase().includes(q);
      item.classList.toggle('hidden', !match);
      if (match) visible++;
    });
    const empty = document.getElementById('worker-empty');
    empty.textContent = 'Aucun worker trouvé.';
    empty.classList.toggle('hidden', visible > 0);
  });
}

// ---------- Missions : filtres ----------
const chips = document.querySelectorAll('[data-filter]');
chips.forEach(chip => {
  chip.addEventListener('click', () => {
    const f = chip.dataset.filter;
    chips.forEach(c => {
      const on = c === chip;
      c.classList.toggle('bg-black', on);
      c.classList.toggle('text-white', on);
      c.classList.toggle('border-black', on);
      c.classList.toggle('bg-white', !on);
      c.classList.toggle('text-zinc-600', !on);
      c.classList.toggle('border-zinc-200', !on);
    });
    let visible = 0;
    document.querySelectorAll('.mission-item').forEach(m => {
      const show = f === 'all' || m.dataset.status === f;
      m.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    const empty = document.getElementById('mission-empty');
    empty.textContent = document.querySelectorAll('.mission-item').length === 0
      ? "Aucune mission pour l'instant."
      : 'Aucune mission dans cette catégorie.';
    empty.classList.toggle('hidden', visible > 0);
  });
});
