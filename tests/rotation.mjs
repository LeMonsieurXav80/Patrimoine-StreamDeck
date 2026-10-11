// Rotation des refresh tokens, persistance et expiration de session.
import { appendFileSync } from 'node:fs';

const P = new URL('../com.lemonsieurxav.patrimoine.sdPlugin/', import.meta.url).pathname;
const RES = process.env.SORTIE_TEST ?? '/tmp/patrimoine-test.txt';
const log = (...a) => appendFileSync(RES, a.join(' ') + '\n');
const verif = (nom, ok, detail = '') => log(`${ok ? 'ok ' : 'KO '} ${nom}${detail ? ' · ' + detail : ''}`);

process.on('uncaughtException', (e) => log('EXCEPTION', e.stack));
process.on('unhandledRejection', (e) => log('REJET', String((e && e.stack) || e)));

const streamDeck = (await import(`${P}node_modules/@elgato/streamdeck/dist/plugin/index.js`)).default;
const { jetonAcces, estConnecte, invaliderAcces, BesoinConnexion } = await import(`${P}auth.js`);

let stock = { clientId: 'cli_TEST', refreshToken: 'ref_1' };
let ecritureCasse = false;
let ecritures = 0;
streamDeck.settings.getGlobalSettings = async () => stock;
streamDeck.settings.setGlobalSettings = async (s) => {
  ecritures++;
  if (ecritureCasse) throw new Error('disque en lecture seule');
  stock = s;
};

let appels = 0;
let reponse = () => ({ access_token: 'acc_1', refresh_token: 'ref_2', expires_in: 3600 });
globalThis.fetch = async (url, opts) => {
  appels++;
  const corps = Object.fromEntries(new URLSearchParams(opts.body));
  globalThis.dernierRefreshEnvoye = corps.refresh_token;
  return { ok: true, status: 200, json: async () => reponse() };
};

// --- 1. Premier echange : rotation persistee.
const j1 = await jetonAcces();
verif('jeton d\'acces obtenu', j1 === 'acc_1');
verif('le refresh tourne est persiste', stock.refreshToken === 'ref_2', stock.refreshToken);

// --- 2. Deuxieme appel : servi par le cache, aucun echange.
const avant = appels;
const j2 = await jetonAcces();
verif('jeton en cache reutilise (pas de nouvel echange)', j2 === 'acc_1' && appels === avant);

// --- 3. Appels concurrents : un SEUL echange.
// Sans ce verrou, trois touches qui se reveillent ensemble declencheraient
// trois rotations, et deux se feraient refuser par Clerk.
invaliderAcces();
reponse = () => ({ access_token: 'acc_2', refresh_token: 'ref_3', expires_in: 3600 });
const avant2 = appels;
const [a, b, c] = await Promise.all([jetonAcces(), jetonAcces(), jetonAcces()]);
verif('3 appels simultanes = 1 seul echange', appels - avant2 === 1, `${appels - avant2} appel(s)`);
verif('les trois recoivent le meme jeton', a === b && b === c && a === 'acc_2');

// --- 4. Echec d'ecriture : NE DOIT PAS JETER, et doit continuer a marcher.
// C'est la lecon du 10 octobre : a ce stade Clerk a deja tourne le jeton,
// refuser ne restaure rien et jetterait le jeton neuf.
invaliderAcces();
ecritureCasse = true;
reponse = () => ({ access_token: 'acc_3', refresh_token: 'ref_4', expires_in: 3600 });
let jeta = false;
let j4 = null;
try {
  j4 = await jetonAcces();
} catch {
  jeta = true;
}
verif('ecriture impossible : ne jette pas', !jeta);
verif('ecriture impossible : le jeton neuf est quand meme servi', j4 === 'acc_3');
ecritureCasse = false;

// Le jeton neuf doit etre garde EN MEMOIRE : le cycle suivant doit l'utiliser,
// et surtout pas retomber sur l'ancien (qui est mort chez Clerk).
invaliderAcces();
reponse = () => ({ access_token: 'acc_4', refresh_token: 'ref_5', expires_in: 3600 });
await jetonAcces();
verif(
  'apres echec d\'ecriture, c\'est le jeton neuf qui resert',
  globalThis.dernierRefreshEnvoye === 'ref_4',
  `envoye : ${globalThis.dernierRefreshEnvoye}`,
);

// --- 5. invalid_grant : session morte -> BesoinConnexion + deconnexion.
invaliderAcces();
reponse = () => ({ error: 'invalid_grant' });
let typeErreur = null;
try {
  await jetonAcces();
} catch (e) {
  typeErreur = e;
}
verif('session expiree : BesoinConnexion levee', typeErreur instanceof BesoinConnexion, typeErreur?.message);
verif('session expiree : etat passe a deconnecte', estConnecte() === false);
verif('session expiree : le refresh mort est efface du stockage', !stock.refreshToken);

log('--- fin');
