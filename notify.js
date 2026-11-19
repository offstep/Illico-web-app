
// ---------- Notifications : cloche, pastille et alertes ----------
// updateBell(n)          : met à jour la pastille (et celle de l'icône de l'app)
// notifyNew(liste)       : alerte quand de nouvelles livraisons arrivent à vérifier
// enableNotifications()  : demande l'autorisation (doit venir d'un clic)
//
// Limite : les alertes arrivent tant que l'app est ouverte ou en arrière-plan.
// Une notification quand l'app est fermée demande un serveur « Web Push » (pas en place).

const bellBtn = document.getElementById('bell-btn');
const bellBadge = document.getElementById('bell-badge');
const notifRow = document.getElementById('notif-row');
const notifState = document.getElementById('notif-state');

function updateBell(count) {
  if (bellBadge) {
    bellBadge.textContent = count > 99 ? '99+' : String(count);
    bellBadge.classList.toggle('hidden', count === 0);
  }
  try {
    if (navigator.setAppBadge) {
      const p = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
      if (p && p.catch) p.catch(() => {});
    }
  } catch (e) { /* non supporté */ }
}

function refreshNotifState() {
  if (!notifState) return;
  if (!('Notification' in window)) {
    notifState.textContent = 'Non disponible';
    return;
  }
  notifState.textContent = { granted: 'Activées', denied: 'Bloquées', default: 'Désactivées' }[Notification.permission];
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    toast("Notifications indisponibles ici. Sur iPhone, installe d'abord l'app sur l'écran d'accueil.");
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Notifications bloquées : autorise-les dans les réglages du navigateur.');
    return;
  }
  if (Notification.permission === 'default') await Notification.requestPermission();
  refreshNotifState();
  if (Notification.permission === 'granted') toast('Notifications activées.');
}

async function systemNotify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.showNotification) {
      await reg.showNotification(title, { body, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'illico-delivery' });
    } else {
      new Notification(title, { body, icon: 'icon-192.png' });
    }
  } catch (e) {
    console.warn('Notification impossible :', e);
  }
}

// list = [{ number, worker, mission }]
function notifyNew(list) {
  if (!list.length) return;
  let title, text;
  if (list.length === 1) {
    const n = list[0];
    title = 'Nouvelle livraison à vérifier';
    text = num5(n.number) + ' · ' + n.worker + (n.mission ? ' · ' + n.mission : '');
  } else {
    title = list.length + ' nouvelles livraisons à vérifier';
    text = list.map(n => num5(n.number)).join(', ');
  }
  toast(title + ' — ' + text);
  systemNotify(title, text);
}

// La cloche ouvre l'écran QA (et propose d'activer les alertes la première fois)
if (bellBtn) {
  bellBtn.addEventListener('click', () => {
    showView('qa');
    if ('Notification' in window && Notification.permission === 'default') enableNotifications();
  });
}
if (notifRow) notifRow.addEventListener('click', enableNotifications);
refreshNotifState();
