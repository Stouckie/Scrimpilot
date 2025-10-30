import { randomUUID } from 'node:crypto';
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

import { getSkillRatingForRank } from '../lib/lol.js';
import { memberStore, orgStore, teamStore, type LolRank, type LolRole } from '../lib/store.js';
import type { SlashCommand } from './index.js';

const reply = (interaction: ChatInputCommandInteraction, content: string) =>
  interaction.reply({ content, ephemeral: true });

type Handler = (interaction: ChatInputCommandInteraction) => Promise<void>;
interface HandlerMap extends Record<string, Handler> {
  __unknown: string;
}

const createSlashCommand = (builder: SlashCommandBuilder, handlers: HandlerMap): SlashCommand => ({
  data: builder,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const run = handlers[interaction.options.getSubcommand()];
    if (run) await run(interaction);
    else await reply(interaction, handlers.__unknown);
  },
});

const orgHandlers: HandlerMap = {
  __unknown: '❌ Sous-commande organisation inconnue.',
  async create(interaction) {
    const name = interaction.options.getString('nom', true).trim();
    const description = interaction.options.getString('description')?.trim();
    if (!name) return reply(interaction, '❌ Le nom de l’organisation ne peut pas être vide.');
    const timestamp = new Date().toISOString();
    let status: 'ok' | 'duplicate' | 'error' = 'ok';
    let createdId = '';
    await orgStore
      .update((orgs) => {
        if (orgs.some((org) => org.name.toLowerCase() === name.toLowerCase())) {
          status = 'duplicate';
          return orgs;
        }
        const id = randomUUID();
        createdId = id;
        return [
          ...orgs,
          { id, name, description, ownerId: interaction.user.id, createdAt: timestamp, updatedAt: timestamp },
        ];
      })
      .catch((error) => {
        status = 'error';
        console.error('Erreur lors de la création de l’organisation :', error);
      });
    if (status !== 'ok') {
      const message =
        status === 'duplicate'
          ? `⚠️ Une organisation porte déjà le nom “${name}”.`
          : '❌ Impossible de créer l’organisation pour le moment.';
      return reply(interaction, message);
    }
    await reply(interaction, `✅ Organisation “${name}” créée (ID: ${createdId}).`);
  },
};

