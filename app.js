import * as pdfjsLib from './lib/pdf.min.mjs';
import { lireGeoref, creerTransformation } from './geo.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const MAX_PIXELS = 12e6; // taille de l'image rendue (≈ 5× une page lettre)

/* ---------------- Stockage local (IndexedDB) ---------------- */

const bd = new Promise((ok, ko) => {
  const r = indexedDB.open('carte-terrain', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('cartes', { keyPath: 'id' });   // métadonnées
    r.result.createObjectStore('fichiers', { keyPath: 'id' }); // octets du PDF
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => ko(r.error);
});

async function requete(magasins, mode, fn) {
  const db = await bd;
  return new Promise((ok, ko) => {
    const t = db.transaction(magasins, mode);
    const r = fn(t);
    t.oncomplete = () => ok(r && r.result);
    t.onerror = () => ko(t.error);
  });
}
const listerCartes = () => requete(['cartes'], 'readonly', (t) => t.objectStore('cartes').getAll());
const lireFichier = (id) => requete(['fichiers'], 'readonly', (t) => t.objectStore('fichiers').get(id));
const ajouterCarte = (meta, octets) =>
  requete(['cartes', 'fichiers'], 'readwrite', (t) => {
    t.objectStore('fichiers').put({ id: meta.id, octets });
    t.objectStore('cartes').put(meta);
  });
const supprimerCarte = (id) =>
  requete(['cartes', 'fichiers'], 'readwrite', (t) => {
    t.objectStore('cartes').delete(id);
    t.objectStore('fichiers').delete(id);
  });

/* ---------------- Accueil : liste des cartes ---------------- */

function message(txt) {
  $('message').textContent = txt;
  $('message').hidden = !txt;
}

const taille = (o) => (o > 1048576 ? (o / 1048576).toFixed(1) + ' Mo' : Math.round(o / 1024) + ' ko');

async function afficherListe() {
  const cartes = (await listerCartes()).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const ul = $('liste');
  ul.replaceChildren();
  $('vide').hidden = cartes.length > 0;
  for (const c of cartes) {
    const li = document.createElement('li');
    const ouvrir = document.createElement('button');
    ouvrir.className = 'ouvrir';
    ouvrir.innerHTML = '<span class="nom"></span><span class="details"></span>';
    ouvrir.querySelector('.nom').textContent = c.nom;
    ouvrir.querySelector('.details').textContent =
      `${taille(c.taille)} · ajoutée le ${new Date(c.ajout).toLocaleDateString('fr-CA')}`;
    ouvrir.onclick = () => ouvrirCarteEnregistree(c);
    const suppr = document.createElement('button');
    suppr.className = 'supprimer';
    suppr.setAttribute('aria-label', 'Retirer ' + c.nom);
    suppr.textContent = '✕';
    suppr.onclick = async () => {
      if (!confirm(`Retirer « ${c.nom} » de ce téléphone?`)) return;
      await supprimerCarte(c.id);
      afficherListe();
    };
    li.append(ouvrir, suppr);
    ul.append(li);
  }
}

$('fichier').addEventListener('change', async (e) => {
  const fichiers = [...e.target.files];
  e.target.value = '';
  const refuses = [];
  for (const f of fichiers) {
    message(`Lecture de ${f.name}…`);
    try {
      const octets = await f.arrayBuffer();
      const georef = await lireGeoref(octets.slice(0));
      if (!georef) { refuses.push(f.name); continue; }
      await ajouterCarte(
        { id: crypto.randomUUID(), nom: f.name.replace(/\.pdf$/i, ''), ajout: Date.now(), taille: f.size },
        octets,
      );
    } catch (err) {
      console.error(err);
      refuses.push(f.name);
    }
  }
  message(refuses.length ? `Non géoréférencé ou illisible : ${refuses.join(', ')}` : '');
  afficherListe();
});

/* ---------------- Vue carte ---------------- */

let carte = null, urlImage = null, trans = null, idSuivi = null, verrouEcran = null;
let suivre = true, derniere = null, capBoussole = null, capAffiche = null;
let marqueurPos = null, cercle = null, fleche = null;

const declinaison = () => parseFloat(localStorage.getItem('declinaison') ?? '-14.5') || 0;
$('declinaison').value = declinaison();
$('declinaison').addEventListener('change', (e) => localStorage.setItem('declinaison', e.target.value));

async function ouvrirCarteEnregistree(meta) {
  const f = await lireFichier(meta.id);
  history.pushState({ carte: meta.id }, '');
  await ouvrirCarte(f.octets, meta.nom);
}

async function ouvrirCarte(octets, nomCarte) {
  $('accueil').hidden = true;
  $('vue-carte').hidden = false;
  $('titre-carte').textContent = nomCarte;
  $('chargement').hidden = false;
  try {
    const georef = await lireGeoref(octets.slice(0));
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(octets.slice(0)) }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const echelle = Math.min(8, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    const vp = page.getViewport({ scale: echelle });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: 'white' }).promise;
    const W = canvas.width, H = canvas.height;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    canvas.width = canvas.height = 0;
    pdf.destroy();
    urlImage = URL.createObjectURL(blob);

    trans = georef && creerTransformation(georef, (x, y) => vp.convertToViewportPoint(x, y));
    if (trans) console.info('Géoréférencement', JSON.stringify(trans.vues.map((v) => ({ nom: v.nom, projection: v.projection, residuPts: v.residuPts }))));

    const limites = [[-H, 0], [0, W]];
    carte = L.map('carte', {
      crs: L.CRS.Simple, minZoom: -6, maxZoom: 2, zoomSnap: 0.25, zoomDelta: 0.5,
      attributionControl: false, zoomControl: false,
    });
    L.imageOverlay(urlImage, limites).addTo(carte);
    carte.fitBounds(limites);
    carte.setMinZoom(carte.getZoom() - 1);
    carte.setMaxBounds(L.latLngBounds(limites).pad(0.3));
    carte.on('dragstart', () => { suivre = false; $('recentrer').classList.add('actif'); });

    suivre = true;
    $('recentrer').classList.remove('actif');
    if (!trans) etat('Carte sans géoréférencement : position non disponible', 'erreur');
    else demarrerPosition();
    demarrerBoussole();
    garderEcranAllume();
  } catch (err) {
    console.error(err);
    etat('Impossible d’afficher cette carte', 'erreur');
  } finally {
    $('chargement').hidden = true;
  }
}

