// Plugin Patrimoine — trois chiffres Finary sur des touches physiques.
//
// UNE SEULE ACTION, configurable par un menu deroulant, et non trois actions
// figees « Patrimoine » / « Budget » / « Tresorerie ». Deux raisons :
//
//  - Les regles Marketplace rejettent les actions statiques non
//    configurables. Trois actions sans aucun reglage tomberaient dessus.
//  - C'est extensible : le jour ou l'on ajoute « un compte en particulier »,
//    c'est une entree de plus dans le menu, pas une action de plus dans le
//    manifeste — et les UUID d'action ne peuvent plus changer apres
//    publication.
//
// Un seul ordonnanceur global, pas de sondage par bouton : trois touches ne
// font pas trois fois les appels. Patron reprise du cockpit, qui l'a prouve.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { collecter } from './finary.js';
import { charger, connecter, estConnecte, deconnecter, BesoinConnexion } from './auth.js';
import { renderMesure, toDataUri } from './render.js';

// Dix minutes : un patrimoine ne bouge pas a la minute, et chaque cycle coute
// deux appels chez Finary. Un plugin distribue multiplie ce cout par son
// nombre d'utilisateurs — on reste leger chez eux par defaut.
const POLL_MS = 10 * 60_000;
// Plancher anti-rebond sur appui manuel.
const MIN_MS = 30_000;
const BLINK_MS = 500;
// Au-dela, la mesure est declaree figee et la touche affiche son age plutot
// que son detail. 2,5 cycles : une collecte ratee ne doit pas suffire.
const STALE_MS = POLL_MS * 2.5;

class Patrimoine {
  constructor() {
    this.mesures = null;
    this.asOf = 0;
    this.touches = new Map(); // id d'action -> { action, mesure }
    this.blinkOff = false;
    this.demarre = false;
    this.collecteEnVol = null;
    this.dernierAppel = 0;
    this.authEtat = null; // null | 'connexion' | 'ouverture'
  }

  async demarrer() {
    if (this.demarre) return;
    this.demarre = true;

    await charger();
    this.authEtat = estConnecte() ? null : 'connexion';
    this.peindreTout();

    setInterval(() => this.collecter(), POLL_MS);
    // Un seul minuteur global pour le clignotement : les touches battent
    // ensemble, elles ne derivent pas les unes des autres.
    setInterval(() => {
      this.blinkOff = !this.blinkOff;
      this.peindreTout({ phaseClignotement: true });
    }, BLINK_MS);

    if (estConnecte()) this.collecter();
  }

  get fige() {
    return this.asOf > 0 && Date.now() - this.asOf > STALE_MS;
  }

  /**
   * Collecte, au plus une a la fois.
   *
   * Sans ce verrou, trois touches qui apparaissent ensemble au demarrage
   * declencheraient trois collectes concurrentes, donc six appels MCP pour
   * afficher la meme chose.
   */
  async collecter({ manuel = false } = {}) {
    if (this.collecteEnVol) return this.collecteEnVol;
    if (!estConnecte()) {
      this.authEtat = 'connexion';
      this.peindreTout();
      return;
    }

    this.dernierAppel = Date.now();
    this.collecteEnVol = (async () => {
      try {
        this.mesures = await collecter();
        this.asOf = Date.now();
        this.authEtat = null;
        this.peindreTout();
      } catch (error) {
        if (error instanceof BesoinConnexion) {
          // La session est morte : la touche doit inviter a se reconnecter, et
          // surtout pas afficher une erreur technique. C'est le seul cas ou
          // l'utilisateur a quelque chose a faire.
          streamDeck.logger.warn(`session Finary a renouveler : ${error.message}`);
          this.authEtat = 'connexion';
          this.peindreTout();
          return;
        }
        // Les valeurs precedentes sont conservees et vieillissent : c'est leur
        // fraicheur qui informera, pas un ecran vide.
        streamDeck.logger.warn(`collecte echouee : ${error.message}`);
        this.peindreTout();
        // `showAlert` est EXIGE par les regles Marketplace pour signaler
        // l'echec d'une action. On le reserve a l'appui manuel : sur un cycle
        // automatique, l'utilisateur n'a rien demande, et une croix surgissant
        // toute seule toutes les dix minutes serait du bruit. Sur un appui, en
        // revanche, il attend une reponse — et l'ancien montant, inchange, ne
        // lui dirait pas que la mise a jour a echoue.
        if (manuel) this.alerter();
      } finally {
        this.collecteEnVol = null;
      }
    })();

    return this.collecteEnVol;
  }

