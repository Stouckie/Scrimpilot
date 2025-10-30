import type {
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from 'discord.js';

import { scrimStore, teamStore, type ScrimStatus } from './store.js';
export const CHECK_IN_EMOJI = '✅';
export const CHECK_IN_REQUIRED = 3;
const ACTIVE_STATUSES = new Set<ScrimStatus>(['CONFIRMED', 'PRACTICE']);
type ReactionInput = MessageReaction | PartialMessageReaction;
type UserInput = User | PartialUser;
async function resolveInputs(reaction: ReactionInput, user: UserInput) {
  const fullUser = user.partial ? await user.fetch() : user;
  if (fullUser.bot) return;
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  if (fullReaction.message.partial) await fullReaction.message.fetch();
  if (fullReaction.emoji.name !== CHECK_IN_EMOJI) return;
  return { reaction: fullReaction as MessageReaction, user: fullUser };
}

export async function handleCheckInReaction(reactionInput: ReactionInput, userInput: UserInput, action: 'add' | 'remove') {
  const resolved = await resolveInputs(reactionInput, userInput);
  if (!resolved) return;
  const { reaction, user } = resolved;
  const scrim = (await scrimStore.read()).find((entry) => entry.checkInMessageId === reaction.message.id);
  if (!scrim || !ACTIVE_STATUSES.has(scrim.status)) return;
  const teamId = scrim.rosters.find((roster) => [...roster.playerIds, ...roster.coachIds].includes(user.id))?.teamId;
  if (!teamId) {
    await reaction.users.remove(user.id).catch(() => {});
    return;
  }
  const now = new Date().toISOString();
  const checkIns = scrim.checkIns?.map((entry) => ({ ...entry })) ?? [];
  let entry = checkIns.find((record) => record.teamId === teamId);
  if (!entry) checkIns.push((entry = { teamId, userIds: [] }));
  const members = new Set(entry.userIds);
  let changed = false;
  if (action === 'add' && !members.has(user.id)) {
    members.add(user.id);
    changed = true;
  }
  if (action === 'remove' && members.delete(user.id)) changed = true;
  if (!changed) {
    if (entry.completedAt && members.size < CHECK_IN_REQUIRED) {
      entry.completedAt = undefined;
      changed = true;
    } else if (!entry.completedAt) return;
  }

  entry.userIds = [...members];
  const thresholdReached = entry.userIds.length >= CHECK_IN_REQUIRED;
  const wasCompleted = Boolean(entry.completedAt);
  const nextCompleted = thresholdReached ? entry.completedAt ?? now : undefined;
  const stateChanged = Boolean(entry.completedAt) !== Boolean(nextCompleted);
  entry.completedAt = nextCompleted;

  await scrimStore.update((records) =>
    records.map((record) =>
      record.id === scrim.id ? { ...record, checkIns, updatedAt: now } : record,
    ),
  );

  if (stateChanged) {
    const teamName = (await teamStore.read()).find((team) => team.id === teamId)?.name ?? teamId;
    const message = thresholdReached
      ? `✅ Check-in validé pour ${teamName} (${entry.userIds.length}/${CHECK_IN_REQUIRED}).`
      : `ℹ️ Check-in incomplet pour ${teamName}. Merci d’utiliser ${CHECK_IN_EMOJI}.`;
    await reaction.message.channel
      .send(message)
      .catch((error) => console.error('Erreur lors de la notification de check-in :', error));
  }
}
