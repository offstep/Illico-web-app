
// Le client Supabase est créé dans window.sb (la librairie reste dans window.supabase)
// La librairie est chargée par index.html avant ce fichier
const SUPABASE_URL = "https://ruxzaifmzqbvsebctpib.supabase.co";
const SUPABASE_KEY = "sb_publishable_sFXuWFVCCHDsItzXSq7Ycg_tLj6ly9W";

window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
console.log("Supabase connecté !");
