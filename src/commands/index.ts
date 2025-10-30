import { Collection, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';

import { basicCommands } from './basics.js';
import { scrimCommands } from './scrims.js';

export interface SlashCommand {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commandGroups: SlashCommand[] = [...basicCommands, ...scrimCommands];

export const commands = new Collection<string, SlashCommand>(
  commandGroups.map((command) => [command.data.name, command]),
);

export const commandPayloads: RESTPostAPIChatInputApplicationCommandsJSONBody[] = commandGroups.map((command) =>
  command.data.toJSON(),
);