  /**
   * Croix de Stream Deck sur la touche qu'on vient d'appuyer.
   *
   * Les regles Marketplace l'exigent sur l'echec d'une action. Elle recouvre
   * le montant pendant une seconde, ce qui est precisement le reproche qu'on
   * lui fait d'ordinaire — mais sur un echec, il n'y a justement plus rien de
   * frais a regarder dessous.
   */
  alerter() {
    for (const entree of this.touches.values()) {
      if (entree.appuyee) entree.action.showAlert().catch(() => {});
    }
  }

  /**
   * Retour d'appui PEINT DANS LA TOUCHE, quelques centaines de ms.
   *
   * Remplace `showOk()` / `showAlert()` du SDK, qui plaquent une enorme coche
   * ou une croix par-dessus toute la touche : ca recouvre le montant qu'on
   * venait justement regarder, et ca n'apprend rien — « quelque chose a ete
   * fait » sans dire quoi.
   */
  flash(id, patch, ms = 1100) {
    const entree = this.touches.get(id);
    if (!entree) return;
    entree.flash = patch;
    clearTimeout(entree.minuterie);
    entree.minuterie = setTimeout(() => {
      entree.flash = null;
      this.peindreUne(id);
    }, ms);
    this.peindreUne(id);
  }

  peindreUne(id) {
    const entree = this.touches.get(id);
    if (!entree) return;

    const mesure = this.mesures?.[entree.mesure] ?? null;
    const affichee = entree.flash ? { ...(mesure ?? {}), ...entree.flash } : mesure;

    const svg = renderMesure(affichee, {
      auth: entree.flash ? null : this.authEtat,
      ageMs: Date.now() - this.asOf,
      stale: !entree.flash && this.fige,
      blinkOff: this.blinkOff,
    });
    this.envoyer(entree, svg);
  }

  /**
   * Envoie l'image, en SIGNALANT un echec au moins une fois.
   *
   * Un `.catch(() => {})` muet est precisement ce qui a fait croire pendant des
   * mois que le plugin EcoFlow fonctionnait : des touches vides et un journal
   * vide ne se distinguent pas d'un plugin qui n'a rien a dire. Une seule ligne
   * par touche — repeter a chaque repeinture noierait le journal a deux images
   * par seconde.
   */
  envoyer(entree, svg) {
    entree.action.setImage(toDataUri(svg)).catch((error) => {
      if (entree.erreurSignalee) return;
      entree.erreurSignalee = true;
      streamDeck.logger.error(`peinture impossible (${entree.mesure}) : ${error.message}`);
    });
  }

  peindreTout({ phaseClignotement = false } = {}) {
    for (const [id, entree] of this.touches) {
      if (!phaseClignotement) {
        this.peindreUne(id);
        continue;
      }
      // Un clignotement ne doit pas ecraser un retour d'appui en cours, sinon
      // le « MAJ » disparaitrait au bout de 500 ms sans avoir ete lu.
      if (entree.flash) continue;

      // Ce qui clignote : l'invitation a se connecter, et un budget negatif.
      // Rien d'autre. Un patrimoine n'est jamais une alerte a acquitter, et
      // trois touches qui battent en permanence ne signalent plus rien.
      const statut = this.authEtat
        ? 'new'
        : this.fige
          ? 'down'
          : (this.mesures?.[entree.mesure]?.status ?? null);
      if (!statut || statut === 'ok' || statut === 'down') continue;

      this.peindreUne(id);
    }
  }

  inscrire(id, action, mesure) {
    const existante = this.touches.get(id);
    this.touches.set(id, { ...existante, action, mesure });
  }

  retirer(id) {
    clearTimeout(this.touches.get(id)?.minuterie);
    this.touches.delete(id);
  }
}

const app = new Patrimoine();

