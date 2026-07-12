const { REST, Routes } = require('discord.js');

function parseGuildIds(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toCommandPayloads(commands) {
  return commands.map((command) => {
    if (command && typeof command.toJSON === 'function') {
      return command.toJSON();
    }
    return command;
  });
}

async function getGuildIdsForRegistration(client) {
  const configuredGuildIds = parseGuildIds(process.env.GUILD_IDS || process.env.GUILD_ID);
  if (configuredGuildIds.length > 0) {
    return configuredGuildIds;
  }

  if (typeof client?.guilds?.fetch === 'function') {
    await client.guilds.fetch();
  }

  return Array.from(client?.guilds?.cache?.values?.() || []).map((guild) => guild.id);
}

async function registerSlashCommands(client, commands) {
  const commandPayloads = toCommandPayloads(commands);
  const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;

  if (!token) {
    throw new Error('No Discord token found.');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const guildIds = await getGuildIdsForRegistration(client);

  if (guildIds.length > 0) {
    for (const guildId of guildIds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
          body: commandPayloads,
        });
        console.log(`Registered ${commandPayloads.length} slash commands for guild ${guildId}`);
      } catch (err) {
        console.error(`Failed to register slash commands for guild ${guildId}:`, err);
      }
    }
  } else {
    console.log('No guilds configured for command registration; skipping registration.');
  }
}

module.exports = { parseGuildIds, toCommandPayloads, registerSlashCommands };
