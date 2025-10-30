import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  arbitrationStore,
  ladderStore,
  scrimStore,
  teamStore,
  type ArbitrationTicket,
  type Ladder,
  type LadderEntry,
  type LadderMatch,
  type Scrim,
  type ScrimReport,
  type Team,
} from './store.js';

interface CreateScrimTicketOptions {
  client: Client;
  scrim: Scrim;
  hostTeam: Team;
  guestTeam: Team;
  reports: ScrimReport[];
  conflict: boolean;
}

interface CreateLadderTicketOptions {
  client: Client;
  ladder: Ladder;
  match: LadderMatch;
  hostTeam: Team;
  guestTeam: Team;
  reports: ScrimReport[];
  conflict: boolean;
}
const formatReport = (team: string, report?: ScrimReport) =>
  report
    ? `${team} — score ${report.score}\nVictoire/Défaite : [preuve](${report.victoryProofUrl})\nScoreboard : [preuve](${report.scoreboardProofUrl})${report.note ? `\nNote : ${report.note}` : ''}`
    : `${team} : rapport manquant.`;

const buildButtonRow = (ticketId: string, disabled = false) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`scrim-arb:${ticketId}:validate`).setLabel('Valider').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`scrim-arb:${ticketId}:refuse`).setLabel('Refuser').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`scrim-arb:${ticketId}:needs_info`).setLabel('Demander compléments').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`scrim-arb:${ticketId}:dispute`).setLabel('Ouvrir litige').setStyle(ButtonStyle.Primary).setDisabled(disabled),
  );

export async function createScrimArbitrationTicket(options: CreateScrimTicketOptions): Promise<ArbitrationTicket> {
  const { client, scrim, hostTeam, guestTeam, reports, conflict } = options;
  const channelId = process.env.ARBITRATION_CHANNEL_ID;
  if (!channelId) throw new Error('ARBITRATION_CHANNEL_ID doit être défini pour créer une carte d’arbitrage.');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText)
    throw new Error('ARBITRATION_CHANNEL_ID doit référencer un salon texte accessible.');

  const hostReport = reports.find((entry) => entry.teamId === scrim.hostTeamId);
  const guestReport = reports.find((entry) => entry.teamId === scrim.guestTeamId);
  const ticketId = randomUUID();
  const timestamp = new Date().toISOString();
  const kickoff = Math.floor(new Date(scrim.scheduledAt).getTime() / 1000);
  const embed = new EmbedBuilder({
    title: `Scrim ${scrim.id} à valider`,
    color: conflict ? 0xf59e0b : 0x22c55e,
    description: conflict
      ? '⚠️ Scores divergents déclarés. Merci de vérifier les preuves.'
      : '✅ Scores identiques déclarés. Vérifiez les preuves avant validation.',
    fields: [
      { name: 'Catégorie', value: `${scrim.category} (${scrim.queueLevel})`, inline: true },
      { name: 'Preset', value: scrim.preset, inline: true },
      { name: 'Horaire', value: Number.isNaN(kickoff) ? scrim.scheduledAt : `<t:${kickoff}:F>`, inline: true },
      { name: 'Équipe hôte', value: formatReport(hostTeam.name, hostReport) },
      { name: 'Équipe invitée', value: formatReport(guestTeam.name, guestReport) },
      {
        name: 'Thread',
        value: scrim.threadUrl ?? (scrim.threadId ? `https://discord.com/channels/${channel.guildId}/${scrim.threadId}` : 'N/A'),
      },
    ],
  }).setFooter({ text: `Ticket ${ticketId}` });

  const message = await channel.send({ embeds: [embed], components: [buildButtonRow(ticketId)] }).catch((error) => {
    throw new Error(`Impossible d’envoyer la carte d’arbitrage : ${String(error)}`);
  });
  const ticket: ArbitrationTicket = {
    id: ticketId,
    matchId: scrim.id,
    matchType: 'scrim',
    state: 'PENDING',
    threadId: scrim.threadId,
    evidenceMessageUrls: [
      ...(hostReport ? [hostReport.victoryProofUrl, hostReport.scoreboardProofUrl] : []),
      ...(guestReport ? [guestReport.victoryProofUrl, guestReport.scoreboardProofUrl] : []),
    ],
    queueMessageId: message.id,
    queueChannelId: channelId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await arbitrationStore.update((tickets) => [...tickets, ticket]);
  return ticket;
}

