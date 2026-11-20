
// ---------- Écran Pilotage : Prévision, Calcul de mission, Performance ----------
// Dépend de : utils.js, forecast.js. loadPerformance() est appelée par data.js.

// Champ numérique réutilisable : renvoie { wrap, input }
function numField(label, value, { step = '1', suffix = '' } = {}) {
  const wrap = el('label', 'block');
  wrap.appendChild(el('span', 'field-label', label));
  const box = el('div', 'relative');
  const input = el('input', 'field' + (suffix ? ' pr-12' : ''));
  input.type = 'number';
  input.inputMode = 'decimal';
  input.min = '0';
  input.step = step;
  input.value = value;
  box.appendChild(input);
  if (suffix) box.appendChild(el('span', 'absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-400 pointer-events-none', suffix));
  wrap.appendChild(box);
  return { wrap, input };
}

const readNum = input => input.value.trim() === '' ? NaN : Number(input.value);
const fmt = (n, d = 0) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d });
const dayLabel = daysFromNow => {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
};

function resultRow(label, value, hint) {
  const r = el('div', 'flex items-baseline justify-between gap-3 py-2.5');
  const l = el('div', 'min-w-0');
  l.appendChild(el('div', 'text-sm text-zinc-600', label));
  if (hint) l.appendChild(el('div', 'text-[11px] text-zinc-400', hint));
  r.appendChild(l);
  r.appendChild(el('div', 'text-sm font-bold text-right shrink-0', value));
  return r;
}

function verdictBlock(tone, title, subtitle) {
  const b = el('div', 'tone-' + tone + ' rounded-2xl px-4 py-4');
  b.appendChild(el('div', 'text-xl font-extrabold tracking-tight', title));
  if (subtitle) b.appendChild(el('div', 'text-xs mt-1 opacity-90', subtitle));
  return b;
}

// ============ 1. Prévision ============
function buildForecast() {
  const s = loadSettings();
  const root = el('div', 'space-y-4');

  const form = el('div', 'card p-4 grid grid-cols-2 gap-3');
  const volume = numField('Volume (tâches)', 1000);
  const days = numField('Délai (jours)', 5, { step: '0.5' });
  const minPer = numField('Minutes par tâche', s.minPerTask, { step: '0.5' });
  const workers = numField('Workers', pilot.activeWorkers || 10);
  const hpd = numField('Heures / jour / worker', pilot.avgHours ? Math.round(pilot.avgHours * 10) / 10 : s.hoursPerDay, { step: '0.5' });
  const eff = numField('Rendement', s.efficiency, { suffix: '%' });
  [volume, days, minPer, workers, hpd, eff].forEach(f => form.appendChild(f.wrap));
  root.appendChild(form);

  const hint = el('p', 'text-[11px] text-zinc-400 px-1', '');
  root.appendChild(hint);
  const out = el('div', 'space-y-3');
  root.appendChild(out);

  let workersTouched = false, hoursTouched = false;
  workers.input.addEventListener('input', () => { workersTouched = true; });
  hpd.input.addEventListener('input', () => { hoursTouched = true; });

  function render() {
    // le nombre de workers actifs arrive après le chargement : on le reprend tant qu'on n'y a pas touché
    if (!workersTouched && pilot.activeWorkers && Number(workers.input.value) !== pilot.activeWorkers) {
      workers.input.value = pilot.activeWorkers;
    }
    // les heures moyennes déclarées par les workers à l'inscription remplacent la valeur par défaut
    if (!hoursTouched && pilot.avgHours) {
      const avg = Math.round(pilot.avgHours * 10) / 10;
      if (Number(hpd.input.value) !== avg) hpd.input.value = avg;
    }
    hint.textContent = pilot.activeWorkers != null
      ? 'Workers actifs : ' + pilot.activeWorkers + (pilot.declared ? ' · disponibilité moyenne déclarée : ' + fmt(pilot.avgHours, 1) + ' h/jour (' + pilot.declared + ' profils)' : '') + '. Modifiable pour simuler.'
      : '';

    const r = computeForecast({
      volume: readNum(volume.input), days: readNum(days.input), minPerTask: readNum(minPer.input),
      workers: readNum(workers.input), hoursPerDay: readNum(hpd.input), efficiency: readNum(eff.input)
    });
    out.replaceChildren();
    if (r.error) {
      out.appendChild(el('p', 'text-sm text-zinc-400 text-center py-4', 'Remplis tous les champs avec des nombres positifs.'));
      return;
    }
    saveSettings({ minPerTask: readNum(minPer.input), hoursPerDay: readNum(hpd.input), efficiency: readNum(eff.input) });

    const title = r.coverage >= 100 ? 'Capacité suffisante · ' + fmt(r.coverage) + ' %' : 'Capacité insuffisante · ' + fmt(r.coverage) + ' %';
    const sub = r.coverage >= 100
      ? 'Fin prévue vers le ' + dayLabel(r.daysNeeded) + '.'
      : 'Il manque environ ' + fmt(r.missingHours) + ' h de production.';
    out.appendChild(verdictBlock(r.tone, title, sub));

    const box = el('div', 'card px-4 divide-y divide-zinc-100');
    box.appendChild(resultRow('Travail à fournir', fmt(r.hoursNeeded, 1) + ' h', 'rendement compris'));
    box.appendChild(resultRow('Capacité sur le délai', fmt(r.capacityHours, 1) + ' h'));
    box.appendChild(resultRow('Tâches par jour', fmt(r.tasksPerDayCapacity) + ' / ' + fmt(r.tasksPerDayNeeded), 'capacité / nécessaire'));
    box.appendChild(resultRow('Workers nécessaires', fmt(r.workersNeeded), r.extraWorkers ? '+' + r.extraWorkers + ' à recruter' : 'équipe suffisante'));
    out.appendChild(box);

    if (r.coverage < 100) {
      const fix = el('div', 'card p-4 space-y-1.5');
      fix.appendChild(el('div', 'text-xs font-semibold text-zinc-500 uppercase tracking-wide', 'Pour tenir le délai'));
      fix.appendChild(el('div', 'text-sm', '• ajouter ' + r.extraWorkers + ' worker' + (r.extraWorkers > 1 ? 's' : '')));
      fix.appendChild(el('div', 'text-sm', '• ou repousser le délai à ' + fmt(r.daysNeeded, 1) + ' jours'));
      fix.appendChild(el('div', 'text-sm', '• ou passer à ' + fmt(r.hoursPerDayNeeded, 1) + ' h/jour par worker'));
      out.appendChild(fix);
    }
  }
  form.addEventListener('input', render);
  root.render = render;
  render();
  return root;
}

