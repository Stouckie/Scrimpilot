import type { Client, TextBasedChannel } from 'discord.js';

import { applyReliabilityChange } from './reliability.js';
import { scrimStore, teamStore, type Scrim, type ScrimStatus } from './store.js';

const ACTIVE_STATUSES = new Set<ScrimStatus>(['CONFIRMED', 'PRACTICE']);
const timers = new Map<string, NodeJS.Timeout[]>();
let clientRef: Client | undefined;

const clearTimers = (scrimId: string) => {
  timers.get(scrimId)?.forEach((timer) => clearTimeout(timer));
  timers.delete(scrimId);
};

const post = async (threadId: string, content: string) => {
  if (!clientRef) return;
  const channel = await clientRef.channels.fetch(threadId).catch(() => null);
  if (
    channel &&
    'isTextBased' in channel &&
    typeof channel.isTextBased === 'function' &&
    channel.isTextBased() &&
    typeof (channel as { send?: unknown }).send === 'function'
  ) {
    const target = channel as TextBasedChannel & { send: (payload: unknown) => Promise<unknown> };
    await target
      .send({ content })
      .catch((error: unknown) => console.error(`Rappel scrim échoué (${threadId}) :`, error));
  }
};
const scheduleAt = (scrimId: string, timestamp: number, job: () => void, runIfPast = false) => {
  const delay = timestamp - Date.now();
  if (delay <= 0) {
    if (runIfPast) job();
    return;
  }
  const timer = setTimeout(job, delay);
  const bucket = timers.get(scrimId) ?? [];
  bucket.push(timer);
  timers.set(scrimId, bucket);
};
const applyNoShow = async (scrim: Scrim) => {
  if (!scrim.threadId) return;
  const missing = scrim.rosters
    .map((roster) => roster.teamId)
    .filter((teamId) => {
      const record = scrim.checkIns?.find((entry) => entry.teamId === teamId);
      return !record || record.userIds.length < 3;
    });
  if (missing.length === 0) return;

  const now = new Date();
  const timestamp = now.toISOString();
  const cooldownHours = scrim.queueLevel === 'Open' ? 24 : 48;
  const cooldownUntil = new Date(now.getTime() + cooldownHours * 3_600_000).toISOString();
  await scrimStore.update((collection) =>
    collection.map((record) =>
      record.id === scrim.id
        ? { ...record, status: 'NO_SHOW', noShowTeamIds: missing, updatedAt: timestamp }
        : record,
    ),
  );
  clearTimers(scrim.id);

  const teams = await teamStore.read();
  const penalties = await Promise.all(
    missing.map((teamId) =>
      applyReliabilityChange({ teamId, delta: -15, cooldownUntil, timestamp }).catch(() => undefined),
    ),
  );
  const untilSeconds = Math.floor(new Date(cooldownUntil).getTime() / 1000);
  const summary = missing
    .map((teamId, index) => {
      const label = teams.find((team) => team.id === teamId)?.name ?? `Équipe ${teamId}`;
      const penalty = penalties[index];
      const reliabilityLine = penalty
        ? `fiabilité ${penalty.previous} → ${penalty.next}`
        : 'fiabilité -15 (erreur mise à jour)';
      return `• ${label} : ${reliabilityLine} • cooldown jusqu’au <t:${untilSeconds}:F>.`;
    })
    .join('\n');
  await post(
    scrim.threadId,
    `⏱️ No-show constaté après 10 minutes.\n${summary}\nContactez l’arbitrage pour toute contestation.`,
  );
};
const scheduleScrim = async (scrim: Scrim) => {
  if (!scrim.threadId) return;
  const kickoff = new Date(scrim.scheduledAt).getTime();
  if (Number.isNaN(kickoff)) return;
  const ts = Math.floor(kickoff / 1000);
  const messages: [number, string][] = [
    [kickoff - 86_400_000, `⏰ Rappel J-1 : scrim ${scrim.id} le <t:${ts}:F>. Merci de verrouiller vos rosters.`],
    [kickoff - 3_600_000, `⏰ Rappel H-1 : scrim ${scrim.id} dans une heure (<t:${ts}:R>). Check-in requis avec ✅.`],
    [kickoff, `🚀 C’est l’heure du scrim ${scrim.id} ! Lancez la partie et postez vos check-in.`],
  ];
  messages.forEach(([time, text]) => scheduleAt(scrim.id, time, () => void post(scrim.threadId!, text)));
  scheduleAt(
    scrim.id,
    kickoff + 600_000,
    () => {
      void scrimStore
        .read()
        .then((records) => records.find((record) => record.id === scrim.id))
        .then((fresh) => {
          if (!fresh || !ACTIVE_STATUSES.has(fresh.status)) return;
          void applyNoShow(fresh);
        })
        .catch((error) => console.error('Erreur lors du contrôle no-show :', error));
    },
    true,
  );
};

export async function registerScrimReminders(scrim: Scrim): Promise<void> {
  clearTimers(scrim.id);
  if (!clientRef || !ACTIVE_STATUSES.has(scrim.status) || !scrim.threadId) return;
  await scheduleScrim(scrim);
}
export async function cancelScrimReminders(scrimId: string): Promise<void> {
  clearTimers(scrimId);
}
export async function initializeScrimScheduler(client: Client): Promise<void> {
  clientRef = client;
  const scrims = await scrimStore.read();
  await Promise.all(scrims.map((scrim) => registerScrimReminders(scrim)));
}
