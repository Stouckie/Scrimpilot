import { randomUUID } from 'node:crypto';
import {
  ChannelType,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type AnyThreadChannel,
  type TextBasedChannel,
  type TextChannel,
} from 'discord.js';

import { createScrimArbitrationTicket } from '../lib/arbitration.js';
import { computeTeamSRTrimmed, isMatchupBalanced, validateRosterBalance } from '../lib/lol.js';
import { CHECK_IN_EMOJI, CHECK_IN_REQUIRED } from '../lib/scrim-checkin.js';
import { cancelScrimReminders, registerScrimReminders } from '../lib/scrim-scheduler.js';
import { applyReliabilityChange, formatCooldown, isTeamOnCooldown } from '../lib/reliability.js';
import {
  memberStore,
  scrimStore,
  teamStore,
  type Member,
  type QueueLevel,
  type Scrim,
  type ScrimStatus,
  type ScrimCategory,
  type ScrimRoster,
  type ScrimReport,
  type Team,
} from '../lib/store.js';
import type { SlashCommand } from './index.js';

type Handler = (interaction: ChatInputCommandInteraction) => Promise<void>;
type HandlerMap = Record<string, Handler>;
interface RosterBuildResult { roster: ScrimRoster; players: Member[]; coaches: Member[]; srValues: number[]; missing: string[]; }

const CATEGORY_CHOICES: readonly [string, ScrimCategory][] = [['IB', 'IB'], ['SG', 'SG'], ['PE', 'PE'], ['DM', 'DM'], ['GMC', 'GMC']];
const PRESET_CHOICES = [{ name: 'Open Quick', value: 'open_quick' }, { name: 'ERL Block', value: 'erl_block' }];
const CATEGORY_TO_LEVEL: Record<ScrimCategory, QueueLevel> = { IB: 'Open', SG: 'Open', PE: 'Open', DM: 'Academy', GMC: 'Pro' };
const MESSAGE_URL_REGEX =
  /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/i;