class ChiffreAction extends SingletonAction {
  constructor() {
    super();
    // Pas de decorateur `@action` : ce fichier est du JS pur charge tel quel
    // par Stream Deck, sans etape de build, et Node ne lit pas les
    // decorateurs. Le `manifestId` pose a la main fait le meme travail.
    this.manifestId = 'com.lemonsieurxav.patrimoine.chiffre';
  }

  async onWillAppear(ev) {
    const mesure = ev.payload.settings?.mesure ?? 'patrimoine';
    app.inscrire(ev.action.id, ev.action, mesure);
    await app.demarrer();
    app.peindreUne(ev.action.id);
  }

  onWillDisappear(ev) {
    app.retirer(ev.action.id);
  }

  onDidReceiveSettings(ev) {
    app.inscrire(ev.action.id, ev.action, ev.payload.settings?.mesure ?? 'patrimoine');
    app.peindreUne(ev.action.id);
  }

  /** Le Property Inspector demande l'etat, ou la deconnexion. */
  async onSendToPlugin(ev) {
    if (ev.payload?.action === 'deconnecter') {
      await deconnecter();
      app.mesures = null;
      app.asOf = 0;
      app.authEtat = 'connexion';
      app.peindreTout();
    }
    await streamDeck.ui.current?.sendToPropertyInspector({
      connecte: estConnecte(),
    });
  }

  /**
   * Premier appui : on se connecte. Ensuite : on rafraichit.
   *
   * C'est volontairement la MEME touche. Un bouton « se connecter » separe
   * serait une touche gachee sur les quinze d'un MK.2, et il n'aurait plus
   * aucune utilite une fois la connexion faite.
   */
  async onKeyDown(ev) {
    // Marque la touche appuyee : c'est elle, et elle seule, qui portera une
    // eventuelle croix d'echec. Les autres touches n'ont rien demande.
    const entree = app.touches.get(ev.action.id);
    if (entree) entree.appuyee = true;

    try {
      if (!estConnecte()) {
        app.authEtat = 'ouverture';
        app.peindreTout();
        try {
          await connecter();
          app.authEtat = null;
          app.peindreTout();
          await app.collecter({ manuel: true });
        } catch (error) {
          // Abandon volontaire (onglet ferme) ou vrai echec : dans les deux
          // cas l'action demandee n'a pas abouti, et la regle Marketplace
          // demande de le signaler.
          streamDeck.logger.warn(`connexion non aboutie : ${error.message}`);
          app.authEtat = 'connexion';
          app.peindreTout();
          app.alerter();
        }
        return;
      }

      // Anti-rebond. PAS de `showAlert` ici : ce n'est pas un echec, c'est un
      // refus temporaire et explicable. La touche dit le delai restant, ce qui
      // en apprend plus qu'une croix, et la regle Marketplace ne vise que les
      // actions qui echouent.
      const reste = MIN_MS - (Date.now() - app.dernierAppel);
      if (reste > 0) {
        return app.flash(ev.action.id, {
          rows: [{ k: 'ATTEND', v: `${Math.ceil(reste / 1000)}s` }],
          status: 'warn',
        });
      }

      // Accuse reception immediat : l'appel peut durer une a deux secondes, et
      // sans lui l'appui semble n'avoir rien fait.
      app.flash(ev.action.id, { rows: [{ k: 'MAJ', v: '…' }], status: 'new' }, 6000);
      await app.collecter({ manuel: true });
      // Pas de « succes » a afficher : le montant frais EST le retour, et les
      // regles deconseillent de doubler un indicateur de succes deja visible.
      app.flash(ev.action.id, null, 0);
    } finally {
      if (entree) entree.appuyee = false;
    }
  }
}

// INFO et non le defaut : le seul moyen d'observation est le journal du
// plugin, et un journal vide est ambigu — « tout va bien » ou « le code n'est
// jamais arrive la ». C'est exactement la confusion qui a fait croire pendant
// des mois que le plugin EcoFlow marchait.
//
// `'info'` et non `LogLevel.INFO` : depuis le SDK 3 les niveaux sont de
// simples chaines, l'enumeration n'est plus exportee par la racine du paquet.
streamDeck.logger.setLevel('info');
streamDeck.logger.info('plugin Patrimoine demarre');

streamDeck.actions.registerAction(new ChiffreAction());
streamDeck.connect();
