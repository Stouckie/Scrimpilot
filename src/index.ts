import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

import { commands } from './commands/index.js';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error('DISCORD_TOKEN manquant dans le fichier .env');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User],
});

client.once('ready', () => {
  console.log(`✅ Bot connecté en tant que ${client.user?.tag ?? 'inconnu'}`);
});

client.on('error', (error) => {
  console.error('Erreur côté client Discord :', error);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) {
    await interaction.reply({ content: '❌ Commande inconnue ou non disponible.', ephemeral: true });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Erreur lors de l’exécution de /${interaction.commandName} :`, error);
    const response = { content: '❌ Une erreur est survenue lors de l’exécution de la commande.', ephemeral: true } as const;
    if (interaction.deferred || interaction.replied) await interaction.followUp(response);
    else await interaction.reply(response);
  }
});

client
  .login(token)
  .catch((error) => {
    console.error('Échec de connexion au bot Discord :', error);
    process.exitCode = 1;
  });

export type DiscordClient = typeof client;
export default client;
