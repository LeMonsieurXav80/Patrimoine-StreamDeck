// Authentification Finary — flux navigateur, chez l'utilisateur final.
//
// Reprise de `hub/tools/finary-auth.js` du cockpit, avec trois differences qui
// viennent du fait que ce code ne tourne plus sur MON NAS mais sur la machine
// de quelqu'un d'autre :
//
//  1. LE PORT EST EPHEMERE. Le hub ecoutait sur 8788 en dur, acceptable pour
//     une manipulation unique sur une machine connue. Distribue, c'est une
//     collision garantie — un autre service, ou deux Stream Deck. On demande
//     donc le port 0 et on laisse l'OS choisir, PUIS on enregistre le client
//     avec ce port-la. L'ordre compte : Clerk verifie le `redirect_uri` a
//     l'identique, on ne peut pas l'annoncer avant de le connaitre.
//
//  2. LE JETON VIT DANS LES GLOBAL SETTINGS, pas dans un fichier. Les regles
//     Marketplace imposent que les fichiers distribues soient immuables :
//     ecrire un `state.json` a cote du plugin est interdit, et serait de toute
//     facon efface au prochain deploiement.
//
//  3. AUCUN SECRET N'EST EMBARQUE. `token_endpoint_auth_method: 'none'` —
//     client public, c'est PKCE qui garantit que le code ne sert qu'a celui
//     qui l'a demande. C'est ce qui rend l'app distribuable : il n'y a rien a
//     cacher dans une archive que tout le monde peut ouvrir.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import streamDeck from '@elgato/streamdeck';

const ISSUER = 'https://clerk.finary.com';
const SCOPE = 'openid profile email offline_access';

// 10 minutes. Le hub laissait 30 — le temps que Xavier revienne au terminal.
// Ici l'utilisateur vient d'appuyer sur une touche, il est devant son ecran :
// au-dela de dix minutes il a abandonne, et garder un port ouvert et un
// `state` valide plus longtemps n'apporte rien.
const LIMITE_MS = 10 * 60_000;

const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

/** Levee quand il faut (re)passer par le navigateur. La touche l'affiche. */
export class BesoinConnexion extends Error {
  constructor(raison) {
    super(raison ?? 'connexion requise');
    this.name = 'BesoinConnexion';
  }
}

// La VERITE pour le process en cours. Les global settings ne sont qu'un
// miroir : si leur ecriture echoue, on continue avec ce qu'on a en memoire.
let memoire = { clientId: null, refreshToken: null };
let acces = { jeton: null, expire: 0 };
let echangeEnVol = null;
let chargeDepuisDisque = false;

/** Relit les global settings une fois, au demarrage du plugin. */
export async function charger() {
  if (chargeDepuisDisque) return memoire;
  chargeDepuisDisque = true;
  try {
    const g = await streamDeck.settings.getGlobalSettings();
    if (g?.refreshToken) {
      memoire = { clientId: g.clientId ?? null, refreshToken: g.refreshToken };
    }
  } catch (error) {
    streamDeck.logger.warn(`global settings illisibles : ${error.message}`);
  }
  return memoire;
}

export const estConnecte = () => Boolean(memoire.refreshToken);

/** Vide le jeton d'acces en cache, pour que le prochain appel en reforge un. */
export const invaliderAcces = () => {
  acces = { jeton: null, expire: 0 };
};

/**
 * Enregistre l'etat d'auth. NE JETTE JAMAIS, et c'est deliberé.
 *
 * /!\ La lecon du 10 octobre 2026, cote NAS, et elle compte encore plus ici.
 *
 * Quand on arrive dans cette fonction apres une rotation, Clerk a DEJA tourne
 * le jeton : l'ancien est mort, qu'on persiste ou pas. Jeter sur un echec
 * d'ecriture ne restaure rien — ca jette le jeton neuf, et ca provoque
 * exactement la perte d'acces qu'on croyait prevenir. Sur le NAS ca a coute
 * une re-autorisation manuelle. Distribue a mille utilisateurs, ca ferait
 * mille deconnexions sur un incident d'ecriture.
 *
 * Donc : memoire d'abord, disque ensuite, et un echec degrade en « marche
 * jusqu'au prochain redemarrage du plugin » au lieu de « casse maintenant ».
 */