const SCORE_REGEX = /^A(\d+)-B(\d+)$/i;
const REPORTABLE_STATUSES = new Set<ScrimStatus>(['CONFIRMED', 'PRACTICE', 'AWAITING_ARBITRATION']);
const reply = async (interaction: ChatInputCommandInteraction, content: string) => {
  await interaction.reply({ content, ephemeral: true });
};
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
const parseMessageUrl = (value: string) => {
  const match = value.match(MESSAGE_URL_REGEX);
  if (!match) return undefined;
  const [, guildId, channelId, messageId] = match;
  return { guildId, channelId, messageId } as const;
};
const buildMessageUrl = (guildId: string, channelId: string, messageId: string) =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
const normalizeScoreInput = (score: string) => {
  const match = score.trim().toUpperCase().match(SCORE_REGEX);
  if (!match) return undefined;
  const [hostRaw, guestRaw] = match.slice(1).map((value) => Number.parseInt(value, 10));
  if (hostRaw > 5 || guestRaw > 5) return undefined;
  return `A${hostRaw}-B${guestRaw}`;
};
const resolveProofLink = async (
  thread: AnyThreadChannel,
  expectedGuildId: string,
  expectedChannelId: string,
  expectedAuthorId: string,
  rawUrl: string,
  label: string,
) => {
  const parsed = parseMessageUrl(rawUrl);
  if (!parsed)
    return { ok: false as const, message: `❌ ${label} doit être un lien de message Discord valide.` };
  if (parsed.guildId !== expectedGuildId || parsed.channelId !== expectedChannelId)
    return { ok: false as const, message: `❌ ${label} doit provenir du thread privé du scrim.` };
  const message = await thread.messages.fetch(parsed.messageId).catch(() => null);
  if (!message)
    return { ok: false as const, message: `❌ Message introuvable pour ${label}.` };
  if (message.author.id !== expectedAuthorId || message.attachments.size === 0)
    return { ok: false as const, message: `❌ ${label} doit être posté par toi avec au moins une pièce jointe.` };
  return { ok: true as const, url: buildMessageUrl(parsed.guildId, parsed.channelId, parsed.messageId) };
};
const ensureCaptainTeam = async (userId: string): Promise<Team | undefined> => (await teamStore.read()).find((team) => team.captainId === userId);
const buildTeamRoster = (team: Team, members: Member[]): RosterBuildResult => {
  const players: Member[] = [];
  const coaches: Member[] = [];
  const srValues: number[] = [];
  const missing: string[] = [];
  for (const slot of team.members) {
    const member = members.find((candidate) => candidate.id === slot.playerId || candidate.discordId === slot.playerId);
    if (!member) {
      missing.push(slot.playerId);
      continue;
    }
    const sr = Number.isFinite(slot.sr) ? slot.sr : member.sr;
    srValues.push(sr);
    (slot.role === 'coach' || member.isCoach ? coaches : players).push(member);
  }
  return {
    roster: { teamId: team.id, playerIds: players.map((player) => player.id), coachIds: coaches.map((coach) => coach.id), declaredSr: srValues.length > 0 ? computeTeamSRTrimmed(srValues) : 0 },
    players,
    coaches,
    srValues,
    missing,
  };
};
const ensureRosterReady = async (
  interaction: ChatInputCommandInteraction,
  team: Team,
  members: Member[],
  action: 'publier' | 'accepter' | 'confirmer',
): Promise<RosterBuildResult | undefined> => {
  const roster = buildTeamRoster(team, members);
  if (roster.missing.length > 0) {
    await reply(interaction, `⚠️ Impossible de ${action} : joueurs introuvables (${roster.missing.join(', ')}). Mets à jour ${team.name}.`);
    return undefined;
  }
  if (roster.players.length < 5) {
    await reply(interaction, `⚠️ ${team.name} doit enregistrer au moins 5 titulaires avant de ${action} un scrim.`);
    return undefined;
  }
  return roster;
};
const fetchScrim = async (scrimId: string): Promise<Scrim | undefined> => {
  const scrims = await scrimStore.read();
  return scrims.find((scrim) => scrim.id === scrimId);
};
const addParticipantsToThread = async (thread: AnyThreadChannel, rosters: RosterBuildResult[]) => {
  const ids = [...new Set(rosters.flatMap((roster) => [...roster.players, ...roster.coaches].map((member) => member.discordId)))];
  await Promise.allSettled(
    ids.map(async (discordId) => {
      try {
        await thread.members.add(discordId);
      } catch (error) {
        console.warn(`Impossible d’ajouter ${discordId} au thread ${thread.id} :`, error);
      }
    }),
  );
};
const formatMember = (member: Member) => `${member.riotId ?? `<@${member.discordId}>`} (${member.role.toUpperCase()})`;
const buildThreadSummary = (scrim: Scrim, hostTeam: Team, guestTeam: Team, hostRoster: RosterBuildResult, guestRoster: RosterBuildResult, hostCheck: ReturnType<typeof validateRosterBalance>, guestCheck: ReturnType<typeof validateRosterBalance>, practiceReason?: string) => {
  const timestamp = Math.floor(new Date(scrim.scheduledAt).getTime() / 1000);
  let summary = [
    `🎯 Scrim ${scrim.id} ${scrim.status === 'PRACTICE' ? '(mode practice)' : ''}`,
    `Catégorie : ${scrim.category} • Préset : ${scrim.preset} • Niveau : ${scrim.queueLevel}`,
    `Horaire : <t:${timestamp}:F> (<t:${timestamp}:R>)`,
    '',
    `Équipe hôte — ${hostTeam.name} : SR ${hostCheck.teamSR.toFixed(1)} (spread ${hostCheck.spread.toFixed(1)})`,
    `Joueurs : ${hostRoster.players.map(formatMember).join(', ') || 'non déclaré'}`,
    `Coachs : ${hostRoster.coaches.map(formatMember).join(', ') || 'aucun'}`,
    '',
    `Équipe invitée — ${guestTeam.name} : SR ${guestCheck.teamSR.toFixed(1)} (spread ${guestCheck.spread.toFixed(1)})`,
    `Joueurs : ${guestRoster.players.map(formatMember).join(', ') || 'non déclaré'}`,
    `Coachs : ${guestRoster.coaches.map(formatMember).join(', ') || 'aucun'}`,
  ].join('\n');
  if (practiceReason) summary += `\n\n⚠️ Garde-fous déclenchés :\n${practiceReason}`;
  return `${summary}\n\nMerci de poster ici :\n• Check-in des deux équipes\n• Screens victoire/défaite + scoreboard\n• Toute info utile pour l’arbitrage`;
};

