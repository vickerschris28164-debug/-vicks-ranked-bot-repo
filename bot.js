const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { registerSlashCommands } = require('./command-registration');
require('dotenv').config();

// Ensure database directory exists
const dbDir = process.env.DB_PATH || process.cwd();
const dbPath = path.join(dbDir, 'leaderboard.db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

let slashCommands = [];

// Bump cooldown tracker (2 hours = 7200000 ms)
const bumpCooldowns = new Map();
const voiceXpCooldowns = new Map();
const BUMP_COOLDOWN = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

const db = new sqlite3.Database(dbPath);

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeLadder(ladder) {
  return ladder === 'bo3' ? 'bo3' : 'bo1';
}

function getLadderDisplayName(ladder) {
  return ladder === 'bo3' ? 'Best of 3' : 'Best of 1';
}

function ensurePlayerForMonth(id, name, month, ladder, callback) {
  const ladderType = normalizeLadder(ladder);
  db.run(`INSERT OR IGNORE INTO players (id, name, points, month, ladder_type) VALUES (?, ?, 0, ?, ?)`, [id, name, month, ladderType], function(err) {
    if (err) return callback(err);
    const inserted = this.changes > 0;
    db.run(`UPDATE players SET name = ? WHERE id = ? AND month = ? AND ladder_type = ?`, [name, id, month, ladderType], function(err2) {
      callback(err2, inserted);
    });
  });
}

function awardXP(userId, userName, guildId, amount, callback) {
  db.run(`INSERT OR IGNORE INTO user_levels (guild_id, user_id, name, xp, level) VALUES (?, ?, ?, 0, 1)`, [guildId, userId, userName], (err) => {
    if (err) return callback(err);

    db.get(`SELECT xp, level FROM user_levels WHERE guild_id = ? AND user_id = ?`, [guildId, userId], (err2, row) => {
      if (err2 || !row) return callback(err2 || new Error('Missing level row'));

      const currentLevel = row.level || 1;
      const currentXP = row.xp || 0;
      const newXP = currentXP + amount;
      let newLevel = currentLevel;
      let requiredXP = newLevel * 100;

      while (newXP >= requiredXP) {
        newLevel += 1;
        requiredXP = newLevel * 100;
      }

      db.run(`UPDATE user_levels SET name = ?, xp = ?, level = ? WHERE guild_id = ? AND user_id = ?`, [userName, newXP, newLevel, guildId, userId], (err3) => {
        callback(err3, { xp: newXP, level: newLevel, leveledUp: newLevel > currentLevel });
      });
    });
  });
}

function getLevelInfo(userId, guildId, callback) {
  db.get(`SELECT name, xp, level FROM user_levels WHERE guild_id = ? AND user_id = ?`, [guildId, userId], callback);
}

// Initialize database
db.serialize(() => {
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='players'`, (err, row) => {
    if (err) {
      return console.error('Players table lookup error:', err);
    }

    if (!row) {
      return db.run(`CREATE TABLE players (
        id TEXT,
        name TEXT,
        points INTEGER DEFAULT 0,
        month TEXT,
        ladder_type TEXT DEFAULT 'bo1',
        PRIMARY KEY (id, month, ladder_type)
      )`, (createErr) => {
        if (createErr) console.error('Players table create error:', createErr);
      });
    }

    db.all(`PRAGMA table_info(players)`, (tableErr, rows) => {
      if (tableErr) {
        return console.error('Player table info error:', tableErr);
      }

      if (!rows.some(rowData => rowData.name === 'ladder_type')) {
        db.run(`ALTER TABLE players RENAME TO players_old`, (renameErr) => {
          if (renameErr) {
            return console.error('Players table migration rename error:', renameErr);
          }

          db.run(`CREATE TABLE players (
            id TEXT,
            name TEXT,
            points INTEGER DEFAULT 0,
            month TEXT,
            ladder_type TEXT DEFAULT 'bo1',
            PRIMARY KEY (id, month, ladder_type)
          )`, (createErr) => {
            if (createErr) return console.error('Players table migration create error:', createErr);

            db.run(`INSERT OR IGNORE INTO players (id, name, points, month, ladder_type) SELECT id, name, points, month, 'bo1' FROM players_old`, (insertErr) => {
              if (insertErr) return console.error('Players table migration insert error:', insertErr);
              db.run(`DROP TABLE players_old`, (dropErr) => {
                if (dropErr) console.error('Players table migration cleanup error:', dropErr);
              });
            });
          });
        });
      }
    });
  });

  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='matches'`, (err, row) => {
    if (err) {
      return console.error('Matches table lookup error:', err);
    }

    if (!row) {
      return db.run(`CREATE TABLE matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        winner_id TEXT,
        loser_id TEXT,
        reported_by TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        month TEXT,
        ladder_type TEXT DEFAULT 'bo1'
      )`, (createErr) => {
        if (createErr) console.error('Matches table create error:', createErr);
      });
    }

    db.all(`PRAGMA table_info(matches)`, (tableErr, rows) => {
      if (tableErr) {
        return console.error('Matches table info error:', tableErr);
      }

      if (!rows.some(rowData => rowData.name === 'ladder_type')) {
        db.run(`ALTER TABLE matches RENAME TO matches_old`, (renameErr) => {
          if (renameErr) {
            return console.error('Matches table migration rename error:', renameErr);
          }

          db.run(`CREATE TABLE matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            winner_id TEXT,
            loser_id TEXT,
            reported_by TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            month TEXT,
            ladder_type TEXT DEFAULT 'bo1'
          )`, (createErr) => {
            if (createErr) return console.error('Matches table migration create error:', createErr);

            db.run(`INSERT OR IGNORE INTO matches (id, winner_id, loser_id, reported_by, timestamp, month, ladder_type) SELECT id, winner_id, loser_id, reported_by, timestamp, month, 'bo1' FROM matches_old`, (insertErr) => {
              if (insertErr) return console.error('Matches table migration insert error:', insertErr);
              db.run(`DROP TABLE matches_old`, (dropErr) => {
                if (dropErr) console.error('Matches table migration cleanup error:', dropErr);
              });
            });
          });
        });
      }
    });
  });

  db.run(`CREATE TABLE IF NOT EXISTS user_levels (
    guild_id TEXT,
    user_id TEXT,
    name TEXT,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    PRIMARY KEY (guild_id, user_id)
  )`);
});

