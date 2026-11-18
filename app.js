
// ⚠️ C'EST ICI QU'ON DÉFINIT LA DEADLINE
// Format : "Année-Mois-JourTHH:MM:SS+01:00" (ex: 31 décembre 2026 à 23h59, heure du Bénin)
const dateDeadline = new Date("2026-12-31T23:59:59+01:00").getTime();

function mettreAJour() {
  const maintenant = new Date().getTime();
  const distance = dateDeadline - maintenant;

  // Si la date est dépassée, on affiche 00 partout et on arrête
  if (distance < 0) {
    clearInterval(timer);
    document.getElementById("days").innerText = "00";
    document.getElementById("hours").innerText = "00";
    document.getElementById("minutes").innerText = "00";
    document.getElementById("seconds").innerText = "00";
    return;
  }

  // Calcul du temps restant
  const jours = Math.floor(distance / (1000 * 60 * 60 * 24));
  const heures = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
  const secondes = Math.floor((distance % (1000 * 60)) / 1000);

  // Affichage (avec un 0 devant si le chiffre est inférieur à 10)
  document.getElementById("days").innerText = jours.toString().padStart(2, '0');
  document.getElementById("hours").innerText = heures.toString().padStart(2, '0');
  document.getElementById("minutes").innerText = minutes.toString().padStart(2, '0');
  document.getElementById("seconds").innerText = secondes.toString().padStart(2, '0');
}

const timer = setInterval(mettreAJour, 1000);
mettreAJour(); // affichage immédiat, sans attendre 1 seconde
