// Test du flux OAuth sans aucun appel reseau reel.
// Le SDK detourne stdout : on journalise dans un fichier.
import { appendFileSync } from 'node:fs';
import http from 'node:http';

const P = new URL('../com.lemonsieurxav.patrimoine.sdPlugin/', import.meta.url).pathname;
const RES = process.env.SORTIE_TEST ?? '/tmp/patrimoine-test.txt';
const log = (...a) => appendFileSync(RES, a.join(' ') + '\n');

process.on('uncaughtException', (e) => log('EXCEPTION', e.stack));
process.on('unhandledRejection', (e) => log('REJET', String((e && e.stack) || e)));

const streamDeck = (await import(`${P}node_modules/@elgato/streamdeck/dist/plugin/index.js`)).default;
const { connecter, estConnecte } = await import(`${P}auth.js`);

// --- Bouchons : rien ne sort de la machine.
let stock = {};
streamDeck.settings.getGlobalSettings = async () => stock;
streamDeck.settings.setGlobalSettings = async (s) => {
  stock = s;
};

let urlOuverte = null;
const ouvrir = async (u) => {
  urlOuverte = u;
};

const vu = { register: null, token: null };
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/oauth/register')) {
    vu.register = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ client_id: 'cli_TEST' }) };
  }
  if (u.endsWith('/oauth/token')) {
    vu.token = Object.fromEntries(new URLSearchParams(opts.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'acc', refresh_token: 'ref_1', expires_in: 3600 }),
    };
  }
  throw new Error('appel inattendu : ' + u);
};

/** Client HTTP brut : ne passe pas par le fetch bouchonne. */
const visiter = (u) =>
  new Promise((resolve, reject) => {
    const r = http.get(u, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', reject);
  });

const verif = (nom, condition, detail = '') =>
  log(`${condition ? 'ok ' : 'KO '} ${nom}${detail ? ' · ' + detail : ''}`);

// --- Le flux demarre ; on joue ensuite le navigateur de l'utilisateur.
const promesse = connecter({ ouvrir });
promesse.catch(() => {});
await new Promise((r) => setTimeout(r, 400));

if (!urlOuverte) {
  log('KO  aucun navigateur ouvert');
  process.exit(1);
}

const auth = new URL(urlOuverte);
const redirect = auth.searchParams.get('redirect_uri');
const state = auth.searchParams.get('state');
const port = new URL(redirect).port;

verif('port ephemere (pas le 8788 code en dur du hub)', port && port !== '8788', `port ${port}`);
verif('redirect enregistre == redirect autorise', vu.register.redirect_uris[0] === redirect);
verif('client public, aucun secret embarque', vu.register.token_endpoint_auth_method === 'none');
verif(
  'PKCE S256 present',
  auth.searchParams.get('code_challenge_method') === 'S256' &&
    (auth.searchParams.get('code_challenge') || '').length > 20,
);

const refuse = await visiter(`${redirect}?code=injecte&state=pirate`);
verif('code a state etranger refuse', refuse === 400, `HTTP ${refuse}`);

// Le point important : une page hostile qui a visite l'adresse de retour ne
// doit PAS avoir casse la connexion legitime, qui arrive juste apres.

const accepte = await visiter(`${redirect}?code=CODE_OK&state=${encodeURIComponent(state)}`);
verif('code a bon state accepte', accepte === 200, `HTTP ${accepte}`);

const abouti = await promesse;
verif('connexion aboutie', abouti === true && estConnecte());
verif('code_verifier PKCE renvoye a l\'echange', Boolean(vu.token.code_verifier));
verif('le code recu est bien celui echange', vu.token.code === 'CODE_OK');
verif('refresh token persiste', stock.refreshToken === 'ref_1');
verif('client id persiste', stock.clientId === 'cli_TEST');

await new Promise((r) => setTimeout(r, 200));
let ferme = false;
try {
  await visiter(redirect);
} catch {
  ferme = true;
}
verif('port referme apres le flux', ferme);

globalThis.fetch = vraiFetch;
log('--- fin');
