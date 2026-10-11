# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Nature du projet

Plugin Stream Deck **autonome et distribuable** : patrimoine, budget et tresorerie Finary sur des
touches physiques. Destine a d'autres personnes que son auteur — GitHub, et peut-etre la
Marketplace Elgato.

**Il ne depend pas du hub du cockpit, et c'est la contrainte fondatrice.** Un plugin distribue ne
peut pas taper sur un NAS prive : il fait sa propre authentification, ses propres appels, et garde
son propre jeton. Le cockpit (`../Cockpit/`) affiche les memes chiffres pour un seul utilisateur en
passant par son hub ; ici tout vit dans le plugin. Ne jamais introduire de dependance vers le hub.

## Comment ca marche

```
touche appuyee (1re fois)  ->  auth.js : enregistrement client + PKCE + navigateur
                           ->  refresh token range dans les GLOBAL SETTINGS
toutes les 10 min          ->  finary.js : 2 appels MCP -> 3 mesures
                           ->  render.js : un SVG 144x144 par touche
```

| Fichier | Role |
|---|---|
| `auth.js` | OAuth Clerk : enregistrement dynamique, PKCE, port de rappel, rotation des jetons |
| `finary.js` | Client MCP (JSON-RPC sur HTTP) et derivation des trois mesures |
| `render.js` | Rendu SVG d'une touche. Pur, sans dependance au SDK |
| `plugin.js` | Ordonnanceur unique, une action configurable, connexion au premier appui |

## Developpement

```bash
cd com.lemonsieurxav.patrimoine.sdPlugin && npm install
cd .. && ./deploy.sh
osascript -e 'quit app "Elgato Stream Deck"' && sleep 3 && open -a 'Elgato Stream Deck'

streamdeck validate com.lemonsieurxav.patrimoine.sdPlugin   # apres toute touche au manifeste
node tools/icone.mjs                                        # seulement si le dessin change
./tests/lancer.sh                                           # flux d'auth, hors ligne
```

Les tests couvrent la seule partie qu'on ne peut pas voir a l'oeil sur une touche : le flux OAuth
et la rotation des jetons. Les deux points de contact reseau sont bouchonnes, rien ne sort de la
machine, et aucun client n'est cree chez Clerk. **A relancer apres toute modification de
`auth.js`** — c'est ce test qui a revele qu'un `state` invalide cassait le flux legitime.

Journal du plugin : `com.lemonsieurxav.patrimoine.sdPlugin/logs/`. C'est le seul moyen
d'observation, d'ou le niveau `info` — un journal vide ne doit pas etre ambigu.

**Le SDK detourne stdout.** Un `console.log` dans un script qui importe `@elgato/streamdeck`
n'affiche rien, et le process sort en silence avec le code 0. Pour tester, ecrire dans un fichier
avec `appendFileSync`. Deux heures perdues a chercher un bug qui n'existait pas.

## Les regles qui ne se discutent pas

**1. Aucun secret embarque.** `token_endpoint_auth_method: 'none'` — client public, PKCE. C'est ce
qui rend l'app distribuable : il n'y a rien a cacher dans une archive que tout le monde peut
ouvrir. Ne jamais introduire de `client_secret`, meme « temporairement ».

**2. Ne JAMAIS jeter quand la persistance du jeton echoue.** Quand on arrive la, Clerk a deja
tourne le refresh : l'ancien est mort qu'on persiste ou non. Jeter ne restaure rien — ca jette le
jeton neuf et provoque la perte d'acces qu'on croyait prevenir. On garde en memoire, on tente le
disque, et un echec degrade en « marche jusqu'au prochain redemarrage ». Constate en vrai le
2026-10-10 cote hub : un `EACCES` a coute une re-autorisation manuelle.

**3. Un `state` invalide ne doit pas interrompre l'attente.** Le refuser est obligatoire ; abandonner
le flux sur ce refus donnerait a n'importe quelle page ouverte dans le navigateur le pouvoir de
casser la connexion en visitant l'adresse de retour avant l'utilisateur. On repond 400 et on
continue d'attendre. Le delai maximum borne l'attente.

