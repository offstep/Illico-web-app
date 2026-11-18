
// Fonction pour se connecter
async function loginWithGoogle() {
  const { data, error } = await window.sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      // Il redirigera vers ton site GitHub Pages après connexion
      redirectTo: window.location.href 
    }
  });
  if (error) alert("Erreur de connexion : " + error.message);
}

// Fonction pour se déconnecter
async function logout() {
  await window.sb.auth.signOut();
  window.location.reload();
}

// Vérifier si l'utilisateur est connecté
async function checkUser() {
  const { data: { session } } = await window.sb.auth.getSession();
  
  const loginScreen = document.getElementById('login-screen');
  const userInfo = document.getElementById('user-info');
  const mainContent = document.getElementById('main-content');

  if (session) {
    // Connecté : on enlève l'écran de connexion
    if (loginScreen) loginScreen.style.display = 'none';
    if (userInfo) {
      userInfo.style.display = 'block';
      userInfo.innerHTML = `<p class="text-xs text-zinc-400"></p>
                            <button onclick="logout()" class="text-red-400 text-xs mt-1">Déconnexion</button>`;
      userInfo.querySelector('p').textContent = "Connecté : " + session.user.email;
    }
    if (mainContent) mainContent.style.display = 'block'; // On affiche le site
    
    // On lance le chargement des données
    if (typeof loadDashboardData === 'function') loadDashboardData();
  } else {
    // Pas connecté : on affiche l'écran de connexion
    if (loginScreen) loginScreen.style.display = 'flex';
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) loginBtn.classList.remove('invisible'); // on montre le bouton seulement maintenant
    if (userInfo) userInfo.style.display = 'none';
    if (mainContent) mainContent.style.display = 'none'; // On cache le site
  }
}

// On vérifie l'utilisateur au chargement de la page
window.addEventListener('load', checkUser);
