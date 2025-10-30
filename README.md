# ScrimPilot LoL

Bot Discord en TypeScript pour orchestrer les scrims, ladders et arbitrages League of Legends.

## Fonctionnalités principales
- Gestion des organisations, équipes et joueurs (rangs LoL uniquement).
- Publication, acceptation, confirmation et suivi complet des scrims (threads privés, check-in, rappels, no-shows).
- Collecte des preuves et file d'arbitrage avec boutons d'action pour le staff.
- Ladders par catégorie avec file d'attente, calcul Elo, historique et clôture de saison.
- Système de fiabilité, pénalités automatiques et commande de consultation.

## Prérequis
- Node.js 22.x (voir `.nvmrc` pour basculer de version).
- npm 10+.
- Un bot Discord configuré avec les intents message/content nécessaires.

## Installation
1. Cloner ce dépôt et se placer à sa racine.
2. Installer les dépendances :
   ```bash
   npm install
   ```

## Configuration
1. Copier le fichier d'exemple et renseigner les variables :
   ```bash
   cp .env.example .env
   ```
2. Éditer `.env` avec les identifiants de votre bot :
   - `DISCORD_TOKEN` – token secret du bot (ne jamais le commiter).
   - `DISCORD_CLIENT_ID` – identifiant de l'application Discord.
   - `GUILD_ID` – identifiant de guilde pour un enregistrement local des commandes (laisser vide pour global).
   - `SCRIMS_CHANNEL_ID` – salon texte où les threads privés de scrim seront créés.
   - `ARBITRATION_CHANNEL_ID` – salon privé #ref-queue pour les cartes d'arbitrage.
   - `MOD_ROLE_ID` – rôle staff utilisé pour les notifications système.
3. Les données persistées sont stockées dans `src/data/*.json`. Chaque fichier est créé automatiquement au démarrage.

## Enregistrement des commandes slash
Le script `register-commands` publie la configuration actuelle vers Discord.

```bash
# Commandes globales (propagation plus lente)
npm run register-commands

# Commandes limitées à une guilde (si GUILD_ID défini)
GUILD_ID=1234567890 npm run register-commands
```

> 💡 Pour un premier test, utilisez un identifiant de guilde afin de disposer des commandes instantanément.

## Développement
- Lancer le bot en mode développement (recharge à chaud via `tsx`) :
  ```bash
  npm run dev
  ```
- Compiler le code TypeScript dans `dist/` :
  ```bash
  npm run build
  ```
- Vérifier les types :
  ```bash
  npm run typecheck
  ```
- Vérifier le linting ESLint + Prettier :
  ```bash
  npm run lint
  ```
- Formater le code :
  ```bash
  npm run format
  ```

## Lancement en production
```bash
npm run build
node dist/index.js
```
Assurez-vous que la variable `DISCORD_TOKEN` est définie dans l'environnement de production.

## Structure du projet
```
src/
  index.ts              # point d'entrée du bot
  commands/             # commandes slash (org, team, members, scrims, ladders, arbitrage…)
  lib/                  # utilitaires LoL, persistance JSON, fiabilité, planification…
  data/                 # stockage JSON (orgs, teams, members, scrims, ladders, arbitrage)
scripts/                # scripts auxiliaires (enregistrement des commandes)
```

## Documentation fonctionnelle
Les règles détaillées (catégories LoL, calcul SR, process scrim/ladder, arbitrage, pénalités) sont décrites dans [GUIDE-LOL.md](GUIDE-LOL.md).

## Tests rapides
Avant de pousser une modification, vérifier au minimum :
```bash
npm run typecheck
npm run lint
```