function fermerCarte() {
  if (idSuivi !== null) navigator.geolocation.clearWatch(idSuivi);
  clearInterval(simulation);
  idSuivi = null;
  window.removeEventListener('deviceorientationabsolute', surOrientation);
  if (verrouEcran) verrouEcran.release().catch(() => {});
  verrouEcran = null;
  if (carte) carte.remove();
  if (urlImage) URL.revokeObjectURL(urlImage);
  carte = urlImage = trans = derniere = marqueurPos = cercle = fleche = null;
  capBoussole = capAffiche = null;
  $('vue-carte').hidden = true;
  $('accueil').hidden = false;
  afficherListe();
}

$('retour').onclick = () => (history.state && history.state.carte ? history.back() : fermerCarte());
window.addEventListener('popstate', () => { if (carte || !$('vue-carte').hidden) fermerCarte(); });

$('recentrer').onclick = () => {
  suivre = true;
  $('recentrer').classList.remove('actif');
  if (derniere) placerPosition(derniere);
};

function etat(txt, classe = '') {
  $('etat').textContent = txt;
  $('etat').className = 'etat ' + classe;
}

/* ---------------- GPS ---------------- */

let simulation = null;

function demarrerPosition() {
  etat('Recherche du signal GPS…');
  const sim = new URLSearchParams(location.search).get('sim'); // essai : ?sim=lat,lon
  if (sim) {
    const [lat, lon] = sim.split(',').map(Number);
    const envoyer = () => placerPosition({ lat, lon, precision: 5, cap: null });
    envoyer();
    simulation = setInterval(envoyer, 2000);
    return;
  }
  if (!('geolocation' in navigator)) return etat('GPS non disponible sur cet appareil', 'erreur');
  idSuivi = navigator.geolocation.watchPosition(
    (p) => placerPosition({
      lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy,
      cap: p.coords.speed > 1 && Number.isFinite(p.coords.heading) ? p.coords.heading : null,
    }),
    (e) => etat(e.code === 1 ? 'Localisation refusée : autorisez-la dans Chrome' : 'Signal GPS indisponible', 'erreur'),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 },
  );
}

