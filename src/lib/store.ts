import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const fileLocks = new Map<string, Promise<unknown>>();

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function ensureFile(filePath: string, fallback = '[]'): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, `${fallback}\n`, 'utf8');
  }
}

async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  const next = previous.then(operation);
  fileLocks.set(filePath, next.catch(() => undefined));

  try {
    return await next;
  } finally {
    if (fileLocks.get(filePath) === next) {
      fileLocks.delete(filePath);
    }
  }
}

export type LolRole = 'top' | 'jg' | 'mid' | 'adc' | 'sup' | 'coach';
export type LolRank = 'iron' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'emerald' | 'diamond' | 'master' | 'grandmaster' | 'challenger';
export type ScrimCategory = 'IB' | 'SG' | 'PE' | 'DM' | 'GMC';
export type LadderPreset = 'open_quick' | 'erl_block';
export type QueueLevel = 'Open' | 'Academy' | 'Pro';
export type ScrimStatus = 'POSTED' | 'ACCEPTED' | 'CONFIRMED' | 'PRACTICE' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW' | 'AWAITING_ARBITRATION' | 'VALIDATED' | 'REFUSED' | 'DISPUTE' | 'DISQUALIFIED';
export type LadderStatus = 'ACTIVE' | 'PAUSED' | 'CLOSED';
export type ArbitrationState = 'PENDING' | 'VALIDATED' | 'REFUSED' | 'NEEDS_INFO' | 'DISPUTE' | 'DISQUALIFIED';

type Timestamped = { createdAt: string; updatedAt: string };
export type Org = Timestamped & { id: string; name: string; description?: string; ownerId?: string };
export type Member = Timestamped & {
  id: string;
  discordId: string;
  riotId?: string;
  orgId?: string;
  teamId?: string;
  role: LolRole;
  rank: LolRank;
  sr: number;
  isCoach?: boolean;
};
export type TeamRosterSlot = { playerId: string; role: LolRole; sr: number };
export type Team = Timestamped & {
  id: string;
  orgId?: string;
  name: string;
  region: string;
  category?: ScrimCategory;
  captainId?: string;
  members: TeamRosterSlot[];
  reliability: number;
};
export type ScrimRoster = { teamId: string; playerIds: string[]; coachIds: string[]; declaredSr: number };
export type ScrimCheckIn = { teamId: string; userIds: string[]; completedAt?: string };
export type ScrimCancellation = { cancelledByTeamId: string; reason: string; cancelledAt: string };
export type ScrimReport = {
  teamId: string;
  reportedBy: string;
  score: string;
  submittedAt: string;
  victoryProofUrl: string;
  scoreboardProofUrl: string;
  note?: string;
};
export type Scrim = Timestamped & {
  id: string;
  category: ScrimCategory;
  preset: LadderPreset;
  queueLevel: QueueLevel;
  scheduledAt: string;
  notes?: string;
  status: ScrimStatus;
  practiceReason?: string;
  hostTeamId: string;
  guestTeamId?: string;
  rosters: ScrimRoster[];
  threadId?: string;
  threadUrl?: string;
  checkInMessageId?: string;
  checkIns?: ScrimCheckIn[];
  cancellation?: ScrimCancellation;
  noShowTeamIds?: string[];
  reports?: ScrimReport[];
  arbitrationTicketId?: string;
  result?: string;
  validatedBy?: string;
  validatedAt?: string;
};
export type LadderEntry = { teamId: string; rating: number; reliability: number; wins: number; losses: number; lastQueuedAt?: string };
export type LadderMatch = { id: string; ladderId: string; scrimId?: string; scheduledAt: string; status: ScrimStatus; result?: string };
export type Ladder = Timestamped & { id: string; name: string; category: ScrimCategory; region: string; level: QueueLevel; status: LadderStatus; entries: LadderEntry[]; matches: LadderMatch[] };
export type ArbitrationTicket = Timestamped & {
  id: string;
  matchId: string;
  matchType: 'scrim' | 'ladder';
  state: ArbitrationState;
  refereeId?: string;
  notes?: string;
  threadId?: string;
  evidenceMessageUrls: string[];
  queueMessageId?: string;
  queueChannelId?: string;
};

export interface JsonStore<T> {
  readonly filePath: string;
  read(): Promise<T[]>;
  write(data: T[]): Promise<void>;
  update(mutator: (collection: T[]) => T[]): Promise<T[]>;
}

function createStore<T>(fileName: string): JsonStore<T> {
  const filePath = path.resolve(DATA_DIR, fileName);

  async function readFile(): Promise<T[]> {
    await ensureDataDir();
    await ensureFile(filePath);

    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Le fichier ${fileName} ne contient pas un tableau JSON valide.`);
    }
    return parsed as T[];
  }

  async function writeFile(data: T[]): Promise<void> {
    await ensureDataDir();
    await ensureFile(filePath);
    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  return {
    filePath,
    async read() {
      return withFileLock(filePath, () => readFile());
    },
    async write(data: T[]) {
      await withFileLock(filePath, () => writeFile(data));
    },
    async update(mutator) {
      return withFileLock(filePath, async () => {
        const current = await readFile();
        const next = mutator([...current]);
        await writeFile(next);
        return next;
      });
    },
  };
}

export const orgStore = createStore<Org>('orgs.json');
export const teamStore = createStore<Team>('teams.json');
export const memberStore = createStore<Member>('members.json');
export const scrimStore = createStore<Scrim>('scrims.json');
export const ladderStore = createStore<Ladder>('ladders.json');
export const arbitrationStore = createStore<ArbitrationTicket>('arbitration.json');
