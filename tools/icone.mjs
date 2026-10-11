// Generateur de l'icone PNG du plugin.
//
// POURQUOI CE FICHIER EXISTE. Le Marketplace impose que `Manifest.Icon` soit du
// PNG en 256 x 256 ET 512 x 512 (@2x) — c'est le seul endroit du manifeste ou le
// SVG est refuse (les icones d'action et les images d'etat, elles, acceptent le
// SVG, et on les laisse en SVG). Comme ce Mac n'a aucun convertisseur
// (rsvg-convert, ImageMagick, Inkscape : tous absents) et que le depot interdit
// les dependances npm, on peint directement les pixels.
//
// Repris du cockpit, dont il ne change que le dessin : trois barres
// ascendantes en ocre, la couleur d'identite des touches d'argent du plugin.
// Un patrimoine qui monte, lisible a 20 px dans une liste de Marketplace.
//
// Le dessin n'utilise QUE des rectangles a coins arrondis, et ce n'est pas une
// coquetterie : le peintre ne sait tester que l'appartenance a un rectangle.
// Un glyphe « euro » demanderait des courbes, donc un vrai moteur de rendu.
//
// Usage : node tools/icone.mjs
// A relancer seulement si le dessin change — les PNG produits sont versionnes.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SORTIE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'com.lemonsieurxav.patrimoine.sdPlugin',
  'images',
);

// Geometrie exprimee dans le repere 144 x 144, comme les SVG du plugin, puis
// mise a l'echelle. Garder ce repere permet de comparer les fichiers a l'oeil.
const BASE = 144;
const FOND = { x: 0, y: 0, w: 144, h: 144, r: 12, c: '#1a1d22' };
// Trois barres qui montent, du sourd au vif : la plus haute est la plus
// saturee, donc c'est elle que l'oeil suit.
const TOUCHES = [
  { x: 26, y: 86, w: 24, h: 34, r: 4, c: '#6b4e24' },
  { x: 60, y: 62, w: 24, h: 58, r: 4, c: '#a9792f' },
  { x: 94, y: 34, w: 24, h: 86, r: 4, c: '#e0a93f' },
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * Un point est-il dans un rectangle a coins arrondis ?
 *
 * Hors des quatre disques d'angle, le test se ramene a un rectangle simple ;
 * dans un angle, on compare la distance au centre du disque.
 */
function dansRect({ x, y, w, h, r }, px, py) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const dx = px < x + r ? x + r - px : px > x + w - r ? px - (x + w - r) : 0;
  const dy = py < y + r ? y + r - py : py > y + h - r ? py - (y + h - r) : 0;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Peint l'icone a la taille demandee.
 *
 * Suréchantillonnage 4 x 4 par pixel : sans lui les coins arrondis sortent en
 * marches d'escalier, ce qui se voit immediatement a 256 px dans les
 * preferences de Stream Deck. Moyenner 16 echantillons suffit, et le cout est
 * sans importance pour un script lance a la main.
 */
function peindre(taille) {
  const echelle = taille / BASE;
  const SS = 4;
  const fondRGB = rgb(FOND.c);
  const touches = TOUCHES.map((t) => ({ ...t, rgb: rgb(t.c) }));

  // Une ligne PNG = 1 octet de filtre + largeur x 4 octets (RGBA).
  const brut = Buffer.alloc(taille * (1 + taille * 4));

  for (let py = 0; py < taille; py++) {
    const debut = py * (1 + taille * 4);
    brut[debut] = 0; // filtre « None »
    for (let px = 0; px < taille; px++) {
      let r = 0, v = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Centre du sous-echantillon, ramene au repere 144 x 144.
          const ux = (px + (sx + 0.5) / SS) / echelle;
          const uy = (py + (sy + 0.5) / SS) / echelle;
          if (!dansRect(FOND, ux, uy)) continue;
          // Dernier rectangle gagnant : les touches sont posees sur le fond.
          const touche = touches.find((t) => dansRect(t, ux, uy));
          const [cr, cv, cb] = touche ? touche.rgb : fondRGB;
          r += cr; v += cv; b += cb; a += 255;
        }
      }
      const n = SS * SS;
      const o = debut + 1 + px * 4;
      // Couleur moyennee sur les seuls echantillons couverts, sinon les bords
      // tireraient vers le noir au lieu de devenir transparents.
      const couverts = a / 255 || 1;
      brut[o] = Math.round(r / couverts);
      brut[o + 1] = Math.round(v / couverts);
      brut[o + 2] = Math.round(b / couverts);
      brut[o + 3] = Math.round(a / n);
    }
  }

  return assemblerPng(taille, brut);
}

/** Table CRC-32 du PNG, calculee une fois. */
const TABLE_CRC = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const octet of buf) c = TABLE_CRC[(c ^ octet) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function bloc(type, donnees) {
  const corps = Buffer.concat([Buffer.from(type, 'ascii'), donnees]);
  const taille = Buffer.alloc(4);
  taille.writeUInt32BE(donnees.length);
  const somme = Buffer.alloc(4);
  somme.writeUInt32BE(crc32(corps));
  return Buffer.concat([taille, corps, somme]);
}

function assemblerPng(taille, brut) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(taille, 0);
  ihdr.writeUInt32BE(taille, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc('IHDR', ihdr),
    bloc('IDAT', deflateSync(brut, { level: 9 })),
    bloc('IEND', Buffer.alloc(0)),
  ]);
}

for (const [nom, taille] of [['plugin.png', 256], ['plugin@2x.png', 512]]) {
  const png = peindre(taille);
  writeFileSync(join(SORTIE, nom), png);
  console.log(`${nom} — ${taille}x${taille}, ${(png.length / 1024).toFixed(1)} ko`);
}