function placerPosition(pos) {
  if (!carte || !trans) return;
  derniere = pos;
  const r = trans.localiser(pos.lat, pos.lon);
  derniere.r = r;
  const ll = L.latLng(-r.py, r.px);

  if (!marqueurPos) {
    cercle = L.circle(ll, { radius: 1, className: 'precision', interactive: false }).addTo(carte);
    fleche = L.marker(ll, {
      interactive: false,
      icon: L.divIcon({ className: 'fleche', html: '<div class="cone"><svg viewBox="0 0 80 80"><path d="M40 40 L25 3 A40 40 0 0 1 55 3 Z"/></svg></div>', iconSize: [80, 80] }),
    }).addTo(carte);
    marqueurPos = L.circleMarker(ll, { radius: 8, className: 'position', interactive: false }).addTo(carte);
  }
  cercle.setLatLng(ll).setRadius(pos.precision * r.pxParMetre);
  fleche.setLatLng(ll);
  marqueurPos.setLatLng(ll);
  majFleche();

  const prec = `± ${Math.round(pos.precision)} m`;
  if (r.dedans) etat(prec, pos.precision > 30 ? 'faible' : 'ok');
  else etat(`Hors de la carte, à ${formatDistance(r.distanceHors)} · ${prec}`, 'hors');

  if (suivre && r.dedans) carte.panTo(ll, { animate: true });
}

const formatDistance = (m) => (m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m');

/* ---------------- Boussole ---------------- */

function surOrientation(e) {
  if (e.alpha == null) return;
  const ecran = (screen.orientation && screen.orientation.angle) || 0;
  capBoussole = (360 - e.alpha + ecran + declinaison() + 720) % 360;
  majFleche();
}

function demarrerBoussole() {
  window.addEventListener('deviceorientationabsolute', surOrientation);
}

function majFleche() {
  if (!fleche || !derniere) return;
  const cap = derniere.cap ?? capBoussole;
  const el = fleche.getElement();
  if (!el) return;
  if (cap == null) { el.classList.add('cache'); return; }
  el.classList.remove('cache');
  // lissage avec gestion du passage 359° → 0°
  if (capAffiche == null) capAffiche = cap;
  else capAffiche += ((((cap - capAffiche) % 360) + 540) % 360 - 180) * 0.3;
  el.firstChild.style.transform = `rotate(${capAffiche + derniere.r.angleNord}deg)`;
}

/* ---------------- Écran allumé ---------------- */

async function garderEcranAllume() {
  try {
    if ('wakeLock' in navigator && !document.hidden) verrouEcran = await navigator.wakeLock.request('screen');
  } catch { /* refusé : sans conséquence */ }
}
document.addEventListener('visibilitychange', () => { if (carte && !document.hidden) garderEcranAllume(); });

/* ---------------- Démarrage ---------------- */

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

afficherListe();

// Essai sur poste : ?pdf=chemin/vers/carte.pdf ouvre un PDF servi par le même serveur.
const essai = new URLSearchParams(location.search).get('pdf');
if (essai) {
  fetch(essai).then((r) => r.arrayBuffer()).then((o) => ouvrirCarte(o, essai.split('/').pop().replace(/\.pdf$/i, '')));
}
