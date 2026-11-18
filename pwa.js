
// ---------- PWA : service worker + bouton « Installer » ----------

// Enregistre le service worker (chemin relatif : marche sur GitHub Pages)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker non enregistré :', err));
  });
}

const installBtn = document.getElementById('install-btn');
const installHint = document.getElementById('install-hint');
let deferredPrompt = null;

const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

// Android / Chrome : on garde l'invite pour l'afficher sur notre bouton
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn && !isStandalone) installBtn.classList.remove('hidden');
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.classList.add('hidden');
  });
}

// iPhone : pas d'invite automatique, on explique le geste
if (isIos && !isStandalone && installHint) {
  installHint.classList.remove('hidden');
}

window.addEventListener('appinstalled', () => {
  if (installBtn) installBtn.classList.add('hidden');
  if (installHint) installHint.classList.add('hidden');
});