// Register slash commands
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  await client.user.setUsername('Hideout TCG Ranked Bot').catch(err => {
    if (err.code === 20022) {
      console.log('Username change on cooldown. Try again later.');
    } else {
      console.error('Error setting username:', err);
    }
  });

  const commands = [
    new SlashCommandBuilder()
      .setName('register')
      .setDescription('Register yourself for the leaderboard')
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to register for')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('report_match')
      .setDescription('Report a ranked match result')
      .addUserOption(option =>
        option.setName('winner')
          .setDescription('The winner of the match')
          .setRequired(true))
      .addUserOption(option =>
        option.setName('loser')
          .setDescription('The loser of the match')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder the match belongs to')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('View the monthly leaderboard')
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to show')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Show leaderboard stats for a player')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to view stats for')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to show')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('level')
      .setDescription('Show your current XP and level')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to view levels for')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show bot commands and usage'),
    new SlashCommandBuilder()
      .setName('reset_monthly')
      .setDescription('Reset monthly leaderboard (Admin only)')
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to reset')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          ))
      .setDefaultMemberPermissions(0x0000000000000008),
    new SlashCommandBuilder()
      .setName('undo_match')
      .setDescription('Undo the last match for a player (Admin only)')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player whose last match to undo')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to undo from')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          ))
      .setDefaultMemberPermissions(0x0000000000000008),
    new SlashCommandBuilder()
      .setName('set_score')
      .setDescription('Set a player\'s score manually (Admin only)')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to update')
          .setRequired(true))
      .addIntegerOption(option =>
        option.setName('points')
          .setDescription('The new score')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to update')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          ))
      .setDefaultMemberPermissions(0x0000000000000008),
    new SlashCommandBuilder()
      .setName('history_list')
      .setDescription('View all months with leaderboard data')
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to show history for')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('history')
      .setDescription('View leaderboard for a specific month')
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Month in YYYY-MM format (e.g., 2024-01)')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to show')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('player_history')
      .setDescription('View a player\'s stats across all months')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to view history for')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Which ladder to show history for')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('match_history')
      .setDescription('View recent matches')
      .addIntegerOption(option =>
        option.setName('limit')
          .setDescription('Number of matches to display (default: 10)')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Filter by month (optional, YYYY-MM format)')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('ladder')
          .setDescription('Filter by ladder')
          .setRequired(false)
          .addChoices(
            { name: 'Best of 1', value: 'bo1' },
            { name: 'Best of 3', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('bump')
      .setDescription('Bump the server on Disboard'),
  ];

  slashCommands = commands;

  try {
    await registerSlashCommands(client, commands);
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on('guildCreate', async (guild) => {
  if (!slashCommands.length) return;

  try {
    await guild.commands.set(slashCommands);
    console.log(`Registered commands for newly joined guild: ${guild.name}`);
  } catch (err) {
    console.error(`Failed to register slash commands for newly joined guild ${guild.name}:`, err);
  }
});

client.on('guildMemberAdd', (member) => {
  const channel = member.guild.channels.cache.find(ch => ch.name === 'welcomes-and-boost');
  if (!channel) {
    console.error('welcomes-and-boost channel not found');
    return;
  }

  const memberCount = member.guild.memberCount;
  const embed = new EmbedBuilder()
    .setTitle('Welcome to The Hideout! 🎮')
    .setColor(0x0099FF)
    .setDescription(`Thanks for joining The Hideout family ${member.user.username}!\n\nYou are member **#${memberCount}**`);

  channel.send({ embeds: [embed] }).catch(err => {
    console.error('Could not send welcome message to welcomes-and-boost:', err);
  });
});

client.on('messageCreate', (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.content || message.content.trim().length === 0) return;

  awardXP(message.author.id, message.author.username, message.guild.id, 10, (err) => {
    if (err) console.error('XP message award error:', err);
  });
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!newState.member || newState.member.user.bot) return;
  const key = `${newState.guild.id}:${newState.member.id}`;

  if (newState.channelId && !oldState.channelId) {
    voiceXpCooldowns.delete(key);
  } else if (!newState.channelId && oldState.channelId) {
    voiceXpCooldowns.delete(key);
  }
});

setInterval(() => {
  client.guilds.cache.forEach((guild) => {
    guild.members.cache.forEach((member) => {
      if (member.user.bot || !member.voice?.channel) return;

      const key = `${guild.id}:${member.id}`;
      const now = Date.now();
      const lastAward = voiceXpCooldowns.get(key) || 0;

      if (now - lastAward < 60 * 1000) return;

      voiceXpCooldowns.set(key, now);
      awardXP(member.id, member.user.username, guild.id, 8, (err) => {
        if (err) console.error('XP voice award error:', err);
      });
    });
  });
}, 60 * 1000);

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'register') {
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const month = getCurrentMonth();
    const ladder = normalizeLadder(interaction.options.getString('ladder'));

    ensurePlayerForMonth(userId, userName, month, ladder, (err, inserted) => {
      if (err) {
        console.error('Register error:', err);
        return interaction.reply('Error registering. Please try again.');
      }
      const ladderLabel = getLadderDisplayName(ladder);
      if (inserted) {
        interaction.reply(`You have been registered for the ${ladderLabel} ladder for this month.`);
      } else {
        interaction.reply(`You are already registered for the ${ladderLabel} ladder this month.`);
      }
    });
  } else if (commandName === 'report_match') {
    await interaction.deferReply();

    const winner = interaction.options.getUser('winner');
    const loser = interaction.options.getUser('loser');
    const reporter = interaction.user.id;
    const month = getCurrentMonth();
    const ladder = normalizeLadder(interaction.options.getString('ladder'));

    if (winner.id === loser.id) {
      return interaction.editReply('Winner and loser cannot be the same person!');
    }

    ensurePlayerForMonth(winner.id, winner.username, month, ladder, (err) => {
      if (err) {
        console.error('Winner ensure error:', err);
        return interaction.editReply('Error preparing winner registration.');
      }

      ensurePlayerForMonth(loser.id, loser.username, month, ladder, (err2) => {
        if (err2) {
          console.error('Loser ensure error:', err2);
          return interaction.editReply('Error preparing loser registration.');
        }

        db.run(`INSERT INTO matches (winner_id, loser_id, reported_by, month, ladder_type) VALUES (?, ?, ?, ?, ?)`, [winner.id, loser.id, reporter, month, ladder], function(err3) {
          if (err3) {
            console.error('Match insert error:', err3);
            return interaction.editReply('Error reporting match. Please try again.');
          }

          db.run(`UPDATE players SET points = points + 1 WHERE id = ? AND month = ? AND ladder_type = ?`, [winner.id, month, ladder], function(err4) {
            if (err4) console.error('Winner points update error:', err4);
          });
          db.run(`UPDATE players SET points = points - 1 WHERE id = ? AND month = ? AND ladder_type = ?`, [loser.id, month, ladder], function(err5) {
            if (err5) console.error('Loser points update error:', err5);
          });

          interaction.editReply(`Match reported! ${winner.username} defeated ${loser.username} in ${getLadderDisplayName(ladder)}.`);
        });
      });
    });
  } else if (commandName === 'leaderboard') {
    const month = getCurrentMonth();
    const ladder = normalizeLadder(interaction.options.getString('ladder'));

    db.all(`SELECT name, points FROM players WHERE month = ? AND ladder_type = ? ORDER BY points DESC LIMIT 10`, [month, ladder], (err, rows) => {
      if (err) {
        console.error(err);
        return interaction.reply('Error fetching leaderboard.');
      }

      const embed = new EmbedBuilder()
        .setTitle(`${getLadderDisplayName(ladder)} Monthly Leaderboard - ${month}`)
        .setColor(0x0099FF);

      if (rows.length === 0) {
        embed.setDescription('No players registered yet for this ladder.');
      } else {
        let description = '';
        rows.forEach((row, index) => {
          description += `${index + 1}. ${row.name}: ${row.points} points\n`;
        });
        embed.setDescription(description);
      }

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'stats') {
    const player = interaction.options.getUser('player') || interaction.user;
    const month = getCurrentMonth();
    const ladder = normalizeLadder(interaction.options.getString('ladder'));

    db.get(`SELECT points FROM players WHERE id = ? AND month = ? AND ladder_type = ?`, [player.id, month, ladder], (err, playerRow) => {
      if (err) {
        console.error('Stats player lookup error:', err);
        return interaction.reply('Error fetching stats.');
      }
      if (!playerRow) {
        return interaction.reply(`${player.username} is not registered for the ${getLadderDisplayName(ladder)} ladder this month.`);
      }

      db.get(`SELECT COUNT(*) AS wins FROM matches WHERE winner_id = ? AND month = ? AND ladder_type = ?`, [player.id, month, ladder], (err2, winsRow) => {
        if (err2) {
          console.error('Stats wins query error:', err2);
          return interaction.reply('Error fetching stats.');
        }

        db.get(`SELECT COUNT(*) AS losses FROM matches WHERE loser_id = ? AND month = ? AND ladder_type = ?`, [player.id, month, ladder], (err3, lossesRow) => {
          if (err3) {
            console.error('Stats losses query error:', err3);
            return interaction.reply('Error fetching stats.');
          }

          db.all(`SELECT winner_id, loser_id FROM matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? AND ladder_type = ? ORDER BY id DESC`, [player.id, player.id, month, ladder], (err4, matchRows) => {
            if (err4) {
              console.error('Stats streak query error:', err4);
              return interaction.reply('Error fetching stats.');
            }

            let streak = 0;
            let streakType = null;
            for (const row of matchRows) {
              const didWin = row.winner_id === player.id;
              if (streakType === null) {
                streakType = didWin ? 'win' : 'loss';
                streak = 1;
              } else if ((didWin && streakType === 'win') || (!didWin && streakType === 'loss')) {
                streak += 1;
              } else {
                break;
              }
            }

            const wins = winsRow.wins || 0;
            const losses = lossesRow.losses || 0;
            const totalMatches = wins + losses;
            const winRate = totalMatches === 0 ? '0%' : `${Math.round((wins / totalMatches) * 100)}%`;
            const streakText = streakType ? `${streak} ${streakType}${streak === 1 ? '' : 's'}` : 'None';

            const embed = new EmbedBuilder()
              .setTitle(`${player.username}'s ${getLadderDisplayName(ladder)} Monthly Stats - ${month}`)
              .setColor(0x00FF99)
              .addFields(
                { name: 'Points', value: `${playerRow.points}`, inline: true },
                { name: 'Wins', value: `${wins}`, inline: true },
                { name: 'Losses', value: `${losses}`, inline: true },
                { name: 'Win Rate', value: `${winRate}`, inline: true },
                { name: 'Current Streak', value: streakText, inline: true }
              );

            interaction.reply({ embeds: [embed] });
          });
        });
      });
    });
  } else if (commandName === 'level') {
    const player = interaction.options.getUser('player') || interaction.user;
    getLevelInfo(player.id, interaction.guild.id, (err, row) => {
      if (err) {
        console.error('Level lookup error:', err);
        return interaction.reply('Error fetching level data.');
      }

      if (!row) {
        return interaction.reply(`${player.username} has not earned any XP yet.`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`${player.username}'s Activity Level`)
        .setColor(0x8A2BE2)
        .addFields(
          { name: 'Level', value: `${row.level || 1}`, inline: true },
          { name: 'XP', value: `${row.xp || 0}`, inline: true },
          { name: 'Next Level', value: `${(row.level || 1) * 100} XP`, inline: true }
        );

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('Hideout TCG Ranked Bot Help')
      .setColor(0xFFD700)
      .setDescription('Use these commands to manage rankings, activity levels, and ladder stats.')
      .addFields(
        { name: '/register [ladder]', value: 'Register yourself for the current month in BO1 or BO3.', inline: false },
        { name: '/report_match winner:@user loser:@user [ladder]', value: 'Report a match result for a ladder.', inline: false },
        { name: '/leaderboard [ladder]', value: 'View the current monthly leaderboard.', inline: false },
        { name: '/stats [player] [ladder]', value: 'Show monthly stats for yourself or another player.', inline: false },
        { name: '/level [player]', value: 'Show XP and level progress for activity-based leveling.', inline: false },
        { name: '/history_list [ladder]', value: 'View all months with leaderboard data.', inline: false },
        { name: '/history month:YYYY-MM [ladder]', value: 'View leaderboard for a specific month.', inline: false },
        { name: '/player_history [player] [ladder]', value: 'View a player\'s stats across all months.', inline: false },
        { name: '/match_history [limit] [month] [ladder]', value: 'View recent matches with optional filters.', inline: false },
        { name: '/reset_monthly [ladder]', value: 'Reset the monthly leaderboard (Admin only).', inline: false },
        { name: '/undo_match player:@user [ladder]', value: 'Undo the last match for a player (Admin only).', inline: false },
        { name: '/set_score player:@user points:number [ladder]', value: 'Set a player score manually (Admin only).', inline: false }
      );

    interaction.reply({ embeds: [embed], ephemeral: true });
  } else if (commandName === 'reset_monthly') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('You do not have permission to reset the leaderboard.');
    }

    const ladder = normalizeLadder(interaction.options.getString('ladder'));
    const newMonth = getCurrentMonth();

    db.run(`UPDATE players SET points = 0 WHERE month = ? AND ladder_type = ?`, [newMonth, ladder], function(err) {
      if (err) {
        console.error(err);
        return interaction.reply('Error resetting leaderboard.');
      }
      interaction.reply(`${getLadderDisplayName(ladder)} leaderboard has been reset for ${newMonth}.`);
    });
  } else if (commandName === 'undo_match') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('You do not have permission to undo matches.');
    }

    const player = interaction.options.getUser('player');
    const month = getCurrentMonth();
    const ladder = normalizeLadder(interaction.options.getString('ladder'));

    db.get(`SELECT id, winner_id, loser_id FROM matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? AND ladder_type = ? ORDER BY id DESC LIMIT 1`, [player.id, player.id, month, ladder], (err, row) => {
      if (err || !row) {
        return interaction.reply('No recent match found for this player in that ladder.');
      }

      if (row.winner_id === player.id) {
        db.run(`UPDATE players SET points = points - 1 WHERE id = ? AND month = ? AND ladder_type = ?`, [player.id, month, ladder]);
      } else {
        db.run(`UPDATE players SET points = points + 1 WHERE id = ? AND month = ? AND ladder_type = ?`, [player.id, month, ladder]);
      }

      db.run(`DELETE FROM matches WHERE id = ?`, [row.id], function(err2) {
        if (err2) {
          console.error(err2);
          return interaction.reply('Error undoing match.');
        }
        interaction.reply(`Last match for ${player.username} in ${getLadderDisplayName(ladder)} has been undone.`);
      });
    });
  } else if (commandName === 'set_score') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('You do not have permission to set scores.');
    }

    const player = interaction.options.getUser('player');
    const points = interaction.options.getInteger('points');
    const month = getCurrentMonth();
    const ladder = normalizeLadder(interaction.options.getString('ladder'));

    db.run(`UPDATE players SET points = ? WHERE id = ? AND month = ? AND ladder_type = ?`, [points, player.id, month, ladder], function(err) {
      if (err) {
        console.error(err);
        return interaction.reply('Error setting score.');
      }
      interaction.reply(`${player.username}'s ${getLadderDisplayName(ladder)} score has been set to ${points} points.`);
    });
  } else if (commandName === 'history_list') {
    const ladder = normalizeLadder(interaction.options.getString('ladder'));
    db.all(`SELECT DISTINCT month FROM players WHERE ladder_type = ? ORDER BY month DESC`, [ladder], (err, rows) => {
      if (err) {
        console.error('History list error:', err);
        return interaction.reply('Error fetching history.');
      }

      if (!rows || rows.length === 0) {
        return interaction.reply(`No ${getLadderDisplayName(ladder)} history found.`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`${getLadderDisplayName(ladder)} Leaderboard History - Available Months`)
        .setColor(0x9370DB)
        .setDescription(rows.map((row, index) => `${index + 1}. ${row.month}`).join('\n'));

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'history') {
    const month = interaction.options.getString('month');
    const ladder = normalizeLadder(interaction.options.getString('ladder'));

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return interaction.reply('Invalid month format. Please use YYYY-MM (e.g., 2024-01)');
    }

    db.all(`SELECT name, points FROM players WHERE month = ? AND ladder_type = ? ORDER BY points DESC LIMIT 10`, [month, ladder], (err, rows) => {
      if (err) {
        console.error('History error:', err);
        return interaction.reply('Error fetching leaderboard history.');
      }

      if (!rows || rows.length === 0) {
        return interaction.reply(`No ${getLadderDisplayName(ladder)} leaderboard data found for ${month}`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`${getLadderDisplayName(ladder)} Leaderboard - ${month}`)
        .setColor(0x0099FF);

      let description = '';
      rows.forEach((row, index) => {
        description += `${index + 1}. ${row.name}: ${row.points} points\n`;
      });
      embed.setDescription(description);

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'player_history') {
    const player = interaction.options.getUser('player') || interaction.user;
    const ladder = normalizeLadder(interaction.options.getString('ladder'));

    db.all(`SELECT month, points FROM players WHERE id = ? AND ladder_type = ? ORDER BY month DESC`, [player.id, ladder], (err, playerRows) => {
      if (err) {
        console.error('Player history error:', err);
        return interaction.reply('Error fetching player history.');
      }

      if (!playerRows || playerRows.length === 0) {
        return interaction.reply(`${player.username} has no ${getLadderDisplayName(ladder)} leaderboard history.`);
      }

      let description = `**${getLadderDisplayName(ladder)} Monthly Performance:**\n`;
      let totalPoints = 0;
      playerRows.forEach((row) => {
        description += `${row.month}: ${row.points} points\n`;
        totalPoints += row.points;
      });
      description += `\n**Total Points Across All Months:** ${totalPoints}`;
      description += `\n**Months Active:** ${playerRows.length}`;

      const embed = new EmbedBuilder()
        .setTitle(`${player.username}'s ${getLadderDisplayName(ladder)} History`)
        .setColor(0x00FF99)
        .setDescription(description);

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'match_history') {
    await interaction.deferReply();

    const limit = interaction.options.getInteger('limit') || 10;
    const filterMonth = interaction.options.getString('month');
    const ladder = normalizeLadder(interaction.options.getString('ladder'));
    const maxLimit = 50;
    const actualLimit = Math.min(limit, maxLimit);

    let query = `SELECT m.id, m.winner_id, m.loser_id, m.timestamp, m.month, p1.name as winner_name, p2.name as loser_name FROM matches m JOIN players p1 ON m.winner_id = p1.id JOIN players p2 ON m.loser_id = p2.id`;
    const params = [];

    if (filterMonth) {
      if (!/^\d{4}-\d{2}$/.test(filterMonth)) {
        return interaction.editReply('Invalid month format. Please use YYYY-MM (e.g., 2024-01)');
      }
      query += ` WHERE m.month = ?`;
      params.push(filterMonth);
    }

    if (ladder) {
      query += `${filterMonth ? ' AND' : ' WHERE'} m.ladder_type = ?`;
      params.push(ladder);
    }

    query += ` ORDER BY m.id DESC LIMIT ?`;
    params.push(actualLimit);

    db.all(query, params, (err, rows) => {
      if (err) {
        console.error('Match history error:', err);
        return interaction.editReply('Error fetching match history.');
      }

      if (!rows || rows.length === 0) {
        const monthText = filterMonth ? ` for ${filterMonth}` : '';
        const ladderText = ladder ? ` in ${getLadderDisplayName(ladder)}` : '';
        return interaction.editReply(`No match history found${monthText}${ladderText}.`);
      }

      let description = '';
      rows.forEach((row, index) => {
        const timestamp = new Date(row.timestamp).toLocaleDateString();
        description += `${index + 1}. **${row.winner_name}** defeated **${row.loser_name}** (${row.month}) - ${timestamp}\n`;
      });

      const embed = new EmbedBuilder()
        .setTitle('Recent Match History')
        .setColor(0xFF6347)
        .setDescription(description);

      interaction.editReply({ embeds: [embed] });
    });
  } else if (commandName === 'bump') {
    const userId = interaction.user.id;
    const now = Date.now();
    const lastBumpTime = bumpCooldowns.get(userId);

    if (lastBumpTime) {
      const timeSinceLastBump = now - lastBumpTime;
      const remainingTime = BUMP_COOLDOWN - timeSinceLastBump;

      if (remainingTime > 0) {
        const hours = Math.floor(remainingTime / (60 * 60 * 1000));
        const minutes = Math.floor((remainingTime % (60 * 60 * 1000)) / (60 * 1000));
        const seconds = Math.floor((remainingTime % (60 * 1000)) / 1000);

        const timeStr = hours > 0
          ? `${hours}h ${minutes}m ${seconds}s`
          : minutes > 0
            ? `${minutes}m ${seconds}s`
            : `${seconds}s`;

        return interaction.reply({
          content: `⏳ You can't bump again yet! Try again in **${timeStr}**`,
          ephemeral: true,
        });
      }
    }

    bumpCooldowns.set(userId, now);

    const embed = new EmbedBuilder()
      .setTitle('🚀 Bump the Server!')
      .setColor(0xFF6347)
      .setDescription(`${interaction.user.username} has bumped The Hideout! 📈\n\nThanks for helping us grow!`);

    const channel = interaction.guild.channels.cache.find(ch => ch.name === 'bump');
    if (channel) {
      channel.send({ embeds: [embed] }).catch(err => {
        console.error('Error sending bump announcement:', err);
      });
    }

    interaction.reply({ content: 'Thanks for bumping The Hideout! 🎉', ephemeral: true });
  }
});

cron.schedule('0 0 1 * *', () => {
  console.log('New monthly leaderboard cycle started:', getCurrentMonth());
});

cron.schedule('0 */2 * * *', () => {
  const guilds = client.guilds.cache;
  guilds.forEach(guild => {
    const channel = guild.channels.cache.find(ch => ch.name === 'bump');
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle('🔔 Bump Reminder!')
        .setColor(0xFF6347)
        .setDescription('Don\'t forget to bump the server!\n\nUse `/bump` to help The Hideout grow! 📈');

      channel.send({ embeds: [embed] }).catch(err => {
        console.error(`Error sending bump reminder to ${guild.name}:`, err);
      });
    }
  });
});

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;

if (!token) {
  console.error('No Discord bot token found. Set DISCORD_TOKEN, BOT_TOKEN, or TOKEN in your environment or .env file.');
  process.exit(1);
}

client.login(token);