// ============ 2. Calcul de mission ============
function buildCalc() {
  const root = el('div', 'space-y-4');
  const form = el('div', 'card p-4 grid grid-cols-2 gap-3');
  const rate = numField('Tarif client', 15, { step: '0.5', suffix: '$/h' });
  const volume = numField('Volume (tâches)', 1000);
  const minPer = numField('Minutes par tâche', loadSettings().minPerTask, { step: '0.5' });
  const wPct = numField('Part workers', 66, { suffix: '%' });
  const qaPct = numField('Part QA', 8, { suffix: '%' });
  const opsPct = numField('Part opérations', 6, { suffix: '%' });
  [rate, volume, minPer, wPct, qaPct, opsPct].forEach(f => form.appendChild(f.wrap));
  root.appendChild(form);

  const out = el('div', 'space-y-3');
  root.appendChild(out);

  function render() {
    const r = computeEconomics({
      rate: readNum(rate.input), volume: readNum(volume.input), minPerTask: readNum(minPer.input),
      workersPct: readNum(wPct.input), qaPct: readNum(qaPct.input), opsPct: readNum(opsPct.input)
    });
    out.replaceChildren();
    if (r.error) {
      out.appendChild(el('p', 'text-sm text-zinc-400 text-center py-4', 'Remplis tous les champs avec des nombres positifs.'));
      return;
    }
    const subtitle = r.margin < 0 ? 'Cette mission fait perdre de l\'argent.' : r.tone === 'ok' ? 'Marge confortable.' : r.tone === 'warn' ? 'Marge serrée.' : 'Marge trop faible.';
    out.appendChild(verdictBlock(r.tone, 'Marge ' + fmt(r.marginPct, 1) + ' % · ' + usd2(r.margin), subtitle));

    // répartition du chiffre d'affaires
    const total = r.revenue || 1;
    const seg = (value, color) => { const s = el('span'); s.style.width = Math.max(0, value / total * 100) + '%'; s.style.background = color; return s; };
    const bar = el('div', 'bar');
    bar.appendChild(seg(r.workers, '#0a0a0b'));
    bar.appendChild(seg(r.qa, '#71717a'));
    bar.appendChild(seg(r.ops, '#d4d4d8'));
    bar.appendChild(seg(Math.max(r.margin, 0), r.tone === 'bad' ? '#dc2626' : '#059669'));
    const barBox = el('div', 'card p-4 space-y-2');
    barBox.appendChild(bar);
    barBox.appendChild(el('div', 'text-[11px] text-zinc-500', 'Workers · QA · Opérations · Marge'));
    out.appendChild(barBox);

    const box = el('div', 'card px-4 divide-y divide-zinc-100');
    box.appendChild(resultRow('Heures facturables', fmt(r.billableHours, 1) + ' h'));
    box.appendChild(resultRow('Chiffre d\'affaires', usd2(r.revenue)));
    box.appendChild(resultRow('Coût workers', usd2(r.workers)));
    box.appendChild(resultRow('Coût QA', usd2(r.qa)));
    box.appendChild(resultRow('Coûts opérationnels', usd2(r.ops)));
    box.appendChild(resultRow('Marge estimée', usd2(r.margin)));
    out.appendChild(box);

    const pay = el('div', 'card px-4 divide-y divide-zinc-100');
    pay.appendChild(resultRow('Paie par tâche', usd2(r.perTask), 'pour fixer la récompense d\'une mission'));
    pay.appendChild(resultRow('Paie horaire worker', usd2(r.workerHourly) + '/h'));
    out.appendChild(pay);
  }
  form.addEventListener('input', render);
  render();
  return root;
}

