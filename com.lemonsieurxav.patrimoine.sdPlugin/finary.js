// Lecture du patrimoine via le serveur MCP officiel de Finary.
//
// MCP est un protocole ouvert : on parle JSON-RPC sur HTTP, il n'y a aucun
// client conversationnel dans l'histoire. Le serveur est en LECTURE SEULE cote
// Finary, et il le dit lui-meme dans ses instructions — ce plugin ne peut rien
// modifier dans le compte de l'utilisateur, par construction et pas par
// promesse.
//
// /!\ LA REGLE QUE LE SERVEUR MARTELE, ET QU'ON RESPECTE.
//
// « for ANY total, allocation, or "how am I doing" question, call
// get_portfolio_overview and use ITS total — never recompute a total by
// summing ». On ne reconstitue donc JAMAIS un patrimoine en additionnant des
// comptes : les parts de propriete (`owned_*_effective`) et la detention via
// societe rendent la somme naive fausse. On lit le chiffre qu'il donne.

import streamDeck from '@elgato/streamdeck';
import { jetonAcces, invaliderAcces, BesoinConnexion } from './auth.js';

const MCP = 'https://public-api.finary.com/mcp';

let compteur = 100;

async function outil(nom, args = {}) {
  const jeton = await jetonAcces();

  const res = await fetch(MCP, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jeton}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: compteur++,
      method: 'tools/call',
      params: { name: nom, arguments: args },
    }),
    signal: AbortSignal.timeout(40_000),
  });

  if (res.status === 401) {
    // Jeton rejete : vider le cache pour que le cycle suivant en reforge un.
    // Ce n'est pas forcement une deconnexion — un jeton d'acces peut expirer
    // plus tot qu'annonce.
    invaliderAcces();
    throw new Error('jeton rejeté');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const enveloppe = await res.json();
  if (enveloppe.error) throw new Error(enveloppe.error.message ?? 'erreur MCP');

  // Un outil MCP repond du texte ; celui-ci renvoie du JSON dedans.
  const texte = (enveloppe.result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  try {
    return JSON.parse(texte);
  } catch {
    throw new Error('réponse non-JSON');
  }
}

/** Montant compact : « 312,5k », « 1,24M », « 899 ». */
export function euros(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace('.', ',')}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1).replace('.', ',')}k`;
  return Math.round(n).toLocaleString('fr-FR').replace(/ | /g, ' ');
}

const nombre = (x) => (x == null ? null : Number(x));

/**
 * Les trois mesures du plugin, en deux appels MCP.
 *
 * Deux appels et non cinq : l'apercu porte deja le patrimoine ET l'allocation
 * dont la tresorerie se deduit. Chaque appel coute une requete chez Finary, et
 * un plugin distribue multiplie ce cout par son nombre d'utilisateurs — autant
 * ne rien demander deux fois.
 */
export async function collecter() {
  const vue = await outil('get_portfolio_overview');

  const bilan = vue.balance_sheet ?? {};
  const net = nombre(bilan.owned_net_worth_effective);
  const brut = nombre(bilan.owned_gross_assets_effective);

  const parCategorie = new Map(
    (vue.allocation_effective ?? []).map((a) => [a.category, nombre(a.owned_amount_effective)]),
  );

  const mesures = {};

  // ---- Patrimoine : le net en grand, le brut et le financier en dessous.
  //
  // Le « financier » n'est pas une sous-partie evidente du brut : Finary le
  // definit a sa facon (hors immobilier et hors biens), d'ou son nom propre
  // dans la reponse et le fait qu'on le prenne tel quel.
  const financier = nombre(vue.financial_assets?.owned_financial_assets_effective);
  mesures.patrimoine = {
    label: 'Patrimoine',
    value: `${euros(net)} €`,
    rows: [
      { k: 'BRUT', v: `${euros(brut)}€` },
      { k: 'FINAN', v: `${euros(financier)}€` },
    ],
    status: 'ok',
    band: 'ocre',
    icon: 'euro',
  };

  // ---- Tresorerie : comptes courants + livrets, les liquidites reelles.
  // L'immobilier n'en fait pas partie : ce n'est pas de l'argent disponible.
  const courants = parCategorie.get('checking_accounts') ?? 0;
  const epargne = parCategorie.get('savings_accounts') ?? 0;
  mesures.tresorerie = {
    label: 'Trésorerie',
    value: `${euros(courants + epargne)} €`,
    rows: [
      { k: 'COURT', v: `${euros(courants)}€` },
      { k: 'LIVRET', v: `${euros(epargne)}€` },
    ],
    status: 'ok',
    band: 'ocre',
    icon: 'euro',
  };

  // ---- Budget du mois.
  //
  // /!\ LE MOIS EST EN COURS. Un « +1 236 € » affiche seul se lit comme le
  // resultat du mois, alors qu'il ne couvre que les jours ecoules — les
  // prelevements de fin de mois ne sont pas passes. Le libelle porte donc
  // l'avancement (« BUDGET 11/31 »), parce qu'il n'y a pas de troisieme ligne
  // disponible sur une touche et que cette information n'est pas optionnelle.
  //
  // Dans son propre try : un budget indisponible ne doit pas priver des deux
  // autres chiffres, qui viennent d'un appel deja reussi.
  try {
    const b = await outil('get_budget_overview', { period: 'this_month' });
    const solde = nombre(b.family_net_cashflow);
    const ecoules = b.view?.elapsed_days;
    const total = b.view?.total_days;

    mesures.budget = {
      label: b.view?.is_partial && ecoules ? `Budget ${ecoules}/${total}` : 'Budget',
      value: `${solde > 0 ? '+' : ''}${euros(solde)} €`,
      rows: [
        { k: 'ENTR', v: `${euros(nombre(b.family_income_total))}€` },
        { k: 'SORT', v: `${euros(nombre(b.family_expense_total))}€` },
      ],
      // Un solde negatif est une information actionnable, pas du bruit.
      status: solde == null ? 'down' : solde < 0 ? 'crit' : 'ok',
      band: 'ocre',
      icon: 'courbe',
    };
  } catch (error) {
    if (error instanceof BesoinConnexion) throw error;
    streamDeck.logger.warn(`budget indisponible : ${error.message}`);
    mesures.budget = {
      label: 'Budget',
      value: 'ERR',
      rows: [{ k: '', v: String(error.message).slice(0, 9) }],
      status: 'down',
      band: 'ocre',
      icon: 'courbe',
    };
  }

  return mesures;
}
