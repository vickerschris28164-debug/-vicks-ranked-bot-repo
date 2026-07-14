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

function shouldUseGuildScopedRegistration(configuredGuildIds, resolvedGuildIds) {
  return configuredGuildIds.length > 0 || resolvedGuildIds.length > 0;
}

async function getGuildIdsForRegistration(client, configuredGuildIds, retries = 5, delayMs = 5000) {
  const discoveredGuildIds = new Set(configuredGuildIds);

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (typeof client?.guilds?.fetch === 'function') {
      try {
        await client.guilds.fetch();
      } catch (err) {
        console.warn(`Guild fetch attempt ${attempt} failed:`, err.message || err);
      }
    }

    const guildIds = Array.from(client?.guilds?.cache?.values?.() || []).map((guild) => guild.id);
    guildIds.forEach((guildId) => discoveredGuildIds.add(guildId));

    if (discoveredGuildIds.size > 0) {
      return Array.from(discoveredGuildIds);
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return [];
}

async function registerSlashCommands(client, commands, options = {}) {
  const commandPayloads = toCommandPayloads(commands);
  const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;
  const retries = options.retries ?? 5;
  const delayMs = options.delayMs ?? 5000;

  if (!token) {
    throw new Error('No Discord token found.');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const configuredGuildIds = parseGuildIds(process.env.GUILD_IDS || process.env.GUILD_ID);
  const guildIds = await getGuildIdsForRegistration(client, configuredGuildIds, retries, delayMs);

  if (guildIds.length > 0) {
    for (const guildId of guildIds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
          body: [],
        });
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
          body: commandPayloads,
        });
        console.log(`Registered ${commandPayloads.length} slash commands for guild ${guildId}`);
      } catch (err) {
        console.error(`Failed to register slash commands for guild ${guildId}:`, err);
      }
    }
  } else {
    console.log('No guilds available for command registration yet. Set GUILD_ID or GUILD_IDS in your environment to register commands immediately in a specific server.');
  }

  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commandPayloads,
    });
    console.log('Global slash commands registered.');
  } catch (err) {
    console.error('Failed to register global slash commands:', err);
  }
}

module.exports = { parseGuildIds, toCommandPayloads, shouldUseGuildScopedRegistration, registerSlashCommands };