export async function createLadderArbitrationTicket(options: CreateLadderTicketOptions): Promise<ArbitrationTicket> {
  const { client, ladder, match, hostTeam, guestTeam, reports, conflict } = options;
  const channelId = process.env.ARBITRATION_CHANNEL_ID;
  if (!channelId) throw new Error('ARBITRATION_CHANNEL_ID doit être défini pour créer une carte d’arbitrage.');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText)
    throw new Error('ARBITRATION_CHANNEL_ID doit référencer un salon texte accessible.');

  const hostReport = reports.find((entry) => entry.teamId === match.hostTeamId);
  const guestReport = reports.find((entry) => entry.teamId === match.guestTeamId);
  const ticketId = randomUUID();
  const timestamp = new Date().toISOString();
  const kickoff = Math.floor(new Date(match.scheduledAt).getTime() / 1000);
  const embed = new EmbedBuilder({
    title: `Ladder ${ladder.name} — match ${match.id}`,
    color: conflict ? 0xf59e0b : 0x22c55e,
    description: conflict
      ? '⚠️ Scores divergents déclarés. Merci de vérifier les preuves.'
      : '✅ Scores identiques déclarés. Vérifiez les preuves avant validation.',
    fields: [
      { name: 'Ladder', value: `${ladder.name} (${ladder.category} • ${ladder.region})`, inline: true },
      { name: 'Niveau', value: match.queueLevel, inline: true },
      {
        name: 'Horaire',
        value: Number.isNaN(kickoff) ? match.scheduledAt : `<t:${kickoff}:F>`,
        inline: true,
      },
      { name: 'Équipe hôte', value: formatReport(hostTeam.name, hostReport) },
      { name: 'Équipe invitée', value: formatReport(guestTeam.name, guestReport) },
    ],
  }).setFooter({ text: `Ticket ${ticketId}` });

  const message = await channel.send({ embeds: [embed], components: [buildButtonRow(ticketId)] }).catch((error) => {
    throw new Error(`Impossible d’envoyer la carte d’arbitrage : ${String(error)}`);
  });

  const ticket: ArbitrationTicket = {
    id: ticketId,
    matchId: match.id,
    matchType: 'ladder',
    state: 'PENDING',
    threadId: undefined,
    evidenceMessageUrls: [
      ...(hostReport ? [hostReport.victoryProofUrl, hostReport.scoreboardProofUrl] : []),
      ...(guestReport ? [guestReport.victoryProofUrl, guestReport.scoreboardProofUrl] : []),
    ],
    queueMessageId: message.id,
    queueChannelId: channelId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await arbitrationStore.update((tickets) => [...tickets, ticket]);
  return ticket;
}

type ButtonAction = 'validate' | 'refuse' | 'needs_info' | 'dispute';
type ModalAction = Exclude<ButtonAction, 'validate'>;

const BUTTON_REGEX = /^scrim-arb:([^:]+):(validate|refuse|needs_info|dispute)$/;
const FINAL_STATES = new Set<ArbitrationTicket['state']>(['VALIDATED', 'REFUSED', 'DISPUTE', 'DISQUALIFIED']);
const STATE_STYLES: Record<string, { color: number; description: string }> = {
  VALIDATED: { color: 0x16a34a, description: '✅ Résultat validé.' },
  REFUSED: { color: 0xef4444, description: '❌ Rapport refusé.' },
  NEEDS_INFO: { color: 0x0ea5e9, description: 'ℹ️ Compléments requis.' },
  DISPUTE: { color: 0x8b5cf6, description: '⚖️ Litige ouvert.' },
};

const ensureStaff = async (interaction: ButtonInteraction | ModalSubmitInteraction) => {
  const roleId = process.env.MOD_ROLE_ID;
  if (!roleId) return true;
  const roles = (interaction.member as { roles?: unknown } | null)?.roles;
  const hasRole = Array.isArray(roles)
    ? roles.includes(roleId)
    : Boolean((roles as { cache?: Map<string, unknown> }).cache?.has?.(roleId));
  if (hasRole) return true;
  await interaction.reply({ content: '❌ Action réservée au staff.', ephemeral: true });
  return false;
};

