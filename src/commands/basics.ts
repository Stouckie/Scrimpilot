import { randomUUID } from 'node:crypto';
import { SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder, type ChatInputCommandInteraction } from 'discord.js';

import { computeTeamSRTrimmed, getSkillRatingForRank } from '../lib/lol.js';
import { formatCooldown, isTeamOnCooldown } from '../lib/reliability.js';
import {
  ladderStore,
  memberStore,
  orgStore,
  teamStore,
  type Ladder,
  type LadderEntry,
  type LadderMatch,
  type LolRank,
  type LolRole,
  type Member,
  type QueueLevel,
  type ScrimReport,
  type ScrimStatus,
  type ScrimCategory,
  type Team,
} from '../lib/store.js';
import { createLadderArbitrationTicket } from '../lib/arbitration.js';
import type { SlashCommand } from './index.js';

const reply = async (interaction: ChatInputCommandInteraction, content: string) => {
  await interaction.reply({ content, ephemeral: true });
};

type Handler = (interaction: ChatInputCommandInteraction) => Promise<void>;
type HandlerMap = Record<string, Handler>;

const createSlashCommand = (
  builder: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder,
  handlers: HandlerMap,
  fallback: string,
): SlashCommand => ({
  data: builder as SlashCommandBuilder,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const sub = interaction.options.getSubcommand(false);
    const run = sub ? handlers[sub] : undefined;
    if (run) await run(interaction);
    else await reply(interaction, fallback);
  },
});

