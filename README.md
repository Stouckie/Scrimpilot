# ScrimPilot LoL

Bot Discord pour la gestion de scrims et ladders League of Legends.

## Prérequis

- Node.js 22.x (voir `.nvmrc`)
- npm 10+

## Installation

```bash
npm install
```

## Développement

Lance le bot en mode développement (recharge à chaud via `tsx`).

```bash
npm run dev
```

Compile le code TypeScript dans `dist/` :

```bash
npm run build
```

Vérifie les types :

```bash
npm run typecheck
```

Analyse lint (ESLint + Prettier) :

```bash
npm run lint
```

Formate les fichiers pris en charge :

```bash
npm run format
```

## Enregistrement des commandes slash

Met à jour les commandes globales ou guildes selon la configuration interne du script.

```bash
npm run register-commands
```

## Variables d'environnement

Copie `.env.example` vers `.env` et renseigne les valeurs correspondantes :

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `GUILD_ID`
- `SCRIMS_CHANNEL_ID`
- `ARBITRATION_CHANNEL_ID`
- `MOD_ROLE_ID`

## Lancement en production

Construis puis exécute le code JavaScript compilé.

```bash
npm run build
node dist/index.js
```

## Structure du projet

```
src/
  index.ts            # point d'entrée du bot
  commands/           # commandes slash (à venir)
  lib/                # utilitaires (à venir)
  data/               # stockage JSON (à venir)
```

Des répertoires additionnels pourront être ajoutés lors des étapes suivantes.
