
// ---------- Contrôle avant publication ----------
// Affiche le verdict de preflight() (forecast.js) dans la fenêtre coulissante.
// Les règles sont des conseils : l'admin peut toujours publier quand même.
// Dépend de : utils.js, sheet.js, forecast.js.

const TONE_TEXT = { ok: 'Prête à publier', warn: 'À vérifier avant de publier', bad: 'Problèmes détectés' };

// Résout true (publier) ou false (annuler)
function confirmPublish(mission) {
  if (typeof openSheet !== 'function' || typeof preflight !== 'function') {
    return Promise.resolve(confirm('Publier cette mission ?'));
  }

  return new Promise(resolve => {
    const settings = loadSettings();
    const { checks, worst } = preflight(mission, settings);
    const body = openSheet('Avant de publier', mission.title || 'Mission');
    let settled = false;
    const finish = answer => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      closeSheet();
      resolve(answer);
    };

    // Fermer la fenêtre autrement que par nos boutons (croix, fond, Échap) = annuler
    const overlay = document.getElementById('detail-overlay');
    const observer = new MutationObserver(() => { if (overlay.classList.contains('hidden')) finish(false); });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });

    const verdict = el('div', 'tone-' + worst + ' rounded-2xl px-4 py-3 text-sm font-semibold', TONE_TEXT[worst]);
    body.appendChild(verdict);

    const list = el('div', 'space-y-2');
    checks.forEach(c => {
      const row = el('div', 'flex items-start gap-3 card px-3 py-3');
      row.appendChild(el('span', 'dot ' + c.tone + ' mt-1.5'));
      const txt = el('div', 'min-w-0');
      txt.appendChild(el('div', 'text-sm font-semibold', c.label));
      txt.appendChild(el('div', 'text-xs text-zinc-500', c.detail));
      row.appendChild(txt);
      list.appendChild(row);
    });
    body.appendChild(list);

    body.appendChild(el('p', 'text-[11px] text-zinc-400',
      'Hypothèses : ' + settings.minPerTask + ' min par tâche, rendement ' + settings.efficiency + ' %, ' +
      settings.hoursPerDay + ' h/jour. Modifiables dans Pilotage.'));

    const actions = el('div', 'flex gap-2');
    const cancel = el('button', 'btn btn-ghost flex-1', 'Annuler');
    cancel.type = 'button';
    cancel.addEventListener('click', () => finish(false));
    const go = el('button', 'btn flex-1 ' + (worst === 'ok' ? 'btn-primary' : 'btn-danger'), worst === 'ok' ? 'Publier' : 'Publier quand même');
    go.type = 'button';
    go.addEventListener('click', () => finish(true));
    actions.appendChild(cancel);
    actions.appendChild(go);
    body.appendChild(actions);
  });
}
