#!/bin/bash
# Installe le plugin dans le dossier Stream Deck, PAR COPIE.
#
# Jamais de symlink vers /Volumes/Samsung_T5 : Stream Deck demarre ~1 min apres
# le boot du Mac, avant que le disque externe soit monte. Il trouve un lien
# mort, ignore le plugin, et toutes les touches affichent "?".
#
# Ce n'est pas theorique : le plugin EcoFlow etait installe en symlink vers le
# T5, et il n'a jamais fonctionne.
#
# A relancer apres chaque modification du code, du manifeste ou de l'inspector.

set -euo pipefail

NAME="com.lemonsieurxav.patrimoine.sdPlugin"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$NAME"
DST="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/$NAME"

if [ ! -d "$SRC" ]; then
    echo "Source introuvable : $SRC" >&2
    exit 1
fi

if [ ! -d "$SRC/node_modules/@elgato" ]; then
    echo "Dependances absentes. Lancer d'abord :" >&2
    echo "  (cd \"$SRC\" && npm install)" >&2
    exit 1
fi

# Le manifeste a des defauts que Stream Deck tolere en silence pendant des
# semaines (UUID racine absent, Version en 3 segments, FontSize en chaine).
# Ils ne surgissent qu'a la validation. Une seconde ici evite un aller-retour
# de redemarrage.
if command -v streamdeck >/dev/null 2>&1; then
    streamdeck validate "$SRC"
fi

echo "Source : $SRC"
echo "Cible  : $DST"

# Un ancien symlink doit disparaitre avant la copie, sinon rsync ecrirait a
# travers le lien, donc sur le disque externe.
if [ -L "$DST" ]; then
    echo "Suppression de l'ancien symlink"
    rm "$DST"
fi

mkdir -p "$DST"

# Les logs sont ecrits par le plugin dans sa propre copie : ne pas les
# transporter, et ne pas les effacer a chaque deploiement.
rsync -a --delete \
    --exclude 'logs/' \
    --exclude '.DS_Store' \
    "$SRC/" "$DST/"

echo
echo "Installe. Pour recharger le plugin :"
echo "  osascript -e 'quit app \"Elgato Stream Deck\"' && sleep 3 && open -a 'Elgato Stream Deck'"
