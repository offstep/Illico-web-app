
// ---------- Portefeuille d'un worker ----------
// Solde « à payer » = récompenses validées pas encore réglées (Payment.status = PENDING).
// Les crédits sont créés par le BOT quand une livraison est validée ; le site ne fait que
// les marquer « payé » une fois le virement fait. Ce n'est pas un moyen de paiement :
// l'argent est envoyé en dehors de l'app (Mobile Money, etc.).
// Dépend de : utils.js, sheet.js, data.js (refreshDashboard).

const PAYMENT_STATUS = {
  PENDING: ['À payer', 'bg-amber-100 text-amber-700'],
  PAID:    ['Payé',    'bg-emerald-100 text-emerald-700'],
  FAILED:  ['Échec',   'bg-red-100 text-red-600']
};

const sumPayments = (rows, status) =>
  (rows || []).filter(p => p.status === status).reduce((t, p) => t + (p.amount || 0), 0);

async function openWallet(userId, name) {
  const body = openSheet('Portefeuille', name);
  body.appendChild(el('p', 'text-sm text-zinc-400', 'Chargement…'));

  try {
    const { data, error } = await window.sb
      .from('Payment')
      .select('id, amount, status, createdAt, paidAt, MissionWorker(Mission(title, number))')
      .eq('userId', userId)
      .order('createdAt', { ascending: false })
      .limit(200);
    if (error) throw error;
    renderWallet(body, userId, name, data || []);
  } catch (e) {
    console.error('Portefeuille :', e);
    body.replaceChildren(el('p', 'text-sm text-red-600', 'Impossible de charger : ' + ((e && e.message) || e)));
  }
}

function renderWallet(body, userId, name, rows) {
  body.replaceChildren();

  const due = sumPayments(rows, 'PENDING');
  const paid = sumPayments(rows, 'PAID');

  const grid = el('div', 'grid grid-cols-3 gap-2');
  [['À payer', usd(due), due > 0 ? 'text-amber-600' : ''], ['Déjà payé', usd(paid), ''], ['Total gagné', usd(due + paid), '']]
    .forEach(([label, value, cls]) => {
      const box = el('div', 'bg-zinc-50 border border-zinc-200 rounded-xl py-3 text-center');
      box.appendChild(el('div', 'text-lg font-bold ' + cls, value));
      box.appendChild(el('div', 'text-[10px] text-zinc-500 font-medium', label));
      grid.appendChild(box);
    });
  body.appendChild(grid);

  const pending = rows.filter(p => p.status === 'PENDING');
  if (pending.length) {
    const btn = el('button', 'w-full bg-black text-white rounded-full py-3 text-sm font-semibold active:scale-95 transition', 'Marquer ' + usd(due) + ' comme payé');
    btn.type = 'button';
    btn.addEventListener('click', () => settleWallet(userId, name, pending, btn));
    body.appendChild(btn);
    body.appendChild(el('p', 'text-[11px] text-zinc-400', "Fais d'abord le virement (Mobile Money, etc.) : ce bouton enregistre seulement qu'il est fait."));
  }

  const list = el('div', 'space-y-2');
  rows.forEach(p => {
    const mission = p.MissionWorker && p.MissionWorker.Mission;
    const line = el('div', 'flex items-center gap-3 bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2.5');
    const info = el('div', 'flex-1 min-w-0');
    info.appendChild(el('div', 'text-sm font-semibold truncate', mission ? num5(mission.number) + ' · ' + mission.title : 'Ajustement'));
    info.appendChild(el('div', 'text-[11px] text-zinc-500', longDate(p.paidAt || p.createdAt)));
    line.appendChild(info);
    line.appendChild(el('div', 'text-sm font-bold shrink-0', usd(p.amount)));
    line.appendChild(badge(PAYMENT_STATUS, p.status));
    list.appendChild(line);
  });
  body.appendChild(sheetSection('Historique', rows.length ? list : el('p', 'text-sm text-zinc-400', 'Aucun gain pour le moment.')));
}

async function settleWallet(userId, name, pending, btn) {
  const expected = pending.reduce((t, p) => t + (p.amount || 0), 0);
  if (!confirm('Marquer ' + usd(expected) + ' comme payé à ' + name + ' ?')) return;

  btn.disabled = true;
  try {
    // On ne touche qu'aux paiements affichés (par id) : un gain arrivé entre-temps reste « à payer »
    const { data, error } = await window.sb
      .from('Payment')
      .update({ status: 'PAID', paidAt: new Date().toISOString() })
      .in('id', pending.map(p => p.id))
      .eq('status', 'PENDING')
      .select('id, amount');
    if (error) throw error;

    const done = (data || []).reduce((t, p) => t + (p.amount || 0), 0);
    if (!data || !data.length) throw new Error('aucune ligne modifiée (déjà réglé, ou droits admin ?)');
    toast('Réglé : ' + usd(done) + ' pour ' + name);
    await refreshDashboard();
    await openWallet(userId, name);
  } catch (e) {
    console.error('Règlement :', e);
    toast('Échec : ' + ((e && e.message) || e));
    btn.disabled = false;
  }
}