async function enregistrer(patch) {
  memoire = { ...memoire, ...patch };
  try {
    const g = await streamDeck.settings.getGlobalSettings();
    await streamDeck.settings.setGlobalSettings({ ...g, ...memoire });
  } catch (error) {
    streamDeck.logger.warn(
      `jeton non persiste (${error.message}) : l'acces tiendra jusqu'au prochain ` +
        `redemarrage du plugin, puis il faudra se reconnecter.`,
    );
  }
}

export async function deconnecter() {
  memoire = { clientId: null, refreshToken: null };
  invaliderAcces();
  try {
    const g = await streamDeck.settings.getGlobalSettings();
    await streamDeck.settings.setGlobalSettings({ ...g, clientId: null, refreshToken: null });
  } catch (error) {
    streamDeck.logger.warn(`deconnexion non persistee : ${error.message}`);
  }
}

/**
 * Jeton d'acces, depuis le cache ou echange contre le refresh.
 *
 * Un seul echange a la fois : trois touches qui se reveillent ensemble
 * demanderaient trois echanges concurrents, et comme Clerk tourne le refresh a
 * chaque fois, deux des trois se verraient refuses — avec un `invalid_grant`
 * qui ferait croire a une deconnexion alors que tout va bien.
 */
export async function jetonAcces() {
  if (acces.jeton && Date.now() < acces.expire) return acces.jeton;
  if (echangeEnVol) return echangeEnVol;

  echangeEnVol = (async () => {
    await charger();
    if (!memoire.refreshToken) throw new BesoinConnexion('jamais connecte');

    const res = await fetch(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: memoire.refreshToken,
        client_id: memoire.clientId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));

    if (!body.access_token) {
      // `invalid_grant` : le refresh ne vaut plus rien. Soit il a deja servi
      // (rotation perdue sur un redemarrage), soit Finary l'a revoque
      // (deconnexion globale, changement de mot de passe). Dans les deux cas
      // la seule issue est de repasser par le navigateur — donc on efface,
      // pour que la touche affiche CONNEXION et non une erreur opaque.
      if (body.error === 'invalid_grant') {
        await deconnecter();
        throw new BesoinConnexion('session expiree');
      }
      throw new Error(`refresh refuse : ${body.error ?? `HTTP ${res.status}`}`);
    }

    if (body.refresh_token && body.refresh_token !== memoire.refreshToken) {
      await enregistrer({ refreshToken: body.refresh_token });
    }

    acces = {
      jeton: body.access_token,
      // 5 minutes de marge sur l'expiration annoncee.
      expire: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000,
    };
    return acces.jeton;
  })();

  try {
    return await echangeEnVol;
  } finally {
    echangeEnVol = null;
  }
}

/**
 * Ouvre le port de retour et rend `{ port, code, fermer }`.
 *
 * On attend que l'ecoute soit effective AVANT de rendre la main, parce que
 * l'appelant a besoin du port pour enregistrer le client : c'est le port qui
 * determine le `redirect_uri`, et Clerk le verifie a l'identique.
 */