type TicketContext =
  | { type: 'scrim'; ticket: ArbitrationTicket; scrim: Scrim; host: Team; guest: Team }
  | { type: 'ladder'; ticket: ArbitrationTicket; ladder: Ladder; match: LadderMatch; host: Team; guest: Team };

const loadContext = async (ticketId: string): Promise<TicketContext | undefined> => {
  const ticket = (await arbitrationStore.read()).find((entry) => entry.id === ticketId);
  if (!ticket) return undefined;
  const teams = await teamStore.read();

  if (ticket.matchType === 'scrim') {
    const scrim = (await scrimStore.read()).find((entry) => entry.id === ticket.matchId);
    if (!scrim || !scrim.hostTeamId || !scrim.guestTeamId) return undefined;
    const host = teams.find((team) => team.id === scrim.hostTeamId);
    const guest = teams.find((team) => team.id === scrim.guestTeamId);
    if (!host || !guest) return undefined;
    return { type: 'scrim', ticket, scrim, host, guest };
  }

  if (ticket.matchType === 'ladder') {
    const ladders = await ladderStore.read();
    const ladder = ladders.find((entry) => entry.matches.some((match) => match.id === ticket.matchId));
    if (!ladder) return undefined;
    const match = ladder.matches.find((entry) => entry.id === ticket.matchId);
    if (!match) return undefined;
    const host = teams.find((team) => team.id === match.hostTeamId);
    const guest = teams.find((team) => team.id === match.guestTeamId);
    if (!host || !guest) return undefined;
    return { type: 'ladder', ticket, ladder, match, host, guest };
  }

  return undefined;
};

