# Cartes terrain – Corridor appalachien

Application web pour **naviguer sur une propriété** avec une carte PDF géoréférencée
(export ArcGIS Pro) : la position GPS du téléphone s’affiche sur le PDF, hors ligne.

- Les cartes sont ajoutées à partir des fichiers du téléphone et **restent dans le téléphone**.
  Rien n’est envoyé, rien n’est enregistré (pas de points, pas de traces).
- Cible : Chrome sur Android.

## Mise en ligne sur GitHub Pages

1. Créer un dépôt (public), par exemple `carte-terrain`.
2. Y verser le contenu de ce dossier **sauf le dossier `essais/`** et tout fichier PDF
   (sur le site GitHub : *Add file → Upload files*, glisser les fichiers et les dossiers `lib` et `icones`).
3. *Settings → Pages* : Source = *Deploy from a branch*, branche `main`, dossier `/ (root)`.
4. Après une minute, l’adresse est `https://<compte>.github.io/carte-terrain/`.

## Installation sur le téléphone

1. Ouvrir l’adresse dans **Chrome**, menu ⋮ → *Ajouter à l’écran d’accueil* (ou *Installer l’application*).
2. Ouvrir l’application une fois avec du réseau : elle est ensuite gardée pour le hors-ligne.
3. *Ajouter une carte PDF* → choisir le PDF (Téléchargements, Drive, etc.).
4. À la première ouverture d’une carte, autoriser la localisation.

## Utilisation

- Point bleu = position; cercle = précision GPS; cône = direction où pointe le téléphone.
- Glisser la carte arrête le suivi; le bouton ◎ recentre.
- Hors du cadre de la carte, la distance jusqu’au cadre est affichée.
- L’écran reste allumé tant qu’une carte est ouverte.
- *Réglages* : déclinaison magnétique pour la boussole (défaut −14,5°, sud du Québec).

## Mettre à jour l’application

Remplacer les fichiers dans le dépôt. Les téléphones prennent la nouvelle version
la prochaine fois que l’application est ouverte avec du réseau.

## Essai sur le poste

```
python essais/serveur.py 8765
```
Puis `http://localhost:8765/?pdf=essais/carte.pdf&sim=45.2325,-72.2635`
(`pdf` : un PDF copié dans `essais/`; `sim` : position simulée lat,long).

## Fonctionnement

- `geo.js` lit le géoréférencement ISO du PDF (page → `/VP` → `/Measure /GEO` : `GPTS`, `LPTS`, WKT)
  avec pdf-lib, projette les coins avec proj4 (ex. MTM 8 NAD83) et ajuste une transformation affine.
- `app.js` dessine la page avec pdf.js, l’affiche dans Leaflet et y place la position GPS.
- `sw.js` garde l’application dans le téléphone (réseau d’abord, copie locale si pas de signal).
- Librairies dans `lib/` : pdf.js 4.10.38, pdf-lib 1.17.1, proj4 2.15.0, Leaflet 1.9.4.