const scrimHandlers: HandlerMap = {
  async post(interaction) {
    const category = interaction.options.getString('category', true) as ScrimCategory;
    const preset = interaction.options.getString('preset', true);
    const dateInput = interaction.options.getString('date', true).trim();
    const notes = interaction.options.getString('notes')?.trim();
    const scheduledAt = new Date(dateInput);
    if (Number.isNaN(scheduledAt.getTime())) return reply(interaction, '❌ Date invalide. Utilise le format ISO 8601 (ex. 2024-05-18T20:00:00Z).');
    if (scheduledAt.getTime() <= Date.now()) return reply(interaction, '⚠️ La date doit être dans le futur pour publier un scrim.');
    const hostTeam = await ensureCaptainTeam(interaction.user.id);
    if (!hostTeam) return reply(interaction, '⚠️ Aucune équipe dont tu es capitaine trouvée.');
    if (isTeamOnCooldown(hostTeam)) {
      const until = formatCooldown(hostTeam) ?? hostTeam.scrimCooldownUntil ?? 'expiration inconnue';
      return reply(
        interaction,
        `⚠️ ${hostTeam.name} est en cooldown scrim jusqu’au ${until}. Patiente avant de publier un nouveau scrim.`,
      );
    }
    const members = await memberStore.read();
    const hostRoster = await ensureRosterReady(interaction, hostTeam, members, 'publier');
    if (!hostRoster) return;
    const timestamp = new Date().toISOString();
    const scrimId = randomUUID();
    const queueLevel = CATEGORY_TO_LEVEL[category] ?? 'Open';
    const record: Scrim = { id: scrimId, category, preset: preset as Scrim['preset'], queueLevel, scheduledAt: scheduledAt.toISOString(), notes, status: 'POSTED', practiceReason: undefined, hostTeamId: hostTeam.id, guestTeamId: undefined, rosters: [hostRoster.roster], threadId: undefined, arbitrationTicketId: undefined, createdAt: timestamp, updatedAt: timestamp };
    await scrimStore.update((scrims) => [...scrims, record]);
    await reply(
      interaction,
      `✅ Scrim publié pour ${hostTeam.name} (${category}) le <t:${Math.floor(scheduledAt.getTime() / 1000)}:F>. ID : ${scrimId}.`,
    );
  },
  async accept(interaction) {
    const scrimId = interaction.options.getString('post_id', true).trim();
    const scrim = await fetchScrim(scrimId);
    if (!scrim) return reply(interaction, '❌ Aucun scrim avec cet identifiant.');
    if (scrim.status !== 'POSTED') {
      const message = scrim.status === 'ACCEPTED' ? '⚠️ Ce scrim est déjà accepté.' : '⚠️ Ce scrim ne peut plus être accepté.';
      return reply(interaction, message);
    }
    const guestTeam = await ensureCaptainTeam(interaction.user.id);
    if (!guestTeam) return reply(interaction, '⚠️ Aucune équipe dont tu es capitaine trouvée pour accepter.');
    if (guestTeam.id === scrim.hostTeamId) return reply(interaction, '⚠️ Ton équipe est déjà hôte de ce scrim.');
    if (isTeamOnCooldown(guestTeam)) {
      const until = formatCooldown(guestTeam) ?? guestTeam.scrimCooldownUntil ?? 'expiration inconnue';
      return reply(
        interaction,
        `⚠️ ${guestTeam.name} est en cooldown scrim jusqu’au ${until}. Impossible d’accepter pour le moment.`,
      );
    }
    const [teams, members] = await Promise.all([teamStore.read(), memberStore.read()]);
    const hostTeam = teams.find((team) => team.id === scrim.hostTeamId);
    if (!hostTeam) return reply(interaction, '❌ Équipe hôte introuvable.');
    const hostRoster = await ensureRosterReady(interaction, hostTeam, members, 'accepter');
    if (!hostRoster) return;
    const guestRoster = await ensureRosterReady(interaction, guestTeam, members, 'accepter');
    if (!guestRoster) return;
    const timestamp = new Date().toISOString();
    await scrimStore.update((scrims) =>
      scrims.map((match) =>
        match.id === scrim.id
          ? { ...match, guestTeamId: guestTeam.id, status: 'ACCEPTED', rosters: [hostRoster.roster, guestRoster.roster], updatedAt: timestamp }
          : match,
      ),
    );
    await reply(interaction, `✅ ${guestTeam.name} rejoint le scrim ${scrimId}. En attente de confirmation.`);
  },
  async confirm(interaction) {
    const scrimId = interaction.options.getString('match_id', true).trim();
    const scrim = await fetchScrim(scrimId);
    if (!scrim) return reply(interaction, '❌ Aucun scrim avec cet identifiant.');
    if (scrim.status !== 'ACCEPTED') {
      const message = scrim.status === 'CONFIRMED' ? '⚠️ Ce scrim est déjà confirmé.' : '⚠️ Le scrim doit être accepté avant confirmation.';
      return reply(interaction, message);
    }
    if (!scrim.guestTeamId) return reply(interaction, '⚠️ Aucune équipe invitée n’est associée.');
    const guild = interaction.guild;
    if (!guild) return reply(interaction, '❌ La confirmation doit être effectuée depuis un serveur.');
    const scrimsChannelId = process.env.SCRIMS_CHANNEL_ID;
    if (!scrimsChannelId) return reply(interaction, '❌ SCRIMS_CHANNEL_ID manquant dans la configuration.');
    const [teams, members] = await Promise.all([teamStore.read(), memberStore.read()]);
    const hostTeam = teams.find((team) => team.id === scrim.hostTeamId), guestTeam = teams.find((team) => team.id === scrim.guestTeamId);
    if (!hostTeam || !guestTeam) return reply(interaction, '❌ Équipes introuvables.');
    const hostRoster = await ensureRosterReady(interaction, hostTeam, members, 'confirmer');
    if (!hostRoster) return;
    const guestRoster = await ensureRosterReady(interaction, guestTeam, members, 'confirmer');
    if (!guestRoster) return;
    const hostCheck = validateRosterBalance(hostRoster.srValues), guestCheck = validateRosterBalance(guestRoster.srValues);
    const balance = isMatchupBalanced(hostCheck.teamSR, guestCheck.teamSR, scrim.queueLevel);
    const reasons: string[] = [];
    if (hostCheck.practiceRequired) reasons.push(`Roster ${hostTeam.name} : ${hostCheck.reasons.join(' ')}`);
    if (guestCheck.practiceRequired) reasons.push(`Roster ${guestTeam.name} : ${guestCheck.reasons.join(' ')}`);
    if (!balance.balanced)
      reasons.push(`ΔSR ${balance.delta.toFixed(1)} > tolérance ${balance.tolerance.toFixed(1)} (niveau ${scrim.queueLevel}).`);
    const nextStatus: Scrim['status'] = reasons.length > 0 ? 'PRACTICE' : 'CONFIRMED';
    const practiceReason = reasons.length > 0 ? reasons.join('\n') : undefined;
    const channel = await guild.channels.fetch(scrimsChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return reply(interaction, '❌ SCRIMS_CHANNEL_ID doit pointer vers un salon textuel.');
    const threadName = `scrim-${scrim.category.toLowerCase()}-${scrim.id.slice(0, 6)}`;
    let thread: AnyThreadChannel;
    try {
      thread = await (channel as TextChannel).threads.create({
        name: threadName,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        invitable: false,
        reason: `Thread scrim ${scrim.id}`,
      });
    } catch (error) {
      console.error('Erreur de création du thread scrim :', error);
      return reply(interaction, '❌ Impossible de créer le thread privé pour ce scrim.');
    }
    const hostRosterRecord: ScrimRoster = { ...hostRoster.roster, declaredSr: hostCheck.teamSR }, guestRosterRecord: ScrimRoster = { ...guestRoster.roster, declaredSr: guestCheck.teamSR };
    await addParticipantsToThread(thread, [hostRoster, guestRoster]);
    await thread
      .send(
        buildThreadSummary(
          { ...scrim, status: nextStatus, practiceReason },
          hostTeam,
          guestTeam,
          hostRoster,
          guestRoster,
          hostCheck,
          guestCheck,
          practiceReason,
        ),
      )
      .catch((error) => console.error('Erreur lors de l’envoi du briefing de scrim :', error));

    let checkInMessageId: string | undefined;
    try {
      const checkInMessage = await thread.send(
        `📋 Merci de réagir avec ${CHECK_IN_EMOJI} (minimum ${CHECK_IN_REQUIRED} joueurs) pour valider votre présence.`,
      );
      checkInMessageId = checkInMessage.id;
      await checkInMessage.react(CHECK_IN_EMOJI).catch((error) =>
        console.error('Impossible d’ajouter la réaction de check-in :', error),
      );
    } catch (error) {
      console.error('Erreur lors de la publication du message de check-in :', error);
    }
    const timestamp = new Date().toISOString();
    const updatedScrims = await scrimStore.update((scrims) =>
      scrims.map((match) =>
        match.id === scrim.id
          ? {
              ...match,
              status: nextStatus,
              practiceReason,
              threadId: thread.id,
              threadUrl: `https://discord.com/channels/${guild.id}/${thread.id}`,
              rosters: [hostRosterRecord, guestRosterRecord],
              checkInMessageId,
              checkIns: [
                { teamId: hostTeam.id, userIds: [] },
                { teamId: guestTeam.id, userIds: [] },
              ],
              updatedAt: timestamp,
            }
          : match,
      ),
    );
    const updatedScrim = updatedScrims.find((match) => match.id === scrim.id);
    if (updatedScrim) await registerScrimReminders(updatedScrim);
    await reply(
      interaction,
      `✅ Scrim ${scrim.id} ${nextStatus === 'PRACTICE' ? 'confirmé en mode practice' : 'confirmé'}. Thread : <#${thread.id}>.`,
    );
  },
  async report(interaction) {
    const scrimId = interaction.options.getString('match_id', true).trim();
    const rawScore = interaction.options.getString('score', true).trim();
    const victoryUrl = interaction.options.getString('victory_proof', true).trim();
    const scoreboardUrl = interaction.options.getString('scoreboard_proof', true).trim();
    const fail = (message: string) => reply(interaction, message);
    if (!interaction.guildId)
      return fail('❌ Cette commande doit être utilisée dans le serveur où se déroule le scrim.');

    const normalizedScore = normalizeScoreInput(rawScore);
    if (!normalizedScore) return fail('❌ Score invalide. Utilise le format A1-B0 (valeurs entre 0 et 5).');

    const scrim = await fetchScrim(scrimId);
    if (!scrim) return fail('❌ Aucun scrim avec cet identifiant.');
    if (!scrim.guestTeamId)
      return fail('❌ Ce scrim n’a pas encore d’équipe invitée, impossible de reporter.');
    if (!scrim.threadId) return fail('❌ Ce scrim ne possède pas encore de thread privé pour collecter les preuves.');
    if (!REPORTABLE_STATUSES.has(scrim.status))
      return fail('⚠️ Ce scrim ne peut pas être reporté dans son état actuel (annulé, no-show ou non confirmé).');

    const threadChannel = await interaction.client.channels.fetch(scrim.threadId).catch(() => null);
    if (!threadChannel || !('isThread' in threadChannel) || !threadChannel.isThread())
      return fail('❌ Thread privé introuvable ou inaccessible.');
    const thread = threadChannel as AnyThreadChannel;

    const teams = await teamStore.read();
    const hostTeam = teams.find((team) => team.id === scrim.hostTeamId);
    const guestTeam = teams.find((team) => team.id === scrim.guestTeamId);
    if (!hostTeam || !guestTeam) return fail('❌ Impossible de retrouver les équipes associées au scrim.');

    const reporterTeam = teams.find(
      (team) => team.captainId === interaction.user.id && [scrim.hostTeamId, scrim.guestTeamId].includes(team.id),
    );
    if (!reporterTeam) return fail('❌ Seuls les capitaines des équipes engagées peuvent reporter ce scrim.');

    const proofInputs = [
      { url: victoryUrl, label: 'La preuve victoire/défaite' },
      { url: scoreboardUrl, label: 'La preuve scoreboard' },
    ];
    const resolvedProofs: string[] = [];
    for (const { url, label } of proofInputs) {
      const proof = await resolveProofLink(
        thread,
        interaction.guildId,
        scrim.threadId,
        interaction.user.id,
        url,
        label,
      );
      if (!proof.ok) return fail(proof.message);
      resolvedProofs.push(proof.url);
    }
    const [victoryProofUrl, scoreboardProofUrl] = resolvedProofs;

    const timestamp = new Date().toISOString();
    const report: ScrimReport = {
      teamId: reporterTeam.id,
      reportedBy: interaction.user.id,
      score: normalizedScore,
      submittedAt: timestamp,
      victoryProofUrl,
      scoreboardProofUrl,
    };
    const reports = [
      ...(scrim.reports ?? []).filter((entry) => entry.teamId !== reporterTeam.id),
      report,
    ];
    const hostReport = reports.find((entry) => entry.teamId === scrim.hostTeamId);
    const guestReport = reports.find((entry) => entry.teamId === scrim.guestTeamId);
    const hostReported = Boolean(hostReport);
    const guestReported = Boolean(guestReport);
    let nextStatus = scrim.status;
    let readyForArbitration = false;
    let conflict = false;
    if (hostReported && guestReported) {
      conflict = hostReport!.score !== guestReport!.score;
      nextStatus = 'AWAITING_ARBITRATION';
      readyForArbitration = true;
    }

    const snapshot: Scrim = { ...scrim, status: nextStatus, reports, updatedAt: timestamp };
    await scrimStore.update((collection) =>
      collection.map((record) => (record.id === scrim.id ? snapshot : record)),
    );
    if (readyForArbitration) cancelScrimReminders(scrim.id);

    let ticketId = scrim.arbitrationTicketId;
    let ticketCreated = Boolean(ticketId);
    if (readyForArbitration && !ticketId) {
      try {
        const ticket = await createScrimArbitrationTicket({
          client: interaction.client,
          scrim: snapshot,
          hostTeam,
          guestTeam,
          reports,
          conflict,
        });
        ticketId = ticket.id;
        ticketCreated = true;
        const ticketTimestamp = new Date().toISOString();
        await scrimStore.update((collection) =>
          collection.map((record) =>
            record.id === scrim.id
              ? { ...record, arbitrationTicketId: ticket.id, updatedAt: ticketTimestamp }
              : record,
          ),
        );
      } catch (error) {
        console.error('Erreur lors de la création du ticket d’arbitrage :', error);
      }
    }

    const baseMessage = `✅ Rapport enregistré pour ${reporterTeam.name} (${normalizedScore}).`;
    let suffix: string;
    if (readyForArbitration) {
      suffix = ticketCreated
        ? ` Dossier transmis à l’arbitrage${conflict ? ' (scores divergents, un arbitre tranchera).' : '.'}`
        : ' ⚠️ Les preuves sont enregistrées mais la carte d’arbitrage n’a pas pu être créée. Préviens le staff.';
    } else {
      const pendingTeam = reporterTeam.id === scrim.hostTeamId ? guestTeam.name : hostTeam.name;
      suffix = ` En attente du rapport de ${pendingTeam}.`;
    }
    await reply(interaction, `${baseMessage}${suffix}`);

    const threadMessage = readyForArbitration
      ? ticketCreated
        ? `📎 Les deux équipes ont reporté. Ticket d’arbitrage ${ticketId ?? ''} créé.`.trim()
        : '⚠️ Les deux équipes ont reporté mais la carte d’arbitrage n’a pas pu être publiée. Merci de prévenir le staff.'
      : `📎 Rapport reçu pour ${reporterTeam.name}. En attente de l’autre équipe.`;
    await thread
      .send(threadMessage)
      .catch((error: unknown) => console.error('Erreur lors de la notification de report :', error));
  },
  async cancel(interaction) {
    const scrimId = interaction.options.getString('match_id', true).trim();
    const reason = interaction.options.getString('reason', true).trim();
    if (!reason) return reply(interaction, '❌ Merci de préciser une raison d’annulation.');
    const scrim = await fetchScrim(scrimId);
    if (!scrim) return reply(interaction, '❌ Aucun scrim avec cet identifiant.');
    if (scrim.status === 'CANCELLED') return reply(interaction, '⚠️ Ce scrim est déjà annulé.');
    if (scrim.status === 'COMPLETED' || scrim.status === 'NO_SHOW')
      return reply(interaction, '⚠️ Ce scrim est terminé et ne peut plus être annulé.');
    const cancellingTeam = await ensureCaptainTeam(interaction.user.id);
    if (!cancellingTeam) return reply(interaction, '⚠️ Aucune équipe dont tu es capitaine trouvée.');
    if (![scrim.hostTeamId, scrim.guestTeamId].includes(cancellingTeam.id))
      return reply(interaction, '❌ Tu ne peux annuler qu’un scrim où ton équipe est engagée.');

    const scheduledAt = new Date(scrim.scheduledAt).getTime();
    const now = Date.now();
    const timestamp = new Date().toISOString();
    const penaltyApplies = scheduledAt - now < 60 * 60 * 1000;
    await scrimStore.update((scrims) =>
      scrims.map((record) =>
        record.id === scrim.id
          ? {
              ...record,
              status: 'CANCELLED',
              cancellation: { cancelledByTeamId: cancellingTeam.id, reason, cancelledAt: timestamp },
              updatedAt: timestamp,
            }
          : record,
      ),
    );
    const reliabilityPenalty = penaltyApplies
      ? await applyReliabilityChange({ teamId: cancellingTeam.id, delta: -10, timestamp })
      : undefined;
    cancelScrimReminders(scrim.id);

    if (scrim.threadId) {
      const channel = await interaction.client.channels.fetch(scrim.threadId).catch(() => null);
      if (channel && 'isThread' in channel && channel.isThread()) {
        const target = channel as AnyThreadChannel;
        const penaltyNote = penaltyApplies
          ? `Pénalité : -10 fiabilité${
              reliabilityPenalty ? ` (${reliabilityPenalty.previous} → ${reliabilityPenalty.next})` : ''
            } (annulation < 60 min).`
          : 'Aucune pénalité appliquée (annulation anticipée).';
        await target
          .send(
            `🛑 Scrim annulé par ${cancellingTeam.name}. Motif : ${reason}. ${penaltyNote}`,
          )
          .catch((error: unknown) => console.error('Erreur lors de la notification d’annulation :', error));
      }
    }

    await reply(
      interaction,
      `✅ Scrim ${scrim.id} annulé. ${
        penaltyApplies
          ? `Fiabilité ${
              reliabilityPenalty ? `${reliabilityPenalty.previous} → ${reliabilityPenalty.next}` : 'ajustée'
            } (annulation tardive).`
          : 'Aucune pénalité appliquée.'
      }`,
    );
  },
};

const scrimCommand = new SlashCommandBuilder()
  .setName('scrim')
  .setDescription('Gestion des scrims LoL')
  .addSubcommand((sub) =>
    sub
      .setName('post')
      .setDescription('Publier un scrim public')
      .addStringOption((option) =>
        option
          .setName('category')
          .setDescription('Catégorie LoL (IB/SG/PE/DM/GMC)')
          .setRequired(true)
          .setChoices(...CATEGORY_CHOICES.map(([name, value]) => ({ name, value }))),
      )
      .addStringOption((option) =>
        option
          .setName('preset')
          .setDescription('Format proposé (Open Quick ou ERL Block)')
          .setRequired(true)
          .setChoices(...PRESET_CHOICES),
      )
      .addStringOption((option) => option.setName('date').setDescription('Date/heure au format ISO 8601').setRequired(true))
      .addStringOption((option) => option.setName('notes').setDescription('Informations complémentaires (optionnel)')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('accept')
      .setDescription('Accepter un scrim existant')
      .addStringOption((option) => option.setName('post_id').setDescription('Identifiant du scrim publié').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('confirm')
      .setDescription('Confirmer le scrim et créer le thread privé')
      .addStringOption((option) => option.setName('match_id').setDescription('Identifiant du scrim').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('report')
      .setDescription('Reporter le résultat du scrim avec preuves')
      .addStringOption((option) => option.setName('match_id').setDescription('Identifiant du scrim').setRequired(true))
      .addStringOption((option) =>
        option
          .setName('score')
          .setDescription('Score final au format A1-B0 (A = hôte, B = invité)')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('victory_proof')
          .setDescription('Lien du message avec le screen victoire/défaite')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('scoreboard_proof')
          .setDescription('Lien du message avec le screen scoreboard')
          .setRequired(true),
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Annuler un scrim planifié')
      .addStringOption((option) => option.setName('match_id').setDescription('Identifiant du scrim').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Motif détaillé').setRequired(true)),
  );

export const scrimCommands: SlashCommand[] = [
  createSlashCommand(scrimCommand, scrimHandlers, '❌ Sous-commande scrim inconnue.'),
];