const teamHandlers: HandlerMap = {
  __unknown: '❌ Sous-commande équipe inconnue.',
  async create(interaction) {
    const name = interaction.options.getString('nom', true).trim();
    const region = interaction.options.getString('region', true);
    if (!name) return reply(interaction, '❌ Le nom de l’équipe ne peut pas être vide.');
    const timestamp = new Date().toISOString();
    let status: 'ok' | 'duplicate' | 'error' = 'ok';
    let createdId = '';
    await teamStore
      .update((teams) => {
        if (teams.some((team) => team.name.toLowerCase() === name.toLowerCase())) {
          status = 'duplicate';
          return teams;
        }
        const id = randomUUID();
        createdId = id;
        return [
          ...teams,
          {
            id,
            name,
            region,
            members: [],
            reliability: 100,
            captainId: interaction.user.id,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ];
      })
      .catch((error) => {
        status = 'error';
        console.error('Erreur lors de la création de l’équipe :', error);
      });
    if (status !== 'ok') {
      const message =
        status === 'duplicate'
          ? `⚠️ Une équipe porte déjà le nom “${name}”.`
          : '❌ Impossible de créer l’équipe pour le moment.';
      return reply(interaction, message);
    }
    await reply(interaction, `✅ Équipe “${name}” créée pour ${region}. ID: ${createdId}.`);
  },
};

const ROLE_CHOICES = ['top', 'jg', 'mid', 'adc', 'sup', 'coach'] as const satisfies LolRole[];
const RANK_CHOICES = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'] as const satisfies LolRank[];
const REGION_CHOICES = ['EUW', 'EUNE', 'NA', 'KR', 'LAN', 'LAS', 'OCE', 'BR', 'TR'] as const;

const memberHandlers: HandlerMap = {
  __unknown: '❌ Sous-commande membre inconnue.',
  async add(interaction) {
    const user = interaction.options.getUser('joueur', true);
    const role = interaction.options.getString('role', true) as LolRole;
    const rank = interaction.options.getString('rang', true) as LolRank;
    const sr = getSkillRatingForRank(rank);
    const timestamp = new Date().toISOString();
    let created = false;
    await memberStore.update((members) => {
      const index = members.findIndex((member) => member.discordId === user.id);
      if (index >= 0) {
        return members.map((member, position) =>
          position === index
            ? {
                ...member,
                role,
                rank,
                sr,
                isCoach: role === 'coach',
                updatedAt: timestamp,
              }
            : member,
        );
      }
      created = true;
      return [
        ...members,
        { id: user.id, discordId: user.id, role, rank, sr, isCoach: role === 'coach', createdAt: timestamp, updatedAt: timestamp },
      ];
    });
    await reply(interaction, `✅ Profil LoL ${created ? 'créé' : 'mis à jour'} pour ${user.tag} (${role.toUpperCase()} • ${rank.toUpperCase()} • SR ${sr}).`);
  },
  async 'link-riot'(interaction) {
    const user = interaction.options.getUser('joueur', true);
    const riotId = interaction.options.getString('riot_id', true).trim();
    if (!riotId.includes('#')) return reply(interaction, '❌ Le Riot ID doit suivre le format Nom#TAG.');
    const timestamp = new Date().toISOString();
    let updated = false;
    await memberStore.update((members) =>
      members.map((member) => {
        if (member.discordId !== user.id) return member;
        updated = true;
        return { ...member, riotId, updatedAt: timestamp };
      }),
    );
    if (!updated) return reply(interaction, '⚠️ Aucun profil LoL trouvé pour ce joueur. Utilise `/member add` avant de lier un Riot ID.');
    await reply(interaction, `✅ Riot ID mis à jour pour ${user.tag} : ${riotId}.`);
  },
};

const orgCommand = new SlashCommandBuilder()
  .setName('org')
  .setDescription('Gestion des organisations LoL')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Créer une nouvelle organisation LoL')
      .addStringOption((option) => option.setName('nom').setDescription("Nom officiel de l’organisation").setRequired(true))
      .addStringOption((option) => option.setName('description').setDescription('Présentation brève')),
  );

const teamCommand = new SlashCommandBuilder()
  .setName('team')
  .setDescription('Gestion des équipes LoL')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Créer une nouvelle équipe LoL')
      .addStringOption((option) => option.setName('nom').setDescription("Nom compétitif de l’équipe").setRequired(true))
      .addStringOption((option) =>
        option
          .setName('region')
          .setDescription('Région League of Legends')
          .setRequired(true)
          .setChoices(...REGION_CHOICES.map((code) => ({ name: code, value: code }))),
      ),
  );

const memberCommand = new SlashCommandBuilder()
  .setName('member')
  .setDescription('Gestion des membres LoL')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Ajouter ou mettre à jour un joueur LoL')
      .addUserOption((option) => option.setName('joueur').setDescription('Joueur Discord à enregistrer').setRequired(true))
      .addStringOption((option) =>
        option
          .setName('role')
          .setDescription('Rôle principal LoL')
          .setRequired(true)
          .setChoices(...ROLE_CHOICES.map((value) => ({ name: value.toUpperCase(), value }))),
      )
      .addStringOption((option) =>
        option
          .setName('rang')
          .setDescription('Rang LoL actuel')
          .setRequired(true)
          .setChoices(...RANK_CHOICES.map((value) => ({ name: value.toUpperCase(), value }))),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('link-riot')
      .setDescription('Associer un Riot ID à un joueur Discord')
      .addUserOption((option) => option.setName('joueur').setDescription('Joueur Discord à mettre à jour').setRequired(true))
      .addStringOption((option) => option.setName('riot_id').setDescription('Identifiant Riot (Nom#TAG)').setRequired(true)),
  );

export const basicCommands: SlashCommand[] = [
  createSlashCommand(orgCommand, orgHandlers),
  createSlashCommand(teamCommand, teamHandlers),
  createSlashCommand(memberCommand, memberHandlers),
];
