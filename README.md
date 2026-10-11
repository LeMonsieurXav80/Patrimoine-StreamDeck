# Patrimoine — votre argent sur des touches physiques

Un plugin [Stream Deck](https://www.elgato.com/stream-deck) qui affiche votre **patrimoine**, votre
**budget du mois** et votre **trésorerie** sur des touches, en permanence, sans ouvrir d'application.

Les données viennent de votre compte [Finary](https://finary.com), via leur connecteur MCP officiel,
**en lecture seule**.

> Projet indépendant, sans lien avec Finary ni Elgato. « Finary » est une marque de ses propriétaires,
> citée ici pour dire avec quel service le plugin fonctionne.

---

## Ce que ça affiche

Une seule action, à poser autant de fois que vous voulez. Chaque touche choisit son chiffre :

| Chiffre | En grand | Les deux lignes du bas |
|---|---|---|
| **Patrimoine** | Le net | Brut · actifs financiers |
| **Budget** | Le solde du mois | Entrées · sorties |
| **Trésorerie** | Courants + livrets | Détail courants · livrets |

Le libellé du budget porte l'avancement du mois — `BUDGET 11/31`. Ce n'est pas décoratif : un
`+1 200 €` affiché seul le 11 se lit comme le résultat du mois, alors qu'il ne couvre que les jours
écoulés, prélèvements de fin de mois non passés.

**Un appui sur une touche met son chiffre à jour.** Il n'y a pas de bouton « rafraîchir » dédié : ce
serait une touche gâchée sur les quinze d'un Stream Deck MK.2.

## Installation

### Depuis la Marketplace Elgato

Pas encore disponible. En attendant :

### Depuis GitHub

1. Téléchargez `com.lemonsieurxav.patrimoine.streamDeckPlugin` depuis la
   [dernière release](../../releases/latest).
2. Double-cliquez sur le fichier. Stream Deck propose l'installation.
3. Stream Deck affichera un avertissement : le plugin ne vient pas de la Marketplace et n'est donc
   pas signé par Elgato. C'est attendu — acceptez pour continuer.

<details>
<summary>Ou à la main, depuis les sources</summary>

```bash
git clone https://github.com/LeMonsieurXav80/Patrimoine-StreamDeck.git
cd Patrimoine-StreamDeck/com.lemonsieurxav.patrimoine.sdPlugin
npm install
cd .. && ./deploy.sh
```

`deploy.sh` **copie** le dossier dans `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`.
Il ne fait jamais de lien symbolique : Stream Deck démarre environ une minute après la session, et
un lien vers un disque pas encore monté donne un plugin silencieusement ignoré.

Puis relancez Stream Deck :

```bash
osascript -e 'quit app "Elgato Stream Deck"' && sleep 3 && open -a 'Elgato Stream Deck'
```
</details>

**Prérequis** : macOS, Stream Deck 7.1 ou plus récent, un compte Finary.

## Première utilisation

1. Posez une touche **Chiffre** sur votre Stream Deck.
2. Elle affiche `CONNEXION`. **Appuyez dessus.**
3. Votre navigateur s'ouvre sur Finary. Connectez-vous et autorisez l'accès.
4. Fermez l'onglet : la touche affiche déjà votre chiffre.

Le panneau de réglages (clic sur la touche dans Stream Deck) permet de choisir quel chiffre afficher,
et de se déconnecter.

## Ce que le plugin fait de vos données

C'est un plugin qui touche à votre argent, donc autant être précis.

- **Rien ne transite par un serveur tiers.** Votre machine parle directement à Finary. Il n'y a
  aucun serveur intermédiaire, et l'auteur de ce plugin ne voit rien.
- **Lecture seule, garantie côté Finary.** Le connecteur MCP de Finary est en lecture seule, et il
  le déclare lui-même. Ce n'est pas une promesse de ce plugin : il ne *peut pas* modifier votre
  compte.
- **Aucun secret n'est embarqué.** L'authentification utilise OAuth en client public avec PKCE
  ([RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)) : rien à cacher dans l'archive, et
  c'est votre machine qui détient le jeton.
- **Votre jeton reste chez vous**, dans les réglages globaux du plugin, sur votre machine.
- **Une collecte toutes les 10 minutes**, deux appels. Un patrimoine ne bouge pas à la minute, et
  autant rester léger chez Finary.

Le code est ouvert, et c'est le but : pour un plugin qui affiche votre patrimoine, pouvoir lire ce
qu'il fait vaut mieux qu'un engagement sur l'honneur. Les fichiers qui comptent sont
[`auth.js`](com.lemonsieurxav.patrimoine.sdPlugin/auth.js) (authentification) et
[`finary.js`](com.lemonsieurxav.patrimoine.sdPlugin/finary.js) (lecture des chiffres).

## Comment c'est fait

```
premier appui   ->  auth.js    enregistrement du client, PKCE, navigateur
                ->  le jeton part dans les réglages globaux
toutes les 10 min -> finary.js  2 appels MCP  ->  3 chiffres
                ->  render.js  un SVG 144x144 par touche
```

| Fichier | Rôle |
|---|---|
| `auth.js` | OAuth : enregistrement dynamique du client, PKCE, port de retour, rotation des jetons |
| `finary.js` | Client MCP (JSON-RPC sur HTTP) et calcul des trois chiffres |
| `render.js` | Dessin d'une touche en SVG. Pur, testable, sans dépendance au SDK |
| `plugin.js` | Un seul ordonnanceur, une action configurable, connexion au premier appui |

Une règle est suivie partout : **on ne recalcule jamais un total en additionnant des comptes.** Le
serveur Finary y insiste, et il a raison — les parts de propriété et la détention via société
rendent la somme naïve fausse. On affiche le chiffre qu'il donne.

Pas d'étape de compilation : du JavaScript chargé tel quel.

### Tests

```bash
./tests/lancer.sh
```

Vingt-trois contrôles sur le flux d'authentification et la rotation des jetons. Les deux points de
contact réseau sont bouchonnés : rien ne sort de la machine, et aucun client n'est créé chez Finary.

## Limites connues

- **macOS seulement** pour l'instant. Rien dans le code n'est spécifique au Mac, mais annoncer une
  compatibilité Windows jamais testée serait pire que de l'ajouter plus tard.
- **Pas encore de compte ou d'actif en particulier** (un PEA, une assurance-vie, une ligne précise).
  Les positions renvoyées par le connecteur ne portent que des identifiants techniques, sans nom :
  les nommer correctement demande un travail supplémentaire.
- **L'enregistrement du client OAuth est ouvert aujourd'hui**, mais rien ne le documente côté
  Finary. S'il venait à être restreint, seules les *nouvelles* installations seraient touchées :
  les comptes déjà connectés continueraient de fonctionner.

## Licence

MIT — voir [LICENSE](LICENSE).
