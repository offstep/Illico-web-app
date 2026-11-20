
// ---------- Calculs de prévision et de rentabilité (aucun accès à l'écran) ----------
// Fonctions pures : mêmes entrées = mêmes résultats, faciles à tester.
// Hypothèses réglables stockées sur l'appareil (localStorage, facultatif).

const pilot = { activeWorkers: null };   // rempli par data.js (workers en essai ou vérifiés)

const DEFAULT_SETTINGS = {
  minPerTask: 2,      // minutes par tâche
  hoursPerDay: 2,     // heures de travail par worker et par jour
  efficiency: 85,     // % du temps réellement productif (reprises, pauses)
  minHourly: 3        // paie horaire minimale conseillée pour un worker ($/h)
};
const SETTINGS_KEY = 'illico.settings';

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(out)) if (Number.isFinite(saved[k]) && saved[k] > 0) out[k] = saved[k];
    return out;
  } catch (e) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(patch) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch })); } catch (e) { /* facultatif */ }
}

const ceilTo = (n, digits = 0) => { const p = 10 ** digits; return Math.ceil(n * p - 1e-9) / p; };

// Verdict de couverture : 100 % ou plus = ok, 80-99 % = attention, sinon bloqué
function coverageTone(pct) { return pct >= 100 ? 'ok' : pct >= 80 ? 'warn' : 'bad'; }

// ----- Prévision : peut-on finir à temps avec les workers disponibles ? -----
// in : { volume, minPerTask, days, workers, hoursPerDay, efficiency }
function computeForecast(i) {
  const bad = ['volume', 'minPerTask', 'days', 'workers', 'hoursPerDay', 'efficiency']
    .find(k => !Number.isFinite(i[k]) || i[k] <= 0);
  if (bad) return { error: bad };

  const eff = Math.min(i.efficiency, 100) / 100;
  const hoursNeeded = (i.volume * i.minPerTask) / 60 / eff;            // heures de travail à fournir
  const hoursPerWorkerDay = i.hoursPerDay;
  const capacityHours = i.workers * hoursPerWorkerDay * i.days;        // heures disponibles sur le délai
  const coverage = (capacityHours / hoursNeeded) * 100;

  const tasksPerHour = (60 / i.minPerTask) * eff;
  const tasksPerDayCapacity = i.workers * hoursPerWorkerDay * tasksPerHour;
  const tasksPerDayNeeded = i.volume / i.days;

  const workersNeeded = Math.ceil(hoursNeeded / (hoursPerWorkerDay * i.days) - 1e-9);
  const daysNeeded = hoursNeeded / (i.workers * hoursPerWorkerDay);
  const hoursPerDayNeeded = hoursNeeded / (i.workers * i.days);

  return {
    hoursNeeded, capacityHours, coverage, tone: coverageTone(coverage),
    tasksPerDayCapacity, tasksPerDayNeeded,
    workersNeeded, extraWorkers: Math.max(0, workersNeeded - i.workers),
    missingHours: Math.max(0, hoursNeeded - capacityHours),
    daysNeeded: ceilTo(daysNeeded, 1),
    hoursPerDayNeeded: ceilTo(hoursPerDayNeeded, 1)
  };
}

// ----- Calcul de mission : combien reste-t-il pour ILLICO ? -----
// in : { rate ($/h client), volume, minPerTask, workersPct, qaPct, opsPct }
function computeEconomics(i) {
  const bad = ['rate', 'volume', 'minPerTask'].find(k => !Number.isFinite(i[k]) || i[k] <= 0);
  if (bad) return { error: bad };
  for (const k of ['workersPct', 'qaPct', 'opsPct']) {
    if (!Number.isFinite(i[k]) || i[k] < 0) return { error: k };
  }
  const billableHours = (i.volume * i.minPerTask) / 60;
  const revenue = billableHours * i.rate;
  const workers = revenue * i.workersPct / 100;
  const qa = revenue * i.qaPct / 100;
  const ops = revenue * i.opsPct / 100;
  const margin = revenue - workers - qa - ops;
  const marginPct = revenue ? (margin / revenue) * 100 : 0;
  return {
    billableHours, revenue, workers, qa, ops, margin, marginPct,
    tone: marginPct >= 20 ? 'ok' : marginPct >= 10 ? 'warn' : 'bad',
    perTask: workers / i.volume,
    workerHourly: workers / billableHours
  };
}

