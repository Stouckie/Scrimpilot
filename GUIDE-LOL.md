# Guide fonctionnel League of Legends

Ce document résume les règles LoL implémentées par ScrimPilot pour les scrims, l'arbitrage et les ladders.

## Catégories & rangs
| Catégorie | Rangs inclus |
|-----------|---------------|
| IB        | Iron + Bronze |
| SG        | Silver + Gold |
| PE        | Platine + Émeraude |
| DM        | Diamant + Master |
| GMC       | Grandmaster + Challenger |

## Mapping Skill Rating (SR)
Les rangs LoL sont convertis en SR (0–10) pour faciliter les calculs :

| Rang | SR |
|------|----|
| Iron | 0 |
| Bronze | 1 |
| Silver | 2 |
| Gold | 3 |
| Platine | 4 |
| Émeraude | 5 |
| Diamant | 6 |
| Master | 7 |
| Grandmaster | 8 |
| Challenger | 9–10 |

## Calcul du SR d'équipe (trimmed mean)
1. Récupérer le SR individuel des 5 joueurs alignés.
2. Trier les valeurs, retirer le minimum et le maximum.
3. Faire la moyenne des 3 valeurs restantes.
4. Arrondir à un chiffre après la virgule → `SR_team`.

Ce `SR_team` est utilisé pour déterminer les garde-fous de matchmaking.

## Garde-fous de composition
- **Spread interne** : `max SR - min SR ≤ 4`. Sinon le match passe en practice ou un joueur extrême doit être remplacé.
- **Cohérence** : au moins 3 joueurs doivent être dans ±1 autour de `SR_team`. Dans le cas contraire, la rencontre est classée en practice.
- **Écart entre équipes** : différence maximale de `SR_team` selon le preset choisi
  - Open : `|ΔSR_team| ≤ 1.0`
  - Academy : `|ΔSR_team| ≤ 0.5`
  - Pro (valeur personnalisée par preset)

## Flux de scrim
1. `/scrim post` publie une annonce avec catégorie, preset, date et notes.
2. `/scrim accept` associe une équipe challengée à la publication.
3. `/scrim confirm` verrouille le match, déclenche les contrôles SR et crée un thread privé dans le salon défini par `SCRIMS_CHANNEL_ID`.
4. Le thread contient :
   - Récapitulatif du match (patch, preset, consignes de check-in).
   - Ajout automatique des joueurs déclarés + coachs des deux équipes.
   - Rappels planifiés J-1, H-1 et H-0.
5. Check-in via réactions ✅.
6. No-show automatique si une équipe ne s'est pas manifestée 10 minutes après H-0.
7. `/scrim cancel` est autorisé par le capitaine avant le match (pénalité si < 60 min).

## Preuves & rapport
1. Chaque capitaine utilise `/scrim report` avec le score final (ex : `A1-B0`).
2. Les deux capitaines doivent poster dans le thread :
   - Capture « Victoire/Défaite ».
   - Scoreboard complet.
3. Les URLs des messages de preuve sont enregistrées.
4. Dès que les deux rapports sont fournis, le match passe à l'état **À VALIDER** et une carte est créée dans le salon d'arbitrage.

## Arbitrage & états
- **CONFIRMÉ** → **À VALIDER** → décision du staff.
- Actions disponibles sur la carte Discord :
  - **Valider** : résultat officiel, mise à jour ladder/fiabilité.
  - **Refuser** (avec motif) : retour en thread pour compléments.
  - **Demander compléments** : ping des capitaines avec checklist.
  - **Ouvrir litige** : passage à l'état **LITIGE** jusqu'à décision.
  - **Disqualification** : utilisée en cas de fraude (faux screen, joueur non déclaré).
- Aucun match n'est validé automatiquement : un arbitre doit confirmer.

## Pénalités & fiabilité
- **No-show** : −15 fiabilité + cooldown scrim 24h (Open) / 48h (Academy/Pro).
- **Annulation tardive** (< 60 min) : −10 fiabilité.
- **Fraude / DQ** : −25 fiabilité et mise à jour du ticket d'arbitrage.
- La commande `/reliability show` permet aux capitaines de consulter leur score.
- Les équipes en cooldown ne peuvent pas poster/accepter un scrim tant que la fenêtre n'est pas expirée.

## Ladders LoL
- Commandes disponibles :
  - `/ladder create` (staff) pour initialiser une catégorie et une région.
  - `/ladder join` pour inscrire une équipe.
  - `/ladder queue` pour entrer dans la file (matchmaking via SR/reliability).
  - `/ladder report` pour enregistrer un résultat (même flux d'arbitrage que les scrims).
  - `/ladder leaderboard` pour consulter le top 10.
  - `/ladder seasonclose` pour effectuer un soft reset (Elo remis à 1000, historique archivé).
- Le calcul Elo utilise un `K=24` par équipe avec ajustements fiabilité/no-show.
- Les matches ladder suivent les mêmes exigences de preuves et de validation AR que les scrims.

