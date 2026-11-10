// Lecture du géoréférencement ISO 32000 (page /VP → /Measure /GEO) et
// conversion lat/long → position sur la page rendue.
const { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFString, PDFHexString } = window.PDFLib;

const nom = (s) => PDFName.of(s);

function nombres(tableau) {
  const r = [];
  for (let i = 0; i < tableau.size(); i++) r.push(tableau.lookup(i, PDFNumber).asNumber());
  return r;
}

function texte(o) {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : null;
}

// Retourne { vues: [{ nom, bbox, gpts, lpts, wkt, epsg }] } ou null si le PDF n'est pas géoréférencé.
export async function lireGeoref(octets) {
  const doc = await PDFDocument.load(octets, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  const page = doc.getPage(0);
  const vp = page.node.lookup(nom('VP'));
  if (!(vp instanceof PDFArray)) return null;

  const vues = [];
  for (let i = 0; i < vp.size(); i++) {
    const d = vp.lookup(i);
    if (!(d instanceof PDFDict)) continue;
    const m = d.lookup(nom('Measure'));
    if (!(m instanceof PDFDict)) continue;
    const sous = m.lookup(nom('Subtype'));
    if (!sous || sous.toString() !== '/GEO') continue;

    const bbox = d.lookup(nom('BBox'));
    const gpts = m.lookup(nom('GPTS'));
    if (!(bbox instanceof PDFArray) || !(gpts instanceof PDFArray)) continue;

    const lpts = m.lookup(nom('LPTS'));
    const bounds = m.lookup(nom('Bounds'));
    let wkt = null;
    let epsg = null;
    const gcs = m.lookup(nom('GCS'));
    if (gcs instanceof PDFDict) {
      wkt = texte(gcs.lookup(nom('WKT')));
      const e = gcs.lookup(nom('EPSG'));
      if (e instanceof PDFNumber) epsg = e.asNumber();
    }
    vues.push({
      nom: texte(d.lookup(nom('Name'))) || '',
      bbox: nombres(bbox),
      gpts: nombres(gpts),
      lpts:
        lpts instanceof PDFArray ? nombres(lpts)
        : bounds instanceof PDFArray ? nombres(bounds)
        : [0, 0, 0, 1, 1, 1, 1, 0],
      wkt,
      epsg,
    });
  }
  return vues.length ? { vues } : null;
}

// Ajustement affine par moindres carrés : (X, Y) → (u, v).
function ajusterAffine(src, dst) {
  const n = src.length;
  if (n < 3) return null;
  const mx = src.reduce((s, p) => s + p[0], 0) / n;
  const my = src.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0;
  for (const [X, Y] of src) {
    const x = X - mx, y = Y - my;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const det3 = (A) =>
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const D = det3(M);
  if (Math.abs(D) < 1e-12) return null;
  const resoudre = (k) => {
    let bx = 0, by = 0, b1 = 0;
    src.forEach(([X, Y], i) => {
      const x = X - mx, y = Y - my, t = dst[i][k];
      bx += x * t; by += y * t; b1 += t;
    });
    const b = [bx, by, b1];
    return [0, 1, 2].map((c) => det3(M.map((ligne, r) => ligne.map((val, j) => (j === c ? b[r] : val)))) / D);
  };
  const cu = resoudre(0), cv = resoudre(1);
  return (X, Y) => {
    const x = X - mx, y = Y - my;
    return [cu[0] * x + cu[1] * y + cu[2], cv[0] * x + cv[1] * y + cv[2]];
  };
}

function preparerVue(v, versEcran) {
  const n = Math.floor(Math.min(v.gpts.length, v.lpts.length) / 2);
  if (n < 3) return null;

  let proj = null;
  if (v.wkt && /^\s*PROJCS/i.test(v.wkt)) {
    try { proj = window.proj4(v.wkt); } catch (e) { console.warn('Projection non lue, approximation locale', e); }
  }
  let lat0 = 0;
  for (let i = 0; i < n; i++) lat0 += v.gpts[2 * i] / n;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const projeter = proj
    ? (lat, lon) => proj.forward([lon, lat])
    : (lat, lon) => [lon * kx, lat * 110574];

  const src = [], dst = [];
  for (let i = 0; i < n; i++) {
    src.push(projeter(v.gpts[2 * i], v.gpts[2 * i + 1]));
    dst.push([v.lpts[2 * i], v.lpts[2 * i + 1]]);
  }
  const affine = ajusterAffine(src, dst);
  if (!affine) return null;

  const [a, b, c, d] = v.bbox;
  const x0 = Math.min(a, c), x1 = Math.max(a, c), y0 = Math.min(b, d), y1 = Math.max(b, d);

  let residu = 0;
  src.forEach(([X, Y], i) => {
    const [u, w] = affine(X, Y);
    residu = Math.max(residu, Math.hypot((u - dst[i][0]) * (x1 - x0), (w - dst[i][1]) * (y1 - y0)));
  });

  return {
    nom: v.nom,
    projection: proj ? 'exacte' : 'approximation locale',
    residuPts: residu,
    aire: (x1 - x0) * (y1 - y0),
    // lat/long → { u, v } (0–1 dans le cadre) et point écran [px, py]
    situer(lat, lon) {
      const [u, w] = affine(...projeter(lat, lon));
      return { u, v: w, ecran: versEcran(x0 + u * (x1 - x0), y0 + w * (y1 - y0)) };
    },
    ecranDeUV(u, w) {
      return versEcran(x0 + u * (x1 - x0), y0 + w * (y1 - y0));
    },
  };
}

// versEcran(xPage, yPage) → [px, py] dans l'image rendue.
export function creerTransformation(georef, versEcran) {
  const vues = georef.vues.map((v) => preparerVue(v, versEcran)).filter(Boolean).sort((p, q) => q.aire - p.aire);
  if (!vues.length) return null;

  return {
    vues,
    localiser(lat, lon) {
      let vue = vues[0], s = vue.situer(lat, lon), dedans = false;
      for (const candidate of vues) {
        const t = candidate.situer(lat, lon);
        if (t.u >= 0 && t.u <= 1 && t.v >= 0 && t.v <= 1) { vue = candidate; s = t; dedans = true; break; }
      }
      // Échelle et direction du nord, à partir de points décalés de 10 m.
      const dLat = 10 / 110574, dLon = 10 / (111320 * Math.cos((lat * Math.PI) / 180));
      const [px, py] = s.ecran;
      const [nx, ny] = vue.situer(lat + dLat, lon).ecran;
      const [ex, ey] = vue.situer(lat, lon + dLon).ecran;
      const pxParMetre = (Math.hypot(nx - px, ny - py) + Math.hypot(ex - px, ey - py)) / 20;
      const angleNord = (Math.atan2(nx - px, -(ny - py)) * 180) / Math.PI;

      let distanceHors = 0;
      if (!dedans) {
        const [cx, cy] = vue.ecranDeUV(Math.min(1, Math.max(0, s.u)), Math.min(1, Math.max(0, s.v)));
        distanceHors = Math.hypot(cx - px, cy - py) / pxParMetre;
      }
      return { px, py, dedans, distanceHors, pxParMetre, angleNord };
    },
  };
}