async function ecouter(etatAttendu) {
  const page = (titre, detail) =>
    `<!doctype html><meta charset="utf-8"><title>${titre}</title>` +
    `<body style="background:#14171b;color:#f0f2f4;font:16px -apple-system,system-ui,sans-serif;` +
    `display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center;max-width:30rem;padding:2rem">` +
    `<h1 style="font-weight:600;margin:0 0 .5rem">${titre}</h1>` +
    `<p style="color:#98a1ac;margin:0;line-height:1.5">${detail}</p></div>`;

  let resoudre;
  let rejeter;
  const code = new Promise((res, rej) => {
    resoudre = res;
    rejeter = rej;
  });

  let regle = false;
  const fini = (fn, arg) => {
    if (regle) return;
    regle = true;
    fn(arg);
  };

  const serveur = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const recu = url.searchParams.get('code');
    const etat = url.searchParams.get('state');
    const erreur = url.searchParams.get('error');
    const html = (statut, titre, detail) => {
      res.writeHead(statut, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(titre, detail));
    };

    // LE `state` SE VERIFIE EN PREMIER, ET UN ECHEC N'INTERROMPT PAS L'ATTENTE.
    //
    // Sans cette verification, n'importe quelle page ouverte dans le navigateur
    // pourrait appeler ce callback avec son propre code. Mais abandonner le
    // flux sur un state invalide — ce que faisait la premiere version — est
    // tout aussi mauvais : ca donne a n'importe quelle page le pouvoir de
    // CASSER la connexion de l'utilisateur en visitant l'adresse de retour
    // avant lui. On refuse la requete, et on continue d'attendre la vraie.
    // Le delai maximum borne l'attente de toute facon.
    if (etat !== etatAttendu) {
      html(400, 'État invalide', 'Cette requête ne vient pas de la session en cours.');
      streamDeck.logger.warn('rappel ignore : state invalide');
      return;
    }
    // Refus venant de Finary (l'utilisateur a dit non) : la, on abandonne.
    if (erreur) {
      html(400, 'Autorisation refusée', erreur);
      return fini(rejeter, new BesoinConnexion(erreur));
    }

    html(200, "C'est autorisé ✓", 'Tu peux fermer cet onglet : la touche affiche déjà ton patrimoine.');
    fini(resoudre, recu);
  });

  serveur.on('error', (e) => fini(rejeter, e));

  // Port 0 : l'OS choisit. Voir l'en-tete du fichier.
  await new Promise((pret, echec) => {
    serveur.once('error', echec);
    serveur.listen(0, '127.0.0.1', pret);
  });

  const minuterie = setTimeout(
    () => fini(rejeter, new BesoinConnexion('aucune autorisation reçue')),
    LIMITE_MS,
  );
  minuterie.unref();

  return {
    port: serveur.address().port,
    code,
    fermer: () => {
      clearTimeout(minuterie);
      serveur.close();
    },
  };
}

async function enregistrerClient(redirect) {
  const res = await fetch(`${ISSUER}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Patrimoine (Stream Deck)',
      redirect_uris: [redirect],
      // Le device flow serait le flux naturel pour un appareil, et Clerk
      // l'annonce dans ses metadonnees — mais il le RETIRE a l'enregistrement
      // dynamique (verifie le 2026-10-10 : on demande les trois grants, il
      // n'en accorde que deux). D'ou le navigateur.
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
      application_type: 'native',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.client_id) {
    // Le cas qu'on redoute pour un plugin distribue : si Finary ferme
    // l'enregistrement dynamique, c'est ici que ca se verra, et seules les
    // NOUVELLES installations sont touchees — les comptes deja connectes
    // continuent de tourner sur leur client existant.
    throw new Error(`enregistrement refuse : ${body.error ?? `HTTP ${res.status}`}`);
  }
  return body.client_id;
}

/**
 * Flux complet : ouvre le navigateur, attend l'autorisation, garde le jeton.
 * Rend `true` si on est connecte a la sortie.
 *
 * `ouvrir` existe pour pouvoir tester le flux sans navigateur ni Stream Deck.
 * C'est le seul moyen : `streamDeck.system` est un espace de noms de module,
 * donc fige — on ne peut pas y substituer `openUrl` depuis un test. Le plugin,
 * lui, appelle `connecter()` sans argument.
 */
export async function connecter({ ouvrir = (url) => streamDeck.system.openUrl(url) } = {}) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const retour = await ecouter(state);
  try {
    const redirect = `http://127.0.0.1:${retour.port}/callback`;
    const clientId = await enregistrerClient(redirect);

    const autorisation = new URL(`${ISSUER}/oauth/authorize`);
    autorisation.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

    streamDeck.logger.info(`ouverture du navigateur pour autorisation (port ${retour.port})`);
    await ouvrir(autorisation.href);

    const code = await retour.code;

    const res = await fetch(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: clientId,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const jetons = await res.json().catch(() => ({}));

    if (!jetons.refresh_token) {
      throw new Error(
        `pas de refresh_token en reponse (${jetons.error ?? `HTTP ${res.status}`}) : ` +
          `sans lui il faudrait repasser par le navigateur a chaque cycle`,
      );
    }

    await enregistrer({ clientId, refreshToken: jetons.refresh_token });
    invaliderAcces();
    streamDeck.logger.info('autorisation Finary obtenue');
    return true;
  } finally {
    // Le port ne doit pas rester ouvert, meme en cas d'echec : c'est un
    // serveur HTTP sur la machine de l'utilisateur.
    retour.fermer();
  }
}