const editCard = async (
  client: Client,
  ticket: ArbitrationTicket,
  style: { color: number; description: string },
  disabled: boolean,
  note?: string,
) => {
  if (!ticket.queueChannelId || !ticket.queueMessageId) return;
  const channel = await client.channels.fetch(ticket.queueChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await channel.messages.fetch(ticket.queueMessageId).catch(() => null);
  if (!message) return;
  const base = message.embeds[0] ? EmbedBuilder.from(message.embeds[0]) : new EmbedBuilder();
  base.setColor(style.color).setDescription(note ? `${style.description}\n\n📝 ${note}` : style.description).setTimestamp(new Date());
  await message.edit({ embeds: [base], components: [buildButtonRow(ticket.id, disabled)] });
};

const notifyThread = async (client: Client, scrim: Scrim, content: string) => {
  if (!scrim.threadId) return;
  const channel = await client.channels.fetch(scrim.threadId).catch(() => null);
  if (!channel) return;
  const send = (channel as { send?: (payload: unknown) => Promise<unknown> }).send;
  if (send) await send.call(channel, { content }).catch(() => undefined);
};

const mentionCaptains = (host: Team, guest: Team) => {
  const ids = [host.captainId, guest.captainId].filter((value): value is string => Boolean(value));
  return ids.length ? `${ids.map((id) => `<@${id}>`).join(' ')} ` : '';
};

const LADDER_SCORE_REGEX = /^A(\d+)-B(\d+)$/;

const parseLadderScore = (score?: string) => {
  if (!score) return undefined;
  const match = LADDER_SCORE_REGEX.exec(score);
  if (!match) return undefined;
  return { host: Number.parseInt(match[1], 10), guest: Number.parseInt(match[2], 10) } as const;
};

const K_FACTOR = 24;

const computeEloUpdate = (host: LadderEntry, guest: LadderEntry, hostScore: number) => {
  const expectedHost = 1 / (1 + 10 ** ((guest.rating - host.rating) / 400));
  const expectedGuest = 1 - expectedHost;
  const guestScore = 1 - hostScore;
  const nextHost = Math.round(host.rating + K_FACTOR * (hostScore - expectedHost));
  const nextGuest = Math.round(guest.rating + K_FACTOR * (guestScore - expectedGuest));
  return { nextHost, nextGuest, deltaHost: nextHost - host.rating, deltaGuest: nextGuest - guest.rating } as const;
};

export async function handleArbitrationButton(interaction: ButtonInteraction): Promise<boolean> {
  const match = BUTTON_REGEX.exec(interaction.customId);
  if (!match) return false;
  if (!(await ensureStaff(interaction))) return true;
  const [, ticketId, rawAction] = match;
  const action = rawAction as ButtonAction;
  if (action !== 'validate') {
    const modal = new ModalBuilder()
      .setCustomId(`scrim-arb:${ticketId}:${action}:modal`)
      .setTitle(action === 'refuse' ? 'Refuser le rapport' : action === 'dispute' ? 'Ouvrir un litige' : 'Demander des compléments')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('reason').setLabel('Détails').setStyle(TextInputStyle.Paragraph).setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const context = await loadContext(ticketId);
  if (!context) {
    await interaction.editReply('❌ Ticket introuvable ou match non pris en charge.');
    return true;
  }
  if (FINAL_STATES.has(context.ticket.state)) {
    await interaction.editReply('⚠️ Ce ticket est déjà traité.');
    return true;
  }

  const timestamp = new Date().toISOString();

  if (context.type === 'scrim') {
    const reports = context.scrim.reports ?? [];
    const hostReport = reports.find((entry) => entry.teamId === context.scrim.hostTeamId);
    const guestReport = reports.find((entry) => entry.teamId === context.scrim.guestTeamId);
    const aligned = hostReport && guestReport && hostReport.score === guestReport.score;
    const result = aligned ? hostReport?.score : hostReport?.score ?? guestReport?.score;

    await scrimStore.update((items) =>
      items.map((entry) =>
        entry.id === context.scrim.id
          ? {
              ...entry,
              status: 'VALIDATED',
              result: result ?? entry.result,
              validatedBy: interaction.user.id,
              validatedAt: timestamp,
              updatedAt: timestamp,
            }
          : entry,
      ),
    );
    await arbitrationStore.update((items) =>
      items.map((entry) =>
        entry.id === context.ticket.id
          ? { ...entry, state: 'VALIDATED', refereeId: interaction.user.id, updatedAt: timestamp }
          : entry,
      ),
    );

    const style = STATE_STYLES.VALIDATED;
    await editCard(interaction.client, context.ticket, style, true);
    await notifyThread(
      interaction.client,
      context.scrim,
      `${mentionCaptains(context.host, context.guest)}✅ Résultat validé par <@${interaction.user.id}>${
        result ? ` — score ${result}` : ''
      }`,
    );
    await interaction.editReply('✅ Rapport validé et enregistré.');
    return true;
  }

  const reports = context.match.reports ?? [];
  const hostReport = reports.find((entry) => entry.teamId === context.match.hostTeamId);
  const guestReport = reports.find((entry) => entry.teamId === context.match.guestTeamId);
  const result = hostReport?.score ?? guestReport?.score;
  const parsed = parseLadderScore(result);
  if (!parsed) {
    await interaction.editReply('❌ Score invalide. Impossible de valider ce match ladder.');
    return true;
  }

  const ladderEntries = context.ladder.entries;
  const hostEntry = ladderEntries.find((entry) => entry.teamId === context.match.hostTeamId);
  const guestEntry = ladderEntries.find((entry) => entry.teamId === context.match.guestTeamId);
  if (!hostEntry || !guestEntry) {
    await interaction.editReply('❌ Entrées ladder introuvables pour ce match.');
    return true;
  }

  const hostWon = parsed.host > parsed.guest;
  const { nextHost, nextGuest, deltaHost, deltaGuest } = computeEloUpdate(hostEntry, guestEntry, hostWon ? 1 : 0);

  await ladderStore.update((collection) =>
    collection.map((ladder) =>
      ladder.id === context.ladder.id
        ? {
            ...ladder,
            entries: ladder.entries.map((entry) => {
              if (entry.teamId === hostEntry.teamId) {
                return {
                  ...entry,
                  rating: nextHost,
                  wins: entry.wins + (hostWon ? 1 : 0),
                  losses: entry.losses + (hostWon ? 0 : 1),
                };
              }
              if (entry.teamId === guestEntry.teamId) {
                return {
                  ...entry,
                  rating: nextGuest,
                  wins: entry.wins + (hostWon ? 0 : 1),
                  losses: entry.losses + (hostWon ? 1 : 0),
                };
              }
              return entry;
            }),
            matches: ladder.matches.map((match) =>
              match.id === context.match.id
                ? { ...match, status: 'VALIDATED', result: result ?? match.result, completedAt: timestamp, updatedAt: timestamp }
                : match,
            ),
            updatedAt: timestamp,
          }
        : ladder,
    ),
  );

  await arbitrationStore.update((items) =>
    items.map((entry) =>
      entry.id === context.ticket.id
        ? { ...entry, state: 'VALIDATED', refereeId: interaction.user.id, updatedAt: timestamp }
        : entry,
    ),
  );

  const style = STATE_STYLES.VALIDATED;
  await editCard(interaction.client, context.ticket, style, true);
  const hostLine = `${context.host.name} ${deltaHost >= 0 ? '+' : ''}${deltaHost} Elo (${hostEntry.rating} → ${nextHost})`;
  const guestLine = `${context.guest.name} ${deltaGuest >= 0 ? '+' : ''}${deltaGuest} Elo (${guestEntry.rating} → ${nextGuest})`;
  await interaction.editReply(`✅ Résultat ladder validé (${result}).\n${hostLine}\n${guestLine}`);
  return true;
}

export async function handleArbitrationModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrim-arb' || parts[3] !== 'modal') return false;
  const action = parts[2] as ModalAction;
  if (!(await ensureStaff(interaction))) return true;

  const reason = interaction.fields.getTextInputValue('reason').trim();
  await interaction.deferReply({ ephemeral: true });
  const context = await loadContext(parts[1]);
  if (!context) {
    await interaction.editReply('❌ Ticket introuvable ou match non pris en charge.');
    return true;
  }
  if (FINAL_STATES.has(context.ticket.state) && action !== 'needs_info') {
    await interaction.editReply('⚠️ Ce ticket est déjà clôturé.');
    return true;
  }

  const timestamp = new Date().toISOString();
  const nextState = action === 'needs_info' ? 'NEEDS_INFO' : action === 'refuse' ? 'REFUSED' : 'DISPUTE';
  const keepResult = action !== 'refuse';

  if (context.type === 'scrim') {
    const scrimStatus = action === 'refuse' ? 'REFUSED' : action === 'dispute' ? 'DISPUTE' : 'AWAITING_ARBITRATION';

    await scrimStore.update((items) =>
      items.map((entry) =>
        entry.id === context.scrim.id
          ? {
              ...entry,
              status: scrimStatus,
              result: keepResult ? entry.result : undefined,
              validatedBy: undefined,
              validatedAt: undefined,
              updatedAt: timestamp,
            }
          : entry,
      ),
    );
  } else {
    const ladderStatus = action === 'refuse' ? 'REFUSED' : action === 'dispute' ? 'DISPUTE' : 'AWAITING_ARBITRATION';
    await ladderStore.update((collection) =>
      collection.map((ladder) =>
        ladder.id === context.ladder.id
          ? {
              ...ladder,
              matches: ladder.matches.map((match) =>
                match.id === context.match.id
                  ? {
                      ...match,
                      status: ladderStatus,
                      result: keepResult ? match.result : undefined,
                      updatedAt: timestamp,
                    }
                  : match,
              ),
              updatedAt: timestamp,
            }
          : ladder,
      ),
    );
  }
  await arbitrationStore.update((items) =>
    items.map((entry) =>
      entry.id === context.ticket.id
        ? { ...entry, state: nextState, refereeId: interaction.user.id, notes: reason, updatedAt: timestamp }
        : entry,
    ),
  );

  const style = STATE_STYLES[nextState] ?? STATE_STYLES.NEEDS_INFO;
  await editCard(interaction.client, context.ticket, style, nextState !== 'NEEDS_INFO', reason);
  const threadLabel =
    action === 'refuse' ? '❌ Rapport refusé' : action === 'dispute' ? '⚖️ Litige ouvert' : 'ℹ️ Compléments demandés';
  if (context.type === 'scrim') {
    await notifyThread(
      interaction.client,
      context.scrim,
      `${mentionCaptains(context.host, context.guest)}${threadLabel} : ${reason}`,
    );
  }
  await interaction.editReply(style.description);
  return true;
}