// ============ 3. Performance (données réelles) ============
async function loadPerformance() {
  const box = document.getElementById('pilot-perf');
  if (!box) return;

  const { data, error } = await window.sb
    .from('QualityReview')
    .select('score, validated, createdAt, Delivery(worker:User!workerId(username))')
    .order('createdAt', { ascending: false })
    .limit(500);
  if (error) throw error;

  const rows = data || [];
  box.replaceChildren();
  if (!rows.length) {
    box.appendChild(el('p', 'text-center text-sm text-zinc-400 py-8', 'Aucune évaluation pour l\'instant.'));
    return;
  }

  const validated = rows.filter(r => r.validated).length;
  const rate = Math.round(validated / rows.length * 100);
  const avg = Math.round(rows.reduce((t, r) => t + (r.score || 0), 0) / rows.length);
  const weekAgo = Date.now() - 7 * 86400000;
  const lastWeek = rows.filter(r => new Date(r.createdAt).getTime() > weekAgo).length;

  const grid = el('div', 'grid grid-cols-3 gap-3');
  [[rate + ' %', 'Taux de validation'], [avg + ' / 100', 'Score moyen'], [lastWeek, 'Évaluées (7 j)']].forEach(([v, l]) => {
    const c = el('div', 'card py-3 text-center');
    c.appendChild(el('div', 'text-lg font-extrabold tracking-tight', String(v)));
    c.appendChild(el('div', 'text-[10px] text-zinc-500 font-medium', l));
    grid.appendChild(c);
  });
  box.appendChild(grid);

  // Classement des workers
  const byWorker = new Map();
  rows.forEach(r => {
    const name = (r.Delivery && r.Delivery.worker && r.Delivery.worker.username) || 'Inconnu';
    const w = byWorker.get(name) || { name, n: 0, ok: 0, sum: 0 };
    w.n++; w.sum += r.score || 0; if (r.validated) w.ok++;
    byWorker.set(name, w);
  });
  const ranking = [...byWorker.values()].sort((a, b) => b.ok - a.ok || b.sum / b.n - a.sum / a.n).slice(0, 8);

  const list = el('div', 'card divide-y divide-zinc-100');
  ranking.forEach((w, k) => {
    const row = el('div', 'flex items-center gap-3 px-4 py-3');
    row.appendChild(el('div', 'w-6 text-xs font-bold text-zinc-400', String(k + 1)));
    const info = el('div', 'flex-1 min-w-0');
    info.appendChild(el('div', 'text-sm font-semibold truncate', w.name));
    info.appendChild(el('div', 'text-[11px] text-zinc-500', plural(w.n, 'évaluation', 'évaluations') + ' · ' + w.ok + ' validée' + (w.ok > 1 ? 's' : '')));
    row.appendChild(info);
    row.appendChild(el('div', 'text-sm font-bold', Math.round(w.sum / w.n) + ' / 100'));
    list.appendChild(row);
  });
  const wrap = el('div', 'space-y-2');
  wrap.appendChild(el('div', 'text-xs font-semibold text-zinc-500 uppercase tracking-wide px-1', 'Meilleurs workers'));
  wrap.appendChild(list);
  box.appendChild(wrap);
  box.appendChild(el('p', 'text-[11px] text-zinc-400 px-1', 'Calculé sur les ' + rows.length + ' dernières évaluations.'));
}

// ============ Onglets ============
(function initPilot() {
  const host = document.getElementById('view-pilot');
  if (!host) return;
  const panes = {
    forecast: document.getElementById('pilot-forecast'),
    calc: document.getElementById('pilot-calc'),
    perf: document.getElementById('pilot-perf')
  };
  const forecast = buildForecast();
  panes.forecast.appendChild(forecast);
  panes.calc.appendChild(buildCalc());

  const tabs = host.querySelectorAll('[data-tab]');
  function select(name) {
    tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    Object.entries(panes).forEach(([k, p]) => p.classList.toggle('hidden', k !== name));
    if (name === 'forecast') forecast.render();   // reprend le nombre de workers actifs
  }
  tabs.forEach(t => t.addEventListener('click', () => select(t.dataset.tab)));
  select('forecast');
})();