const orgHandlers: HandlerMap = {
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

const reliabilityHandlers: HandlerMap = {
  async show(interaction) {
    const teamId = interaction.options.getString('team', true).trim();
    const teams = await teamStore.read();
    const team = teams.find(
      (entry) => entry.id === teamId || entry.name.toLowerCase() === teamId.toLowerCase(),
    );
    if (!team)
      return reply(
        interaction,
        '❌ Équipe introuvable. Utilise l’identifiant exact (via /team create ou /ladder join).',
      );
    const cooldownActive = isTeamOnCooldown(team);
    const cooldownText = team.scrimCooldownUntil
      ? cooldownActive
        ? `⏳ Cooldown scrim actif jusqu’au ${formatCooldown(team) ?? team.scrimCooldownUntil}.`
        : '✅ Aucun cooldown actif (le dernier délai est expiré).'
      : '✅ Aucun cooldown actif.';
    await reply(
      interaction,
      `📊 Fiabilité ${team.name} : ${Math.round(team.reliability)} / 100.\n${cooldownText}`,
    );
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

const LADDER_CATEGORY_CHOICES: readonly [string, ScrimCategory][] = [
  ['IB', 'IB'],
  ['SG', 'SG'],
  ['PE', 'PE'],
  ['DM', 'DM'],
  ['GMC', 'GMC'],
];
const CATEGORY_TO_LEVEL: Record<ScrimCategory, QueueLevel> = {
  IB: 'Open',
  SG: 'Open',
  PE: 'Open',
  DM: 'Academy',
  GMC: 'Pro',
};
const FINAL_LADDER_STATUSES = new Set<ScrimStatus>([
  'VALIDATED',
  'DISQUALIFIED',
  'NO_SHOW',
  'CANCELLED',
  'COMPLETED',
  'REFUSED',
]);
const SCORE_REGEX = /^A(\d+)-B(\d+)$/i;

const normalizeScoreInput = (score: string) => {
  const match = score.trim().toUpperCase().match(SCORE_REGEX);
  if (!match) return undefined;
  const [hostRaw, guestRaw] = match.slice(1).map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(hostRaw) || !Number.isFinite(guestRaw) || hostRaw > 5 || guestRaw > 5) return undefined;
  return `A${hostRaw}-B${guestRaw}`;
};

const ensureStaffRole = async (interaction: ChatInputCommandInteraction, actionLabel: string): Promise<boolean> => {
  const roleId = process.env.MOD_ROLE_ID;
  if (!roleId) return true;
  const roles = (interaction.member as { roles?: unknown } | null)?.roles;
  const hasRole = Array.isArray(roles)
    ? roles.includes(roleId)
    : Boolean((roles as { cache?: Map<string, unknown> })?.cache?.has?.(roleId));
  if (hasRole) return true;
  await reply(interaction, `❌ ${actionLabel} réservé au staff.`);
  return false;
};

const findCaptainTeam = async (userId: string): Promise<Team | undefined> => (await teamStore.read()).find((team) => team.captainId === userId);

const buildTeamSrValues = (team: Team, members: Member[]) => {
  const srValues: number[] = [];
  const missing: string[] = [];
  for (const slot of team.members) {
    if (slot.role === 'coach') continue;
    const member = members.find((candidate) => candidate.id === slot.playerId || candidate.discordId === slot.playerId);
    if (!member) {
      missing.push(slot.playerId);
      continue;
    }
    const sr = Number.isFinite(slot.sr) ? slot.sr : member.sr;
    srValues.push(sr);
  }
  return {
    srValues,
    missing,
  };
};

const parseScore = (score: string) => {
  const normalized = normalizeScoreInput(score);
  if (!normalized) return undefined;
  const [, host, guest] = /^A(\d+)-B(\d+)$/.exec(normalized) ?? [];
  if (host === undefined || guest === undefined) return undefined;
  return { normalized, host: Number.parseInt(host, 10), guest: Number.parseInt(guest, 10) } as const;
};

const computeMatchmakingScore = (a: LadderEntry, b: LadderEntry) => {
  const ratingDelta = Math.abs(a.rating - b.rating);
  const reliabilityDelta = Math.abs(a.reliability - b.reliability) / 10;
  return ratingDelta + reliabilityDelta;
};

const ladderHandlers: HandlerMap = {
  async create(interaction) {
    if (!(await ensureStaffRole(interaction, 'Création de ladder'))) return;
    const name = interaction.options.getString('nom', true).trim();
    const category = interaction.options.getString('categorie', true) as ScrimCategory;
    const region = interaction.options.getString('region', true);
    if (!name) return reply(interaction, '❌ Le nom du ladder ne peut pas être vide.');
    const timestamp = new Date().toISOString();
    const level = CATEGORY_TO_LEVEL[category] ?? 'Open';
    let status: 'ok' | 'duplicate' | 'error' = 'ok';
    let createdId = '';
    await ladderStore
      .update((ladders) => {
        if (ladders.some((ladder) => ladder.name.toLowerCase() === name.toLowerCase())) {
          status = 'duplicate';
          return ladders;
        }
        const id = randomUUID();
        createdId = id;
        const record: Ladder = {
          id,
          name,
          category,
          region,
          level,
          status: 'ACTIVE',
          entries: [],
          matches: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        return [...ladders, record];
      })
      .catch((error) => {
        status = 'error';
        console.error('Erreur lors de la création du ladder :', error);
      });
    if (status !== 'ok') {
      const message =
        status === 'duplicate'
          ? `⚠️ Un ladder porte déjà le nom “${name}”.`
          : '❌ Impossible de créer le ladder pour le moment.';
      return reply(interaction, message);
    }
    await reply(interaction, `✅ Ladder “${name}” créé (${category} • ${region}). ID : ${createdId}.`);
  },
  async join(interaction) {
    const ladderId = interaction.options.getString('ladder_id', true).trim();
    const ladders = await ladderStore.read();
    const ladder = ladders.find((entry) => entry.id === ladderId);
    if (!ladder) return reply(interaction, '❌ Ladder introuvable.');
    if (ladder.status !== 'ACTIVE') return reply(interaction, '⚠️ Ce ladder n’est pas actif pour le moment.');
    const team = await findCaptainTeam(interaction.user.id);
    if (!team) return reply(interaction, '⚠️ Tu dois être capitaine d’une équipe pour rejoindre un ladder.');
    if (team.region !== ladder.region)
      return reply(interaction, `⚠️ Ce ladder est réservé à la région ${ladder.region}. Ton équipe est déclarée sur ${team.region}.`);
    const members = await memberStore.read();
    const { srValues, missing } = buildTeamSrValues(team, members);
    if (missing.length > 0)
      return reply(
        interaction,
        `⚠️ Impossible de rejoindre : joueurs introuvables (${missing.join(', ')}). Mets à jour ton roster avant de réessayer.`,
      );
    if (srValues.length < 5)
      return reply(interaction, '⚠️ Minimum 5 titulaires enregistrés requis pour rejoindre un ladder.');

    const timestamp = new Date().toISOString();
    let status: 'ok' | 'exists' | 'error' = 'ok';
    await ladderStore
      .update((collection) =>
        collection.map((record) => {
          if (record.id !== ladder.id) return record;
          if (record.entries.some((entry) => entry.teamId === team.id)) {
            status = 'exists';
            return record;
          }
          const entry: LadderEntry = {
            teamId: team.id,
            rating: 1000,
            reliability: team.reliability ?? 100,
            wins: 0,
            losses: 0,
          };
          return { ...record, entries: [...record.entries, entry], updatedAt: timestamp };
        }),
      )
      .catch((error) => {
        status = 'error';
        console.error('Erreur lors de l’inscription ladder :', error);
      });
    if (status !== 'ok') {
      const message =
        status === 'exists'
          ? '⚠️ Ton équipe est déjà inscrite sur ce ladder.'
          : '❌ Inscription au ladder impossible pour le moment.';
      return reply(interaction, message);
    }
    await reply(interaction, `✅ ${team.name} rejoint le ladder ${ladder.name}. Elo initial : 1000.`);
  },
  async queue(interaction) {
    const ladderId = interaction.options.getString('ladder_id', true).trim();
    const ladders = await ladderStore.read();
    const ladder = ladders.find((entry) => entry.id === ladderId);
    if (!ladder) return reply(interaction, '❌ Ladder introuvable.');
    if (ladder.status !== 'ACTIVE') return reply(interaction, '⚠️ Ce ladder est actuellement en pause.');
    const team = await findCaptainTeam(interaction.user.id);
    if (!team) return reply(interaction, '⚠️ Tu dois être capitaine d’une équipe pour utiliser la file ladder.');
    const entry = ladder.entries.find((candidate) => candidate.teamId === team.id);
    if (!entry)
      return reply(interaction, `⚠️ ${team.name} n’est pas inscrit sur ce ladder. Utilise /ladder join avant de faire la queue.`);

    const activeMatch = ladder.matches.find(
      (match) =>
        (match.hostTeamId === team.id || match.guestTeamId === team.id) && !FINAL_LADDER_STATUSES.has(match.status),
    );
    if (activeMatch) return reply(interaction, '⚠️ Un match ladder est déjà en cours ou en arbitrage pour ton équipe.');

    const members = await memberStore.read();
    const { srValues, missing } = buildTeamSrValues(team, members);
    if (missing.length > 0)
      return reply(
        interaction,
        `⚠️ Impossible de rejoindre la file : joueurs introuvables (${missing.join(', ')}). Mets à jour ton roster.`,
      );
    if (srValues.length < 5)
      return reply(interaction, '⚠️ Minimum 5 titulaires enregistrés requis pour lancer un match ladder.');
    const teamSr = computeTeamSRTrimmed(srValues);

    const now = new Date().toISOString();
    const queuedOpponents = ladder.entries.filter(
      (candidate) => candidate.teamId !== team.id && Boolean(candidate.lastQueuedAt),
    );
    const opponent = queuedOpponents.reduce<LadderEntry | undefined>((best, current) => {
      if (!best) return current;
      return computeMatchmakingScore(entry, current) < computeMatchmakingScore(entry, best) ? current : best;
    }, undefined);

    if (!opponent) {
      await ladderStore.update((collection) =>
        collection.map((record) =>
          record.id === ladder.id
            ? {
                ...record,
                entries: record.entries.map((candidate) =>
                  candidate.teamId === team.id ? { ...candidate, lastQueuedAt: now } : candidate,
                ),
                updatedAt: now,
              }
            : record,
        ),
      );
      await reply(
        interaction,
        `✅ ${team.name} rejoint la file du ladder ${ladder.name} (SR équipe ${teamSr.toFixed(1)}). Nous cherchons un adversaire…`,
      );
      return;
    }

    const opponentTeam = (await teamStore.read()).find((candidate) => candidate.id === opponent.teamId);
    const opponentName = opponentTeam?.name ?? opponent.teamId;
    const hostIsOpponent = opponent.lastQueuedAt && entry.lastQueuedAt ? opponent.lastQueuedAt <= entry.lastQueuedAt : true;
    const hostTeamId = hostIsOpponent ? opponent.teamId : team.id;
    const guestTeamId = hostIsOpponent ? team.id : opponent.teamId;

    const matchId = randomUUID();
    const match: LadderMatch = {
      id: matchId,
      ladderId: ladder.id,
      hostTeamId,
      guestTeamId,
      queueLevel: ladder.level,
      scheduledAt: now,
      status: 'CONFIRMED',
      reports: [],
      result: undefined,
      arbitrationTicketId: undefined,
      completedAt: undefined,
      createdAt: now,
      updatedAt: now,
    };

    await ladderStore.update((collection) =>
      collection.map((record) => {
        if (record.id !== ladder.id) return record;
        return {
          ...record,
          entries: record.entries.map((candidate) =>
            candidate.teamId === team.id || candidate.teamId === opponent.teamId
              ? { ...candidate, lastQueuedAt: undefined }
              : candidate,
          ),
          matches: [...record.matches, match],
          updatedAt: now,
        };
      }),
    );

    await reply(
      interaction,
      `✅ Match trouvé : ${team.name} affrontera ${opponentName} (SR ${teamSr.toFixed(1)}). Organisez la rencontre et utilisez /ladder report pour déclarer le score.`,
    );
  },
  async report(interaction) {
    const matchId = interaction.options.getString('match_id', true).trim();
    const rawScore = interaction.options.getString('score', true).trim();
    const victoryUrl = interaction.options.getString('victory_proof', true).trim();
    const scoreboardUrl = interaction.options.getString('scoreboard_proof', true).trim();
    const parsed = parseScore(rawScore);
    if (!parsed) return reply(interaction, '❌ Score invalide. Utilise le format A1-B0 (valeurs 0 à 5).');

    const ladders = await ladderStore.read();
    const ladder = ladders.find((entry) => entry.matches.some((match) => match.id === matchId));
    if (!ladder) return reply(interaction, '❌ Match ladder introuvable.');
    const match = ladder.matches.find((entry) => entry.id === matchId);
    if (!match) return reply(interaction, '❌ Match ladder introuvable.');
    if (FINAL_LADDER_STATUSES.has(match.status))
      return reply(interaction, '⚠️ Ce match a déjà été clôturé ou annulé.');

    const teams = await teamStore.read();
    const hostTeam = teams.find((team) => team.id === match.hostTeamId);
    const guestTeam = teams.find((team) => team.id === match.guestTeamId);
    if (!hostTeam || !guestTeam)
      return reply(interaction, '❌ Impossible de retrouver les équipes associées à ce match ladder.');

    const reporterTeam = [hostTeam, guestTeam].find((team) => team.captainId === interaction.user.id);
    if (!reporterTeam) return reply(interaction, '❌ Seuls les capitaines des équipes engagées peuvent reporter ce match.');

    const timestamp = new Date().toISOString();
    const report: ScrimReport = {
      teamId: reporterTeam.id,
      reportedBy: interaction.user.id,
      score: parsed.normalized,
      submittedAt: timestamp,
      victoryProofUrl: victoryUrl,
      scoreboardProofUrl: scoreboardUrl,
    };
    const reports = [
      ...(match.reports ?? []).filter((entry) => entry.teamId !== reporterTeam.id),
      report,
    ];
    const hostReport = reports.find((entry) => entry.teamId === match.hostTeamId);
    const guestReport = reports.find((entry) => entry.teamId === match.guestTeamId);
    const readyForArb = Boolean(hostReport && guestReport);
    const conflict = readyForArb && hostReport!.score !== guestReport!.score;
    const nextStatus: ScrimStatus = readyForArb ? 'AWAITING_ARBITRATION' : match.status;

    let nextMatch: LadderMatch = {
      ...match,
      reports,
      status: nextStatus,
      updatedAt: timestamp,
    };

    if (readyForArb && !nextMatch.arbitrationTicketId) {
      try {
        const ticket = await createLadderArbitrationTicket({
          client: interaction.client,
          ladder,
          match: nextMatch,
          hostTeam,
          guestTeam,
          reports,
          conflict,
        });
        nextMatch = { ...nextMatch, arbitrationTicketId: ticket.id };
      } catch (error) {
        console.error('Erreur lors de la création du ticket ladder :', error);
        return reply(
          interaction,
          '❌ Rapport reçu mais impossible de créer le ticket d’arbitrage. Merci de contacter le staff.',
        );
      }
    }

    await ladderStore.update((collection) =>
      collection.map((entry) =>
        entry.id === ladder.id
          ? {
              ...entry,
              matches: entry.matches.map((record) => (record.id === match.id ? nextMatch : record)),
              updatedAt: timestamp,
            }
          : entry,
      ),
    );

    if (readyForArb)
      await reply(
        interaction,
        conflict
          ? '⚠️ Rapport enregistré. Les scores divergent, un arbitre va examiner les preuves.'
          : '✅ Rapports alignés. En attente de validation par l’arbitrage.',
      );
    else
      await reply(
        interaction,
        '✅ Rapport enregistré. En attente de la déclaration de l’équipe adverse pour lancer l’arbitrage.',
      );
  },
  async leaderboard(interaction) {
    const ladderId = interaction.options.getString('ladder_id', true).trim();
    const ladder = (await ladderStore.read()).find((entry) => entry.id === ladderId);
    if (!ladder) return reply(interaction, '❌ Ladder introuvable.');
    if (ladder.entries.length === 0)
      return reply(interaction, `ℹ️ Aucun classement disponible pour ${ladder.name} pour le moment.`);
    const teams = await teamStore.read();
    const sorted = [...ladder.entries].sort((a, b) => b.rating - a.rating).slice(0, 10);
    const lines = sorted.map((entry, index) => {
      const teamName = teams.find((team) => team.id === entry.teamId)?.name ?? entry.teamId;
      return `${index + 1}. ${teamName} — ${entry.rating.toFixed(0)} Elo (W${entry.wins} / L${entry.losses})`;
    });
    await reply(interaction, `🏆 Leaderboard ${ladder.name}\n${lines.join('\n')}`);
  },
  async seasonclose(interaction) {
    if (!(await ensureStaffRole(interaction, 'Reset de saison'))) return;
    const ladderId = interaction.options.getString('ladder_id', true).trim();
    const timestamp = new Date().toISOString();
    let found = false;
    await ladderStore.update((collection) =>
      collection.map((entry) => {
        if (entry.id !== ladderId) return entry;
        found = true;
        return {
          ...entry,
          entries: entry.entries.map((record) => ({
            ...record,
            rating: 1000,
            wins: 0,
            losses: 0,
            lastQueuedAt: undefined,
          })),
          updatedAt: timestamp,
        };
      }),
    );
    if (!found) return reply(interaction, '❌ Ladder introuvable.');
    await reply(interaction, '✅ Saison réinitialisée : Elo de base 1000 pour toutes les équipes.');
  },
};

const ladderCommand = new SlashCommandBuilder()
  .setName('ladder')
  .setDescription('Gestion des ladders LoL')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Créer un ladder LoL')
      .addStringOption((option) => option.setName('nom').setDescription('Nom du ladder').setRequired(true))
      .addStringOption((option) =>
        option
          .setName('categorie')
          .setDescription('Catégorie de jeu')
          .setRequired(true)
          .setChoices(...LADDER_CATEGORY_CHOICES.map(([name, value]) => ({ name, value }))),
      )
      .addStringOption((option) =>
        option
          .setName('region')
          .setDescription('Région LoL couverte')
          .setRequired(true)
          .setChoices(...REGION_CHOICES.map((code) => ({ name: code, value: code }))),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('join')
      .setDescription('Inscrire son équipe sur un ladder')
      .addStringOption((option) => option.setName('ladder_id').setDescription('Identifiant du ladder').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('queue')
      .setDescription('Placer son équipe en file ladder')
      .addStringOption((option) => option.setName('ladder_id').setDescription('Identifiant du ladder').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('report')
      .setDescription('Reporter le résultat d’un match ladder')
      .addStringOption((option) => option.setName('match_id').setDescription('Identifiant du match ladder').setRequired(true))
      .addStringOption((option) => option.setName('score').setDescription('Score au format A1-B0').setRequired(true))
      .addStringOption((option) =>
        option.setName('victory_proof').setDescription('URL de la preuve victoire/défaite').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('scoreboard_proof').setDescription('URL de la preuve scoreboard').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('Afficher le top 10 d’un ladder')
      .addStringOption((option) => option.setName('ladder_id').setDescription('Identifiant du ladder').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('seasonclose')
      .setDescription('Réinitialiser les Elo d’un ladder (staff)')
      .addStringOption((option) => option.setName('ladder_id').setDescription('Identifiant du ladder').setRequired(true)),
  );

const reliabilityCommand = new SlashCommandBuilder()
  .setName('reliability')
  .setDescription('Suivi de la fiabilité des équipes LoL')
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('Afficher la fiabilité d’une équipe')
      .addStringOption((option) =>
        option
          .setName('team')
          .setDescription('Identifiant (ou nom exact) de l’équipe')
          .setRequired(true),
      ),
  );

export const basicCommands: SlashCommand[] = [
  createSlashCommand(orgCommand, orgHandlers, '❌ Sous-commande organisation inconnue.'),
  createSlashCommand(teamCommand, teamHandlers, '❌ Sous-commande équipe inconnue.'),
  createSlashCommand(memberCommand, memberHandlers, '❌ Sous-commande membre inconnue.'),
  createSlashCommand(ladderCommand, ladderHandlers, '❌ Sous-commande ladder inconnue.'),
  createSlashCommand(reliabilityCommand, reliabilityHandlers, '❌ Sous-commande fiabilité inconnue.'),
];
