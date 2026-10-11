#!/bin/bash
# Tests du flux d'authentification. Aucun appel ne sort de la machine : les
# deux points de contact reseau (Clerk, le MCP) sont bouchonnes.
#
# POURQUOI UN FICHIER DE SORTIE plutot que la console : le SDK detourne stdout
# des qu'on l'importe. Un `console.log` n'affiche rien et le process sort en
# silence avec le code 0 — on croit alors que le test n'a pas tourne.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echec=0
for test in auth rotation; do
    sortie="$(mktemp)"
    echo "── $test"
    SORTIE_TEST="$sortie" node "$test.mjs"
    cat "$sortie"
    if grep -qE '^(KO|EXCEPTION|REJET)' "$sortie" || [ ! -s "$sortie" ]; then
        echec=1
    fi
    rm -f "$sortie"
    echo
done

if [ "$echec" -ne 0 ]; then
    echo "ECHEC"
    exit 1
fi
echo "Tout passe."