// ----- Contrôle avant publication d'une mission (toujours contournable) -----
// m : { taskCount, reward, maxWorkers, deadlineHours } — reward = $ par worker pour la mission
// Renvoie { checks: [{ tone, label, detail }], worst: 'ok' | 'warn' | 'bad' }
function preflight(m, settings = loadSettings(), activeWorkers = pilot.activeWorkers) {
  const checks = [];
  const places = m.maxWorkers || 1;
  const hoursPerWorker = (m.taskCount * settings.minPerTask) / 60 / (settings.efficiency / 100);

  // 1. Il y a assez de workers actifs pour remplir les places
  if (activeWorkers === null || activeWorkers === undefined) {
    checks.push({ tone: 'warn', label: 'Workers', detail: 'Nombre de workers actifs inconnu.' });
  } else if (activeWorkers === 0) {
    checks.push({ tone: 'bad', label: 'Workers', detail: 'Aucun worker actif pour prendre la mission.' });
  } else if (places > activeWorkers) {
    checks.push({ tone: 'warn', label: 'Workers', detail: places + ' places pour ' + activeWorkers + ' worker' + (activeWorkers > 1 ? 's' : '') + ' actif' + (activeWorkers > 1 ? 's' : '') + '.' });
  } else {
    checks.push({ tone: 'ok', label: 'Workers', detail: places + ' place' + (places > 1 ? 's' : '') + ' pour ' + activeWorkers + ' worker' + (activeWorkers > 1 ? 's' : '') + ' actif' + (activeWorkers > 1 ? 's' : '') + '.' });
  }

  // 2. Le délai laisse le temps de travailler
  if (m.deadlineHours) {
    // le worker n'a pas 24 h de travail par jour : on compare au temps de travail réaliste du délai
    const workable = (m.deadlineHours / 24) * Math.max(settings.hoursPerDay, 1);
    const need = ceilTo(hoursPerWorker, 1);
    if (need > m.deadlineHours) {
      checks.push({ tone: 'bad', label: 'Délai', detail: need + ' h de travail pour un délai de ' + m.deadlineHours + ' h : impossible.' });
    } else if (need > workable) {
      checks.push({ tone: 'warn', label: 'Délai', detail: need + ' h de travail pour ~' + ceilTo(workable, 1) + ' h réellement disponibles dans le délai.' });
    } else {
      checks.push({ tone: 'ok', label: 'Délai', detail: need + ' h de travail pour ' + m.deadlineHours + ' h de délai.' });
    }
  } else {
    checks.push({ tone: 'warn', label: 'Délai', detail: 'Aucun délai défini.' });
  }

  // 3. La récompense paie correctement le temps passé
  const hourly = m.reward / hoursPerWorker;
  const hourlyTxt = '$' + (Math.round(hourly * 100) / 100) + '/h pour ' + ceilTo(hoursPerWorker, 1) + ' h de travail (seuil $' + settings.minHourly + '/h).';
  checks.push({
    tone: hourly >= settings.minHourly ? 'ok' : hourly >= settings.minHourly / 2 ? 'warn' : 'bad',
    label: 'Rémunération', detail: hourlyTxt
  });

  const worst = checks.some(c => c.tone === 'bad') ? 'bad' : checks.some(c => c.tone === 'warn') ? 'warn' : 'ok';
  return { checks, worst };
}

if (typeof module !== 'undefined') module.exports = { computeForecast, computeEconomics, preflight, DEFAULT_SETTINGS };
