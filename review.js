
// ---------- Évaluer une livraison depuis le site ----------
// Le site n'écrit PAS la décision lui-même : il dépose une commande dans « WebCommand »
// et le bot l'exécute avec la même fonction que sur Discord (message dans le ticket,
// carte QA fermée, passage en « Worker vérifié », crédit du portefeuille).
// Dépend de : utils.js, sheet.js, data.js (refreshDashboard).

const PASS_SCORE = 80;            // même seuil que le bot (delivery.service.ts)
const REVIEW_WAIT_MS = 40000;     // attente maximale de la réponse du bot
const REVIEW_POLL_MS = 2000;
const REVIEW_FIELDS = [
  ['accuracy', 'Exactitude'],
  ['completeness', 'Complétude'],
  ['instructions', 'Consignes'],
  ['format', 'Format']
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Attend que le bot ait traité la commande -> { state: 'done' | 'failed' | 'timeout', result }
async function waitForCommand(id) {
  const deadline = Date.now() + REVIEW_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REVIEW_POLL_MS);
    const { data, error } = await window.sb.from('WebCommand').select('status, result').eq('id', id).single();
    if (error) throw error;
    if (data && data.status === 'DONE') return { state: 'done', result: data.result };
    if (data && data.status === 'FAILED') return { state: 'failed', result: data.result };
  }
  return { state: 'timeout' };
}

function buildReviewForm(deliveryId) {
  const form = el('form', 'space-y-3');
  form.noValidate = true;
  form.addEventListener('submit', e => e.preventDefault());

  const inputs = {};
  const grid = el('div', 'grid grid-cols-2 gap-3');
  REVIEW_FIELDS.forEach(([key, label]) => {
    const wrap = el('label', 'block');
    wrap.appendChild(el('span', 'field-label', label + ' (0-100)'));
    const input = el('input', 'field');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.addEventListener('input', showPreview);
    inputs[key] = input;
    wrap.appendChild(input);
    grid.appendChild(wrap);
  });
  form.appendChild(grid);

  const comment = el('textarea', 'field');
  comment.rows = 3;
  comment.maxLength = 1000;
  comment.placeholder = 'Commentaire ou motif (optionnel)';
  form.appendChild(comment);

  const preview = el('p', 'text-xs text-zinc-500');
  const status = el('p', 'hidden text-xs rounded-xl px-3 py-2');
  const send = el('button', 'w-full bg-black text-white rounded-full py-3 text-sm font-semibold active:scale-95 transition', "Envoyer l'évaluation");
  send.type = 'button';
  form.appendChild(preview);
  form.appendChild(status);
  form.appendChild(send);

  function readScores() {
    const scores = {};
    for (const [key, label] of REVIEW_FIELDS) {
      const raw = inputs[key].value.trim();
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < 0 || n > 100) return { error: label + ' : entier entre 0 et 100.' };
      scores[key] = n;
    }
    const score = Math.floor((scores.accuracy + scores.completeness + scores.instructions + scores.format) / 4);
    return { scores, score };
  }

  function showPreview() {
    const r = readScores();
    preview.textContent = r.error ? '' : 'Score : ' + r.score + ' % → ' + (r.score >= PASS_SCORE ? 'validée' : 'correction demandée') + ' (seuil ' + PASS_SCORE + ' %)';
  }

  function say(msg, kind) {
    status.textContent = msg;
    status.className = 'text-xs rounded-xl px-3 py-2 ' +
      (kind === 'error' ? 'text-red-600 bg-red-50 border border-red-200' : 'text-zinc-600 bg-zinc-50 border border-zinc-200');
  }

  send.addEventListener('click', async () => {
    const r = readScores();
    if (r.error) return say(r.error, 'error');
    const verdict = r.score >= PASS_SCORE ? 'validée' : 'renvoyée en correction';
    if (!confirm('Envoyer l\'évaluation ? Score ' + r.score + ' % : livraison ' + verdict + '.')) return;

    send.disabled = true;
    say('Envoi au bot…');
    try {
      const { data: { session } } = await window.sb.auth.getSession();
      const cmd = {
        id: crypto.randomUUID(),
        kind: 'REVIEW',
        status: 'PENDING',
        requestedBy: session ? session.user.email : null,
        payload: { deliveryId, ...r.scores, comment: comment.value.trim() || null }
      };
      const { error } = await window.sb.from('WebCommand').insert(cmd);
      if (error) throw error;

      say('En attente du bot…');
      const out = await waitForCommand(cmd.id);

      if (out.state === 'done') {
        toast(out.result || 'Évaluation appliquée.');
        closeSheet();
        await refreshDashboard();
      } else if (out.state === 'failed') {
        say('Refusé par le bot : ' + (out.result || 'raison inconnue'), 'error');
        send.disabled = false;
      } else {
        say("Le bot n'a pas répondu (il est peut-être arrêté). L'évaluation sera appliquée à son retour : ne la renvoie pas.", 'error');
      }
    } catch (e) {
      console.error('Évaluation :', e);
      const msg = (e && e.message) || String(e);
      say(/WebCommand/.test(msg) ? 'Table WebCommand absente : lance wallet-validation.sql dans Supabase.' : 'Échec : ' + msg, 'error');
      send.disabled = false;
    }
  });

  return form;
}
