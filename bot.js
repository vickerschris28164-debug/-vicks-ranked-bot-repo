const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
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
    GatewayIntentBits.MessageContent,
  ],
});

const db = new sqlite3.Database(dbPath);

// Initialize database
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS players (
    id TEXT,
    name TEXT,
    points INTEGER DEFAULT 0,
    month TEXT,
    PRIMARY KEY (id, month)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    winner_id TEXT,
    loser_id TEXT,
    reported_by TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    month TEXT
  )`);

  db.all(`PRAGMA table_info(players)`, (err, rows) => {
    if (err) {
      return console.error('Player table info error:', err);
    }

    const hasCompositePK = rows.some(row => row.name === 'month' && row.pk === 2);
    if (!hasCompositePK && rows.length > 0) {
      console.log('Migrating players table to use composite primary key (id, month)...');
      db.run(`ALTER TABLE players RENAME TO players_old`, err2 => {
        if (err2) {
          return console.error('Players migration rename error:', err2);
        }

        db.run(`CREATE TABLE IF NOT EXISTS players (
          id TEXT,
          name TEXT,
          points INTEGER DEFAULT 0,
          month TEXT,
          PRIMARY KEY (id, month)
        )`, err3 => {
          if (err3) {
            return console.error('Players migration create error:', err3);
          }

          db.run(`INSERT OR IGNORE INTO players (id, name, points, month) SELECT id, name, points, month FROM players_old`, err4 => {
            if (err4) {
              return console.error('Players migration insert error:', err4);
            }

            db.run(`DROP TABLE players_old`, err5 => {
              if (err5) {
                return console.error('Players migration drop old table error:', err5);
              }
              console.log('Players table migration completed.');
            });
          });
        });
      });
    }
  });
});

// Function to get current month
function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function ensurePlayerForMonth(id, name, month, callback) {
  db.run(`INSERT OR IGNORE INTO players (id, name, points, month) VALUES (?, ?, 0, ?)`, [id, name, month], function(err) {
    if (err) return callback(err);
    const inserted = this.changes > 0;
    db.run(`UPDATE players SET name = ? WHERE id = ? AND month = ?`, [name, id, month], function(err2) {
      callback(err2, inserted);
    });
  });
}

// Register slash commands
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Set bot username
  await client.user.setUsername('Hideout TCG Ranked Bot').catch(err => {
    if (err.code === 20022) { // Username change cooldown
      console.log('Username change on cooldown. Try again later.');
    } else {
      console.error('Error setting username:', err);
    }
  });

  const commands = [
    new SlashCommandBuilder()
      .setName('register')
      .setDescription('Register yourself for the leaderboard'),
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
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('View the monthly leaderboard'),
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Show leaderboard stats for a player')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to view stats for')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show bot commands and usage'),
    new SlashCommandBuilder()
      .setName('reset_monthly')
      .setDescription('Reset monthly leaderboard (Admin only)')
      .setDefaultMemberPermissions(0x0000000000000008), // Administrator
    new SlashCommandBuilder()
      .setName('undo_match')
      .setDescription('Undo the last match for a player (Admin only)')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player whose last match to undo')
          .setRequired(true))
      .setDefaultMemberPermissions(0x0000000000000008), // Administrator
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
      .setDefaultMemberPermissions(0x0000000000000008), // Administrator
  ];

  await client.application.commands.set(commands);
  console.log('Slash commands registered.');
});

// Handle interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'register') {
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const month = getCurrentMonth();

    ensurePlayerForMonth(userId, userName, month, (err, inserted) => {
      if (err) {
        console.error('Register error:', err);
        return interaction.reply('Error registering. Please try again.');
      }
      if (inserted) {
        interaction.reply('You have been registered for the leaderboard!');
      } else {
        interaction.reply('You are already registered for this month.');
      }
    });
  } else if (commandName === 'report_match') {
    await interaction.deferReply();

    const winner = interaction.options.getUser('winner');
    const loser = interaction.options.getUser('loser');
    const reporter = interaction.user.id;
    const month = getCurrentMonth();

    if (winner.id === loser.id) {
      return interaction.editReply('Winner and loser cannot be the same person!');
    }

    const isAdmin = interaction.member.permissions.has('Administrator');
    const isInvolved = reporter === winner.id || reporter === loser.id;
    if (!isAdmin && !isInvolved) {
      return interaction.editReply('You are not authorized to report this match. Only admins or the players involved can report match results.');
    }

    ensurePlayerForMonth(winner.id, winner.username, month, (err) => {
      if (err) {
        console.error('Winner ensure error:', err);
        return interaction.editReply('Error preparing winner registration.');
      }

      ensurePlayerForMonth(loser.id, loser.username, month, (err2) => {
        if (err2) {
          console.error('Loser ensure error:', err2);
          return interaction.editReply('Error preparing loser registration.');
        }

        db.run(`INSERT INTO matches (winner_id, loser_id, reported_by, month) VALUES (?, ?, ?, ?)`, [winner.id, loser.id, reporter, month], function(err3) {
          if (err3) {
            console.error('Match insert error:', err3);
            return interaction.editReply('Error reporting match. Please try again.');
          }

          db.run(`UPDATE players SET points = points + 1 WHERE id = ? AND month = ?`, [winner.id, month], function(err4) {
            if (err4) console.error('Winner points update error:', err4);
          });
          db.run(`UPDATE players SET points = points - 1 WHERE id = ? AND month = ?`, [loser.id, month], function(err5) {
            if (err5) console.error('Loser points update error:', err5);
          });

          interaction.editReply(`Match reported! ${winner.username} defeated ${loser.username}.`);
        });
      });
    });
  } else if (commandName === 'leaderboard') {
    const month = getCurrentMonth();
    db.all(`SELECT name, points FROM players WHERE month = ? ORDER BY points DESC LIMIT 10`, [month], (err, rows) => {
      if (err) {
        console.error(err);
        return interaction.reply('Error fetching leaderboard.');
      }

      const embed = new EmbedBuilder()
        .setTitle(`Monthly Leaderboard - ${month}`)
        .setColor(0x0099FF);

      if (rows.length === 0) {
        embed.setDescription('No players registered yet.');
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

    db.get(`SELECT points FROM players WHERE id = ? AND month = ?`, [player.id, month], (err, playerRow) => {
      if (err) {
        console.error('Stats player lookup error:', err);
        return interaction.reply('Error fetching stats.');
      }
      if (!playerRow) {
        return interaction.reply(`${player.username} is not registered for this month.`);
      }

      db.get(`SELECT COUNT(*) AS wins FROM matches WHERE winner_id = ? AND month = ?`, [player.id, month], (err2, winsRow) => {
        if (err2) {
          console.error('Stats wins query error:', err2);
          return interaction.reply('Error fetching stats.');
        }

        db.get(`SELECT COUNT(*) AS losses FROM matches WHERE loser_id = ? AND month = ?`, [player.id, month], (err3, lossesRow) => {
          if (err3) {
            console.error('Stats losses query error:', err3);
            return interaction.reply('Error fetching stats.');
          }

          db.all(`SELECT winner_id, loser_id FROM matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? ORDER BY id DESC`, [player.id, player.id, month], (err4, matchRows) => {
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
              .setTitle(`${player.username}'s Monthly Stats - ${month}`)
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
  } else if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('Hideout TCG Ranked Bot Help')
      .setColor(0xFFD700)
      .setDescription('Use these commands to manage rankings and view stats.')
      .addFields(
        { name: '/register', value: 'Register yourself for the monthly leaderboard.', inline: false },
        { name: '/report_match', value: 'Report a match result with winner and loser.', inline: false },
        { name: '/leaderboard', value: 'View the current monthly leaderboard.', inline: false },
        { name: '/stats', value: 'Show monthly stats for yourself or another player.', inline: false },
        { name: '/reset_monthly', value: 'Reset the monthly leaderboard (Admin only).', inline: false },
        { name: '/undo_match', value: 'Undo the last match for a player (Admin only).', inline: false },
        { name: '/set_score', value: 'Set a player score manually (Admin only).', inline: false }
      );

    interaction.reply({ embeds: [embed], ephemeral: true });
  } else if (commandName === 'reset_monthly') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('You do not have permission to reset the leaderboard.');
    }

    const newMonth = getCurrentMonth();
    // Historical months are preserved as-is. Fresh entries for the new month
    // are created automatically by ensurePlayerForMonth when players register
    // or report matches — no data needs to be modified here.
    console.log(`[reset_monthly] Admin acknowledged new month: ${newMonth}`);
    interaction.reply(`The new month (${newMonth}) is now active. Historical leaderboard data has been preserved. Fresh entries will be created automatically as players register or report matches.`);
  } else if (commandName === 'undo_match') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('You do not have permission to undo matches.');
    }

    const player = interaction.options.getUser('player');
    const month = getCurrentMonth();

    // Find the most recent match for this player
    db.get(`SELECT id, winner_id, loser_id FROM matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? ORDER BY id DESC LIMIT 1`, [player.id, player.id, month], (err, row) => {
      if (err || !row) {
        return interaction.reply('No recent match found for this player.');
      }

      // Reverse the points
      if (row.winner_id === player.id) {
        db.run(`UPDATE players SET points = points - 1 WHERE id = ? AND month = ?`, [player.id, month]);
      } else {
        db.run(`UPDATE players SET points = points + 1 WHERE id = ? AND month = ?`, [player.id, month]);
      }

      // Delete the match
      db.run(`DELETE FROM matches WHERE id = ?`, [row.id], function(err2) {
        if (err2) {
          console.error(err2);
          return interaction.reply('Error undoing match.');
        }
        interaction.reply(`Last match for ${player.username} has been undone.`);
      });
    });
  } else if (commandName === 'set_score') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('You do not have permission to set scores.');
    }

    const player = interaction.options.getUser('player');
    const points = interaction.options.getInteger('points');
    const month = getCurrentMonth();

    db.run(`UPDATE players SET points = ? WHERE id = ? AND month = ?`, [points, player.id, month], function(err) {
      if (err) {
        console.error(err);
        return interaction.reply('Error setting score.');
      }
      interaction.reply(`${player.username}'s score has been set to ${points} points.`);
    });
  }
});

// Monthly rollover notifier (1st of every month at midnight)
cron.schedule('0 0 1 * *', () => {
  console.log('New monthly leaderboard cycle started:', getCurrentMonth());
});

// Ensure token exists
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN not found in .env file!');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);