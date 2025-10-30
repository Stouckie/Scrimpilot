import 'dotenv/config';
import { REST, Routes } from 'discord.js';

import { commandPayloads } from '../src/commands/index.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error('Variables DISCORD_TOKEN et DISCORD_CLIENT_ID requises pour publier les commandes.');
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const route = GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

rest
  .put(route, { body: commandPayloads })
  .then(() => {
    console.log(
      GUILD_ID ? `✅ Commandes mises à jour pour la guilde ${GUILD_ID}.` : '✅ Commandes globales mises à jour.',
    );
  })
  .catch((error) => {
    console.error('❌ Échec lors de la publication des commandes slash :', error);
    process.exitCode = 1;
  });
