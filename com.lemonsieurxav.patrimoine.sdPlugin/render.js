// Rendu d'une touche en SVG 144x144.
//
//   +--------------------------+
//   | (ic)   LIBELLE      (o)  |  bandeau : couleur d'IDENTITE, rond de STATUT
//   |        312,5k €          |  la valeur principale
//   +--------------------------+
//   | BRUT          495,7k€    |  petit libelle a gauche, GROSSE valeur a droite
//   | FINAN         130,1k€    |
//   +--------------------------+
//
// Reduit depuis le cockpit : ni sparkline, ni couleurs de marque, ni second
// rond — ce plugin n'affiche que trois mesures d'une seule source. Ce qui est
// garde, c'est ce qui a une raison.
//
// DEUX CODES VISUELS SEPARES. La couleur du bandeau dit DE QUOI on parle, le
// rond dit COMMENT CA VA. Les melanger fait perdre l'identite de la touche des
// qu'elle va mal.
//
// LISIBILITE : une touche MK.2 fait 19 mm. Une phrase comme « solde du mois »
// n'y tient qu'en 11 px, soit ~1,4 mm de hauteur de capitale — illisible a
// 40 cm. D'ou la forme « libelle court + grosse valeur ».

const BANDS = {
  ocre: '#8a6327',
  prune: '#6b4590',
  neutre: '#39404b',
};

// Couleurs de statut : vives, elles n'ont que 7 px de rayon pour s'exprimer.
const DOTS = {
  ok: '#46c07a',
  warn: '#e8b03a',
  crit: '#e8564a',
  new: '#46b8d0',
  down: '#7b8694',
};

const BG = '#14171b';
const INK = '#f0f2f4';
const INK_BAND = '#eaeef2';
const INK_KEY = '#dde3ea';
const FONT = 'Arial, Helvetica, sans-serif';

