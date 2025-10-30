import type { Client } from 'discord.js';

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
  if (channel && 'isTextBased' in channel && channel.isTextBased()) {
    await channel.send({ content }).catch((error) => console.error(`Rappel scrim échoué (${threadId}) :`, error));
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

  const timestamp = new Date().toISOString();
  await scrimStore.update((collection) =>
    collection.map((record) =>
      record.id === scrim.id
        ? { ...record, status: 'NO_SHOW', noShowTeamIds: missing, updatedAt: timestamp }
        : record,
    ),
  );
  clearTimers(scrim.id);

  const teams = await teamStore.read();
  const names = missing
    .map((teamId) => teams.find((team) => team.id === teamId)?.name ?? `Équipe ${teamId}`)
    .join(', ');
  await post(scrim.threadId, `⏱️ No-show constaté après 10 minutes. Équipe(s) concernée(s) : ${names}. Contactez l’arbitrage si besoin.`);
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
