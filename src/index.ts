import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

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
  const tag = client.user?.tag ?? 'inconnu';
  console.log(`✅ Bot connecté en tant que ${tag}`);
});

client.on('error', (error) => {
  console.error('Erreur côté client Discord :', error);
});

client
  .login(token)
  .catch((error) => {
    console.error('Échec de connexion au bot Discord :', error);
    process.exitCode = 1;
  });

export type DiscordClient = typeof client;
export default client;
