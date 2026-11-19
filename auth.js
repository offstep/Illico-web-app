
// Se connecter avec Google
async function loginWithGoogle() {
  const { error } = await window.sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      // URL propre, sans ancien #hash ni ?paramètres
      redirectTo: window.location.origin + window.location.pathname
    }
  });
  if (error) alert("Erreur de connexion : " + error.message);
}

// Se déconnecter
async function logout() {
  await window.sb.auth.signOut();
  window.location.reload();
}

// Lit une éventuelle erreur renvoyée par Supabase/Google dans l'URL
function getUrlError() {
  const params = new URLSearchParams(
    window.location.hash.replace(/^#/, '') + '&' + window.location.search.replace(/^\?/, '')
  );
  return params.get('error_description') || params.get('error');
}

// Affiche le bon écran selon la session
function render(session) {
  const loginScreen = document.getElementById('login-screen');
  const loginBtn = document.getElementById('login-btn');
  const userInfo = document.getElementById('user-info');
  const mainContent = document.getElementById('main-content');

  if (session) {
    if (loginScreen) loginScreen.style.display = 'none';
    if (userInfo) {
      userInfo.style.display = 'block';
      userInfo.innerHTML = `<p class="text-xs text-zinc-400"></p>
                            <button onclick="logout()" class="text-red-400 text-xs mt-1">Déconnexion</button>`;
      userInfo.querySelector('p').textContent = "Connecté : " + session.user.email;
    }
    if (mainContent) mainContent.style.display = 'block';
    const accountEmail = document.getElementById('account-email');
    if (accountEmail) accountEmail.textContent = session.user.email;
    const warn = msg => {
      const n = document.getElementById('notice');
      if (n) { n.textContent = msg; n.classList.remove('hidden'); }
    };
    if (typeof loadDashboardData === 'function') {
      Promise.resolve(loadDashboardData()).catch(err => warn('Chargement impossible : ' + ((err && err.message) || err)));
    } else {
      warn("Le fichier data.js n'est pas chargé : vérifie qu'il est à la racine du site.");
    }
  } else {
    if (loginScreen) loginScreen.style.display = 'flex';
    if (loginBtn) loginBtn.classList.remove('invisible');
    if (userInfo) userInfo.style.display = 'none';
    if (mainContent) mainContent.style.display = 'none';
  }
}

window.addEventListener('load', async () => {
  // Si Google/Supabase a renvoyé une erreur, on l'affiche au lieu de rester muet
  const urlError = getUrlError();
  if (urlError) {
    const p = document.createElement('p');
    p.className = 'text-red-400 text-sm mb-4 max-w-xs';
    p.textContent = "Erreur : " + decodeURIComponent(urlError.replace(/\+/g, ' '));
    document.getElementById('login-btn').before(p);
    console.error("Erreur d'authentification :", urlError);
  }

  // Réagit à la connexion, même si elle se termine après le chargement de la page
  window.sb.auth.onAuthStateChange((event, session) => {
    console.log("Auth :", event, session ? session.user.email : "pas de session");
    render(session);
    // Nettoie l'URL (retire #access_token=… ou ?code=…) une fois connecté
    if (session && (window.location.hash || window.location.search)) {
      history.replaceState(null, '', window.location.pathname);
    }
  });

  const { data: { session } } = await window.sb.auth.getSession();
  render(session);
});
