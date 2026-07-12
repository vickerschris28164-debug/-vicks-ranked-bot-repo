const { REST, Routes } = require('discord.js');

function parseGuildIds(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function registerSlashCommands(client, commands) {
  const configuredGuildIds = parseGuildIds(process.env.GUILD_IDS || process.env.GUILD_ID);
  const commandPayloads = commands.map((command) => command.toJSON());
  const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;

  if (!token) {
    throw new Error('No Discord token found.');
  }

  const rest = new REST({ version: '10' }).setToken(token);

  if (configuredGuildIds.length > 0) {
    for (const guildId of configuredGuildIds) {
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
    const guilds = Array.from(client.guilds.cache.values());
    console.log(`Found ${guilds.length} guild(s) for command registration.`);

    for (const guild of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), {
          body: commandPayloads,
        });
        console.log(`Registered ${commandPayloads.length} slash commands for guild ${guild.name}`);
      } catch (err) {
        console.error(`Failed to register slash commands for guild ${guild.name}:`, err);
      }
    }
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

module.exports = { parseGuildIds, registerSlashCommands };