**4. Pas d'erreur technique sur une touche.** Session expiree = `CONNEXION`, pas `ERR`. Sur 19 mm
sans ecran, un code de neuf caracteres n'apprend rien ; il faut comprendre qu'un appui suffit.

**5. Un seul echange de jeton a la fois.** Trois touches qui se reveillent ensemble declencheraient
trois rotations concurrentes, et Clerk en refuserait deux — avec un `invalid_grant` qui ferait
croire a une deconnexion alors que tout va bien.

## Audit des guidelines, 2026-10-11

Verifie ligne a ligne contre <https://docs.elgato.com/guidelines/stream-deck/plugins>.

**`showAlert` est EXIGE sur l'echec d'une action** — « Must use `showAlert` to inform users when
actions fail ». Le cockpit l'avait banni par principe (il recouvre la valeur qu'on regardait), et
ce principe ne tient pas pour un plugin publie. Il est donc rendu, mais cadre : seulement sur
**l'appui manuel** et sur **la touche appuyee**. Pas sur un cycle automatique (l'utilisateur n'a
rien demande, une croix toutes les dix minutes serait du bruit), pas sur l'anti-rebond (ce n'est
pas un echec mais un refus explicable, et la touche dit le delai restant).

**Deux ecarts assumes, a surveiller en revue :**

- *« Provide between 2 and 30 actions »* est une recommandation, et on n'en a qu'une. La respecter
  imposerait de scinder en trois actions figees — ce qui violerait un « avoid » plus net, *« Avoid
  static, non-configurable actions »*. Une action configurable est le moindre mal. Le jour ou l'on
  ajoute « un compte en particulier », on repasse a deux.
- *« Must use white stroke (#FFFFFF) for action list icons »* : nos icones sont en **remplissage**
  blanc, pas en trait. Monochromes et sur fond transparent, donc conformes a l'intention. A corriger
  si la revue le releve.

**Deux points qui ne dependent pas du code :** le nom « Patrimoine » doit etre unique sur la
Marketplace (la recherche est rendue en JavaScript, invérifiable depuis un terminal — a verifier
dans un navigateur), et le champ `Author` doit correspondre **exactement** au nom d'organisation
Maker Console une fois le compte cree.

## Contraintes Marketplace deja integrees

- `SDKVersion: 3`, `@elgato/streamdeck` **3.x** (la 1.x est declaree incompatible Marketplace).
- `Software.MinimumVersion` a **7.1** : le SDK 3 l'exige a l'execution, et le schema ne le dit pas.
  Avec `"6.9"` la validation passe puis le plugin meurt au demarrage sur
  `Default onDidReceiveSettings behavior requires Stream Deck version 7.1 or higher`.
- `UUID` racine present, `Version` en **4 segments**, `FontSize` **numerique**.
- **Les fichiers distribues sont immuables** : interdit d'ecrire un fichier d'etat a cote du
  plugin. D'ou les global settings pour le jeton.
- Icones d'action **monochromes sur fond transparent** (une icone coloree ou a fond plein est un
  motif de rejet). `Manifest.Icon` est le seul chemin qui refuse le SVG : PNG 256 + `@2x` 512,
  peints par `tools/icone.mjs` en Node pur.
- **Une seule action configurable** plutot que trois actions figees : les actions statiques non
  configurables sont rejetees, et les UUID d'action ne peuvent plus changer apres publication.

## Le point ouvert

L'enregistrement dynamique de client (`POST clerk.finary.com/oauth/register`) est **ouvert
aujourd'hui, mais rien ne le documente**. A l'echelle d'un plugin distribue, chaque installation
cree son propre client OAuth chez Finary. Si Finary ferme ou limite cet endpoint, **seules les
nouvelles installations cassent** — les comptes deja connectes continuent sur leur client existant.

La sortie propre est un `client_id` attribue a l'application par Finary. C'est une conversation a
avoir avec eux, pas un probleme de code.

Le nom « Finary » est une marque : il n'apparait **ni dans le nom du plugin, ni dans l'UUID**,
seulement dans la description (« fonctionne avec votre compte Finary »), ce qui est autorise.

## Langue

Code, commentaires, UI et libelles **en francais**. Les identifiants techniques restent en anglais
ou sans accent.