/** `#abc` ou `#aabbcc` -> `[r, v, b]`, ou `null` si ce n'est pas une couleur. */
function versRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const c = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
  const n = parseInt(c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Encre lisible sur un fond donne : sombre sur clair, claire sur sombre.
 *
 * LE COCKPIT RESOLVAIT CE PROBLEME A L'ENVERS, et il avait ses raisons : il
 * BRIDAIT la clarte des couleurs de marque pour que son texte quasi blanc
 * reste lisible. Ici la couleur est choisie par l'utilisateur, delibérement.
 * La tordre serait lui desobeir — c'est donc le TEXTE qui s'adapte.
 *
 * Luminance relative WCAG, et seuil a 0,5 : au-dessus le fond est clair, on
 * ecrit en sombre. Sans ca, un jaune vif choisi dans le selecteur donne une
 * touche ou l'on ne lit plus rien.
 */
function encreSur(hex) {
  const rgb = versRgb(hex);
  if (!rgb) return { principale: INK_BAND, secondaire: INK_BAND };
  const [r, v, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * v + 0.0722 * b;
  return luminance > 0.5
    ? { principale: '#15181d', secondaire: '#15181d' }
    : { principale: INK_BAND, secondaire: INK_BAND };
}

/**
 * Mini-icones, dessinees sur une grille 24x24 et reduites a 18 px.
 * Tracees au trait : a cette taille une forme pleine devient une tache dont on
 * ne reconnait plus la silhouette.
 */
const ICONS = {
  euro: '<path d="M18 5.5A8.5 8.5 0 108 19.5M3.5 10h9M3.5 14h9" stroke-linecap="round"/>',
  courbe:
    '<path d="M3 17l5-6 4 3 6-8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 21h18"/>',
  cle: '<circle cx="8" cy="12" r="4.5"/><path d="M12.5 12H21M17 12v4M20 12v3" stroke-linecap="round"/>',
};

const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Reduction de police par paliers.
 *
 * Arial gras fait environ 0,58 em par caractere ; on garde une marge, parce
 * qu'un chiffre rogne ou une virgule coupee se lit comme une AUTRE valeur —
 * ce qui est bien pire qu'une police un peu plus petite. Sur un montant, c'est
 * la difference entre 31,2k et 312k.
 */
function fit(text, maxPx, startSize, minSize = 13) {
  let size = startSize;
  const n = [...String(text ?? '')].length;
  while (size > minSize && n * size * 0.58 > maxPx) size -= 1;
  return size;
}

function shortAge(ms) {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}j`;
}

/**
 * @param {object|null} mesure  mesure collectee, ou null
 * @param {object} options
 * @param {'connexion'|'ouverture'|null} [options.auth]  etat d'authentification
 * @param {string|null} [options.couleur]  bandeau choisi par l'utilisateur (hex)
 * @param {number} [options.ageMs]   age de la mesure
 * @param {boolean} [options.stale]  mesure perimee
 * @param {boolean} [options.blinkOff] phase eteinte : le rond s'eteint
 */
export function renderMesure(
  mesure,
  { auth = null, couleur = null, ageMs = 0, stale = false, blinkOff = false } = {},
) {
  // ETAT NON CONNECTE : ce n'est pas une erreur, et ca ne doit pas y
  // ressembler. C'est l'etat normal d'un plugin qu'on vient d'installer, et la
  // touche doit dire QUOI FAIRE — « appuyer » — et non « ERR ».
  //
  // C'est aussi l'etat ou l'on retombe quand la session expire (changement de
  // mot de passe, deconnexion globale chez Finary). Sur une touche de 19 mm
  // sans ecran, un code d'erreur de neuf caracteres n'apprend rien a personne :
  // il faut lire « CONNEXION » et comprendre qu'un appui suffit.
  if (auth === 'connexion') {
    return frame({
      band: BANDS.neutre,
      status: 'new',
      label: 'Finary',
      value: 'CONNEXION',
      rows: [{ k: '', v: 'appuyer' }],
      icon: 'cle',
      blinkOff,
    });
  }
  if (auth === 'ouverture') {
    return frame({
      band: BANDS.neutre,
      status: 'new',
      label: 'Finary',
      value: 'NAVIGA.',
      rows: [{ k: '', v: 'autoriser' }],
      icon: 'cle',
      blinkOff,
    });
  }

  if (!mesure) {
    return frame({
      band: BANDS.neutre,
      status: 'down',
      label: 'Patrimoine',
      value: '…',
      rows: [{ k: '', v: 'lecture' }],
      icon: 'euro',
      blinkOff,
    });
  }

  let status = mesure.status ?? 'ok';
  let rows = (mesure.rows ?? []).slice(0, 2);

  // Une valeur perimee reste affichee, mais le rond passe au gris et la touche
  // dit son age. Garder un rond vert sur un chiffre de trois semaines, c'est
  // affirmer « tout va bien » a partir d'une mesure qu'on n'a plus. Cas reel
  // chez Finary : un consentement bancaire expire fige un solde pendant des
  // semaines sans que rien ne le signale.
  if (stale) {
    status = 'down';
    rows = [{ k: 'FIGE', v: shortAge(ageMs) }];
  }

  return frame({
    // La couleur choisie dans le panneau prime sur celle de la mesure. Les
    // etats d'authentification ci-dessus gardent le gris neutre : ce sont des
    // etats du plugin, pas la donnee que l'utilisateur a mise en couleur.
    band: couleur ?? mesure.band,
    status,
    label: mesure.label,
    value: mesure.value,
    rows,
    icon: mesure.icon,
    blinkOff,
  });
}

function frame({ band, status, label, value, rows, icon, blinkOff }) {
  const hasIcon = Boolean(ICONS[icon]);
  // Le bandeau peut venir de la palette ou d'une couleur choisie dans le
  // selecteur du panneau de reglages. Dans les deux cas l'encre s'y adapte.
  const fond = versRgb(band) ? band : (BANDS[band] ?? BANDS.neutre);
  const encre = encreSur(fond);

  // Largeur disponible mesuree, pas devinee : sans ca « TRÉSORERIE » passe
  // sous le rond de statut.
  const labelSize = fit(String(label).toUpperCase(), hasIcon ? 84 : 104, 15, 9);
  const valueSize = fit(value, 128, 28, 15);

  // Le rond s'eteint sur la phase basse au lieu de disparaitre : un trou dans
  // la touche attire l'oeil differemment d'un point qui bat, et on veut le
  // second.
  const dot = blinkOff ? '#3a4149' : (DOTS[status] ?? DOTS.down);

  // Une seule ligne : on la centre dans le bas plutot que de laisser un vide
  // dessous, qui rend la touche visuellement bancale.
  const ys = rows.length === 1 ? [112] : [103, 134];

  // UNE SEULE TAILLE POUR LES DEUX LIGNES D'UNE TOUCHE. Dimensionner chaque
  // ligne pour elle-meme faisait tomber « 495,7k€ » a 22 px pendant que
  // « 1,2k€ » restait a 27 : un patchwork de tailles sans signification. On
  // prend la plus petite des deux et on l'applique aux deux.
  const tailleLignes = rows.length
    ? Math.min(...rows.map((r) => fit(r.v, r.k ? 80 : 124, 24, 13)))
    : 0;

  const body = rows
    .map((row, i) => {
      const k = row.k
        ? `<text x="11" y="${ys[i]}" font-family="${FONT}" font-size="15" font-weight="bold" fill="${INK_KEY}">${escape(
            String(row.k).toUpperCase().slice(0, 5),
          )}</text>`
        : '';
      // Valeur ancree a droite : les montants changent de largeur, un
      // alignement a gauche ferait danser la colonne d'une touche a l'autre.
      const v = `<text x="133" y="${ys[i]}" text-anchor="end" font-family="${FONT}" font-size="${tailleLignes}" font-weight="bold" fill="${INK}">${escape(
        row.v,
      )}</text>`;
      return k + v;
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="12" fill="${BG}"/>
  <rect width="144" height="72" rx="12" fill="${fond}"/>
  <rect y="58" width="144" height="14" fill="${fond}"/>
  ${hasIcon ? `<g transform="translate(10,11) scale(0.72)" fill="none" stroke="${encre.secondaire}" stroke-width="2.2" opacity="0.85">${ICONS[icon]}</g>` : ''}
  <circle cx="128" cy="20" r="7" fill="${dot}"/>
  <text x="${hasIcon ? 76 : 68}" y="26" text-anchor="middle" font-family="${FONT}" font-size="${labelSize}" font-weight="bold" fill="${encre.secondaire}">${escape(
    String(label).toUpperCase().slice(0, 16),
  )}</text>
  <text x="72" y="59" text-anchor="middle" font-family="${FONT}" font-size="${valueSize}" font-weight="bold" fill="${encre.principale}">${escape(
    value,
  )}</text>
  ${body}
</svg>`;
}

/** Stream Deck attend une image en data URI. */
export const toDataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
