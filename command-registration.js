const { REST, Routes } = require('discord.js');

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

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

function resolveGuildIdsForRegistration(configuredGuildIds, discoveredGuildIds, allowUnverifiedGuildIds = false) {
  if (discoveredGuildIds.length > 0) {
    if (allowUnverifiedGuildIds) {
      const merged = new Set(discoveredGuildIds);
      configuredGuildIds.forEach((id) => merged.add(id));
      return Array.from(merged);
    }

    return configuredGuildIds.length > 0
      ? configuredGuildIds.filter((id) => discoveredGuildIds.includes(id))
      : discoveredGuildIds;
  }

  return allowUnverifiedGuildIds ? configuredGuildIds : [];
}

async function getGuildIdsForRegistration(client, configuredGuildIds, retries = 5, delayMs = 5000, timeoutMs = 10000) {
  const discoveredGuildIds = new Set(configuredGuildIds);

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (typeof client?.guilds?.fetch === 'function') {
      try {
        await withTimeout(client.guilds.fetch(), timeoutMs, `Guild fetch attempt ${attempt}`);
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
  const requestTimeoutMs = options.requestTimeoutMs ?? 15000;
  const guildFetchTimeoutMs = options.guildFetchTimeoutMs ?? 10000;
  const allowUnverifiedGuildIds = options.allowUnverifiedGuildIds ?? false;

  if (!token) {
    throw new Error('No Discord token found.');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const configuredGuildIds = parseGuildIds(process.env.GUILD_IDS || process.env.GUILD_ID);
  const discoveredGuildIds = await getGuildIdsForRegistration(client, [], retries, delayMs, guildFetchTimeoutMs);
  const guildIds = resolveGuildIdsForRegistration(configuredGuildIds, discoveredGuildIds, allowUnverifiedGuildIds);

  if (configuredGuildIds.length > 0 && discoveredGuildIds.length > 0 && !allowUnverifiedGuildIds) {
    const skippedGuildIds = configuredGuildIds.filter((id) => !discoveredGuildIds.includes(id));
    if (skippedGuildIds.length > 0) {
      console.warn(
        `Skipping configured guild IDs with no bot access: ${skippedGuildIds.join(', ')}. `
        + 'Set ALLOW_UNVERIFIED_GUILD_IDS=true to force attempts anyway.'
      );
    }
  }

  console.log(
    `Registration setup: ${commandPayloads.length} commands, ${guildIds.length} guild target(s), ${discoveredGuildIds.length} discovered guild(s).`
  );

  if (guildIds.length > 0) {
    for (const guildId of guildIds) {
      try {
        await withTimeout(
          rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
            body: [],
          }),
          requestTimeoutMs,
          `Clear guild commands ${guildId}`
        );
        await withTimeout(
          rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
            body: commandPayloads,
          }),
          requestTimeoutMs,
          `Register guild commands ${guildId}`
        );
        console.log(`Registered ${commandPayloads.length} slash commands for guild ${guildId}`);
      } catch (err) {
        console.error(`Failed to register slash commands for guild ${guildId}:`, err);
      }
    }
  } else {
    console.log('No guilds available for command registration yet. Set GUILD_ID or GUILD_IDS in your environment to register commands immediately in a specific server.');
  }

  try {
    await withTimeout(
      rest.put(Routes.applicationCommands(client.user.id), {
        body: commandPayloads,
      }),
      requestTimeoutMs,
      'Register global commands'
    );
    console.log('Global slash commands registered.');
  } catch (err) {
    console.error('Failed to register global slash commands:', err);
  }
}

module.exports = {
  parseGuildIds,
  toCommandPayloads,
  shouldUseGuildScopedRegistration,
  resolveGuildIdsForRegistration,
  registerSlashCommands,
};
