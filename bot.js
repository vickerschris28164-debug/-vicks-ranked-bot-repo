const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

// Pending match confirmations — keyed by matchId
const pendingMatches = new Map();

// Shared function to commit a confirmed match to the database
function recordMatch(winner, loser, reporter, month, interaction) {
  ensurePlayerForMonth(winner.id, winner.username, month, (err) => {
    if (err) {
      console.error('Winner ensure error:', err);
      return interaction.editReply({ content: 'Error preparing winner registration.', embeds: [], components: [] });
    }
    ensurePlayerForMonth(loser.id, loser.username, month, (err2) => {
      if (err2) {
        console.error('Loser ensure error:', err2);
        return interaction.editReply({ content: 'Error preparing loser registration.', embeds: [], components: [] });
      }
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(`INSERT INTO matches (winner_id, loser_id, reported_by, month) VALUES (?, ?, ?, ?)`, [winner.id, loser.id, reporter, month], function(err3) {
          if (err3) {
            db.run('ROLLBACK');
            console.error('Match insert error:', err3);
            return interaction.editReply({ content: 'Error recording match. Please try again.', embeds: [], components: [] });
          }
          db.run(`UPDATE players SET points = points + 1 WHERE id = ? AND month = ?`, [winner.id, month], function(err4) {
            if (err4) {
              db.run('ROLLBACK');
              console.error('Winner points update error:', err4);
              return interaction.editReply({ content: 'Error updating winner points. Match was not recorded.', embeds: [], components: [] });
            }
            db.run(`UPDATE players SET points = points - 1 WHERE id = ? AND month = ?`, [loser.id, month], function(err5) {
              if (err5) {
                db.run('ROLLBACK');
                console.error('Loser points update error:', err5);
                return interaction.editReply({ content: 'Error updating loser points. Match was not recorded.', embeds: [], components: [] });
              }
              db.run('COMMIT', function(err6) {
                if (err6) {
                  console.error('Commit error:', err6);
                  return interaction.editReply({ content: 'Error saving match. Please try again.', embeds: [], components: [] });
                }
                const confirmedEmbed = new EmbedBuilder()
                  .setTitle('Match Confirmed')
                  .setColor(0x00C851)
                  .setDescription(`**${winner.username}** defeated **${loser.username}**\n+1 point to ${winner.username} · -1 point to ${loser.username}`);
                interaction.editReply({ embeds: [confirmedEmbed], components: [] });
              });
            });
          });
        });
      });
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
      .setName('history')
      .setDescription('View leaderboard or player stats for a past month')
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Month to look up (e.g. 2025-04). Leave blank to see all available months.')
          .setRequired(false))
      .addUserOption(option =>
        option.setName('player')
          .setDescription('Player to view stats for (leave blank for leaderboard)')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('match_history')
      .setDescription('View recent match results for yourself or another player')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('Player to view (leave blank for yourself)')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Month to view (e.g. 2025-04). Leave blank for current month.')
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

  // Slash commands require a guild context — block DM usage to prevent crashes
  if (!interaction.guild || !interaction.member) {
    return interaction.reply({ content: 'This bot can only be used inside a server.', ephemeral: true });
  }

  const { commandName } = interaction;

  if (commandName === 'register') {
    await interaction.deferReply();
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const month = getCurrentMonth();

    ensurePlayerForMonth(userId, userName, month, (err, inserted) => {
      if (err) {
        console.error('Register error:', err);
        return interaction.editReply('Error registering. Please try again.');
      }
      if (inserted) {
        interaction.editReply('You have been registered for the leaderboard!');
      } else {
        interaction.editReply('You are already registered for this month.');
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

    if (winner.bot || loser.bot) {
      return interaction.editReply('Bot accounts cannot be reported in matches.');
    }

    // Block if either player already has a pending confirmation in flight
    for (const [, pending] of pendingMatches) {
      if (pending.winner.id === winner.id || pending.winner.id === loser.id ||
          pending.loser.id === winner.id || pending.loser.id === loser.id) {
        return interaction.editReply('One of these players already has a match pending confirmation. Please wait for it to be resolved first.');
      }
    }

    const isAdmin = interaction.member.permissions.has('Administrator');
    const isInvolved = reporter === winner.id || reporter === loser.id;
    if (!isAdmin && !isInvolved) {
      return interaction.editReply('You are not authorized to report this match. Only admins or the players involved can report match results.');
    }

    // If an admin reports it, skip confirmation and record immediately
    if (isAdmin && !isInvolved) {
      return recordMatch(winner, loser, reporter, month, interaction);
    }

    // The other player must confirm — figure out who that is
    const confirmerId = reporter === winner.id ? loser.id : winner.id;
    const confirmerMention = `<@${confirmerId}>`;
    const matchId = `match_${winner.id}_${loser.id}_${Date.now()}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_${matchId}`)
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`deny_${matchId}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
      .setTitle('Match Result Pending Confirmation')
      .setColor(0xFFA500)
      .setDescription(`**${winner.username}** defeated **${loser.username}**\n\n${confirmerMention}, please confirm or deny this result.\n\n*This request expires in 5 minutes.*`);

    const reply = await interaction.editReply({ embeds: [embed], components: [row] });

    // Store pending match data
    pendingMatches.set(matchId, {
      winner,
      loser,
      reporter,
      month,
      confirmerId,
      messageId: reply.id,
      interaction
    });

    // Auto-expire after 5 minutes
    setTimeout(() => {
      if (pendingMatches.has(matchId)) {
        pendingMatches.delete(matchId);
        const expiredEmbed = new EmbedBuilder()
          .setTitle('Match Result Expired')
          .setColor(0x808080)
          .setDescription(`Match between **${winner.username}** and **${loser.username}** was not confirmed in time and has been cancelled.`);
        interaction.editReply({ embeds: [expiredEmbed], components: [] }).catch(() => {});
      }
    }, 5 * 60 * 1000);

  } else if (commandName === 'leaderboard') {
    await interaction.deferReply();
    const month = getCurrentMonth();
    db.all(`SELECT name, points FROM players WHERE month = ? ORDER BY points DESC LIMIT 10`, [month], (err, rows) => {
      if (err) {
        console.error(err);
        return interaction.editReply('Error fetching leaderboard.');
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

      interaction.editReply({ embeds: [embed] });
    });
  } else if (commandName === 'stats') {
    await interaction.deferReply();
    const player = interaction.options.getUser('player') || interaction.user;
    const month = getCurrentMonth();

    db.get(`SELECT points FROM players WHERE id = ? AND month = ?`, [player.id, month], (err, playerRow) => {
      if (err) {
        console.error('Stats player lookup error:', err);
        return interaction.editReply('Error fetching stats.');
      }
      if (!playerRow) {
        return interaction.editReply(`${player.username} is not registered for this month.`);
      }

      db.get(`SELECT COUNT(*) AS wins FROM matches WHERE winner_id = ? AND month = ?`, [player.id, month], (err2, winsRow) => {
        if (err2) {
          console.error('Stats wins query error:', err2);
          return interaction.editReply('Error fetching stats.');
        }

        db.get(`SELECT COUNT(*) AS losses FROM matches WHERE loser_id = ? AND month = ?`, [player.id, month], (err3, lossesRow) => {
          if (err3) {
            console.error('Stats losses query error:', err3);
            return interaction.editReply('Error fetching stats.');
          }

          db.all(`SELECT winner_id, loser_id FROM matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? ORDER BY id DESC`, [player.id, player.id, month], (err4, matchRows) => {
            if (err4) {
              console.error('Stats streak query error:', err4);
              return interaction.editReply('Error fetching stats.');
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

            interaction.editReply({ embeds: [embed] });
          });
        });
      });
    });
  } else if (commandName === 'history') {
    await interaction.deferReply();
    const monthInput = interaction.options.getString('month');
    const player = interaction.options.getUser('player');

    // Helper: convert a raw month key into a readable label
    function formatMonthLabel(key) {
      const resetMatch = key.match(/^(\d{4}-\d{2})-reset-(\d+)$/);
      if (resetMatch) return `${resetMatch[1]} — Reset #${resetMatch[2]}`;
      return key;
    }

    if (!monthInput) {
      db.all(`SELECT DISTINCT month FROM players ORDER BY month DESC`, [], (err, rows) => {
        if (err) {
          console.error('History months query error:', err);
          return interaction.editReply('Error fetching history.');
        }
        if (rows.length === 0) {
          return interaction.editReply('No historical data found yet.');
        }

        const currentMonth = getCurrentMonth();
        const lines = rows.map(r => {
          const label = formatMonthLabel(r.month);
          const isCurrent = r.month === currentMonth;
          return `• **${label}**${isCurrent ? ' *(current)*' : ''} — \`/history month:${r.month}\``;
        });

        const embed = new EmbedBuilder()
          .setTitle('Available Monthly Records')
          .setColor(0x9B59B6)
          .setDescription(lines.join('\n'));
        interaction.editReply({ embeds: [embed] });
      });
      return;
    }

    const monthRegex = /^\d{4}-\d{2}(-reset-\d+)?$/;
    if (!monthRegex.test(monthInput)) {
      return interaction.editReply('Invalid format. Use `YYYY-MM` for a regular month or copy the key shown in `/history`.');
    }

    const displayLabel = formatMonthLabel(monthInput);

    if (player) {
      db.get(`SELECT points FROM players WHERE id = ? AND month = ?`, [player.id, monthInput], (err, playerRow) => {
        if (err) {
          console.error('History stats lookup error:', err);
          return interaction.editReply('Error fetching history.');
        }
        if (!playerRow) {
          return interaction.editReply(`${player.username} has no data for **${displayLabel}**.`);
        }

        db.get(`SELECT COUNT(*) AS wins FROM matches WHERE winner_id = ? AND month = ?`, [player.id, monthInput], (err2, winsRow) => {
          if (err2) return interaction.editReply('Error fetching history.');
          db.get(`SELECT COUNT(*) AS losses FROM matches WHERE loser_id = ? AND month = ?`, [player.id, monthInput], (err3, lossesRow) => {
            if (err3) return interaction.editReply('Error fetching history.');

            const wins = winsRow.wins || 0;
            const losses = lossesRow.losses || 0;
            const totalMatches = wins + losses;
            const winRate = totalMatches === 0 ? '0%' : `${Math.round((wins / totalMatches) * 100)}%`;

            const embed = new EmbedBuilder()
              .setTitle(`${player.username}'s Stats — ${displayLabel}`)
              .setColor(0x9B59B6)
              .addFields(
                { name: 'Points', value: `${playerRow.points}`, inline: true },
                { name: 'Wins', value: `${wins}`, inline: true },
                { name: 'Losses', value: `${losses}`, inline: true },
                { name: 'Win Rate', value: `${winRate}`, inline: true }
              );
            interaction.editReply({ embeds: [embed] });
          });
        });
      });
    } else {
      db.all(`SELECT name, points FROM players WHERE month = ? ORDER BY points DESC LIMIT 10`, [monthInput], (err, rows) => {
        if (err) {
          console.error('History leaderboard query error:', err);
          return interaction.editReply('Error fetching history.');
        }

        const embed = new EmbedBuilder()
          .setTitle(`Leaderboard — ${displayLabel}`)
          .setColor(0x9B59B6);

        if (rows.length === 0) {
          embed.setDescription(`No data found for **${displayLabel}**.`);
        } else {
          embed.setDescription(rows.map((row, i) => `${i + 1}. ${row.name}: ${row.points} points`).join('\n'));
        }
        interaction.editReply({ embeds: [embed] });
      });
    }
  } else if (commandName === 'match_history') {
    await interaction.deferReply();
    const player = interaction.options.getUser('player') || interaction.user;
    const monthInput = interaction.options.getString('month');
    const month = monthInput || getCurrentMonth();

    const monthRegex = /^\d{4}-\d{2}(-reset-\d+)?$/;
    if (monthInput && !monthRegex.test(monthInput)) {
      return interaction.editReply('Invalid format. Use `YYYY-MM` for a regular month or copy the key shown in `/history`.');
    }

    function formatMonthLabel(key) {
      const resetMatch = key.match(/^(\d{4}-\d{2})-reset-(\d+)$/);
      if (resetMatch) return `${resetMatch[1]} — Reset #${resetMatch[2]}`;
      return key;
    }

    db.all(
      `SELECT m.id, m.winner_id, m.loser_id, m.timestamp,
              pw.name AS winner_name, pl.name AS loser_name
       FROM matches m
       LEFT JOIN players pw ON pw.id = m.winner_id AND pw.month = m.month
       LEFT JOIN players pl ON pl.id = m.loser_id AND pl.month = m.month
       WHERE (m.winner_id = ? OR m.loser_id = ?) AND m.month = ?
       ORDER BY m.id DESC LIMIT 10`,
      [player.id, player.id, month],
      (err, rows) => {
        if (err) {
          console.error('Match history query error:', err);
          return interaction.editReply('Error fetching match history.');
        }

        const displayLabel = formatMonthLabel(month);

        if (rows.length === 0) {
          return interaction.editReply(`No matches found for **${player.username}** in **${displayLabel}**.`);
        }

        const lines = rows.map((row, i) => {
          const won = row.winner_id === player.id;
          const opponentName = won ? (row.loser_name || 'Unknown') : (row.winner_name || 'Unknown');
          const result = won ? '✅ Win ' : '❌ Loss';
          const date = row.timestamp
            ? new Date(row.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
            : '—';
          return `\`#${rows.length - i}\` ${result}  vs  **${opponentName}**  —  ${date}`;
        }).reverse();

        const embed = new EmbedBuilder()
          .setTitle(`Match History — ${player.username}  |  ${displayLabel}`)
          .setColor(0x0099FF)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `Showing last ${rows.length} match${rows.length === 1 ? '' : 'es'}` });

        interaction.editReply({ embeds: [embed] });
      }
    );
  } else if (commandName === 'help') {
    await interaction.deferReply({ ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle('Hideout TCG Ranked Bot Help')
      .setColor(0xFFD700)
      .setDescription('Use these commands to manage rankings and view stats.')
      .addFields(
        { name: '/register', value: 'Register yourself for the monthly leaderboard.', inline: false },
        { name: '/report_match', value: 'Report a match result with winner and loser.', inline: false },
        { name: '/leaderboard', value: 'View the current monthly leaderboard.', inline: false },
        { name: '/stats', value: 'Show monthly stats for yourself or another player.', inline: false },
        { name: '/match_history', value: 'View your last 10 match results. Optionally tag another player or specify a month.', inline: false },
        { name: '/history', value: 'View leaderboard or player stats for a past month. Leave month blank to list all available months.', inline: false },
        { name: '/reset_monthly', value: 'Reset the monthly leaderboard (Admin only).', inline: false },
        { name: '/undo_match', value: 'Undo the last match for a player (Admin only).', inline: false },
        { name: '/set_score', value: 'Set a player score manually (Admin only).', inline: false }
      );

    interaction.editReply({ embeds: [embed] });
  } else if (commandName === 'reset_monthly') {
    await interaction.deferReply();
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.editReply('You do not have permission to reset the leaderboard.');
    }

    const currentMonth = getCurrentMonth();

    // Count how many resets already exist for this month to get the next number
    db.all(`SELECT month FROM players WHERE month LIKE ? ORDER BY month ASC`, [`${currentMonth}-reset-%`], (countErr, existingResets) => {
      if (countErr) {
        console.error('Reset count error:', countErr);
        return interaction.editReply('Error preparing reset.');
      }

      const resetNumber = existingResets.length + 1;
      const archiveKey = `${currentMonth}-reset-${resetNumber}`;

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(`UPDATE players SET month = ? WHERE month = ?`, [archiveKey, currentMonth], function(err) {
          if (err) {
            db.run('ROLLBACK');
            console.error('Reset archive players error:', err);
            return interaction.editReply('Error archiving leaderboard data.');
          }
          db.run(`UPDATE matches SET month = ? WHERE month = ?`, [archiveKey, currentMonth], function(err2) {
            if (err2) {
              db.run('ROLLBACK');
              console.error('Reset archive matches error:', err2);
              return interaction.editReply('Error archiving match history.');
            }
            db.run('COMMIT', function(err3) {
              if (err3) {
                console.error('Reset commit error:', err3);
                return interaction.editReply('Error saving reset. Please try again.');
              }
              interaction.editReply(`Monthly leaderboard for **${currentMonth}** has been reset (archive: Reset #${resetNumber}). Use \`/history\` to view past data. Points start fresh from 0.`);
            });
          });
        });
      });
    });
  } else if (commandName === 'undo_match') {
    await interaction.deferReply();
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.editReply('You do not have permission to undo matches.');
    }

    const player = interaction.options.getUser('player');
    const month = getCurrentMonth();

    db.get(`SELECT id, winner_id, loser_id FROM matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? ORDER BY id DESC LIMIT 1`, [player.id, player.id, month], (err, row) => {
      if (err || !row) {
        return interaction.editReply('No recent match found for this player.');
      }

      const pointsWinner = row.winner_id;
      const pointsLoser = row.loser_id;

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(`UPDATE players SET points = points - 1 WHERE id = ? AND month = ?`, [pointsWinner, month], function(err2) {
          if (err2) {
            db.run('ROLLBACK');
            console.error('Undo winner points error:', err2);
            return interaction.editReply('Error undoing match points.');
          }
          db.run(`UPDATE players SET points = points + 1 WHERE id = ? AND month = ?`, [pointsLoser, month], function(err3) {
            if (err3) {
              db.run('ROLLBACK');
              console.error('Undo loser points error:', err3);
              return interaction.editReply('Error undoing match points.');
            }
            db.run(`DELETE FROM matches WHERE id = ?`, [row.id], function(err4) {
              if (err4) {
                db.run('ROLLBACK');
                console.error('Undo match delete error:', err4);
                return interaction.editReply('Error deleting match record.');
              }
              db.run('COMMIT', function(err5) {
                if (err5) {
                  console.error('Undo commit error:', err5);
                  return interaction.editReply('Error saving undo. Please try again.');
                }
                interaction.editReply(`Last match for ${player.username} has been undone.`);
              });
            });
          });
        });
      });
    });
  } else if (commandName === 'set_score') {
    await interaction.deferReply();
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.editReply('You do not have permission to set scores.');
    }

    const player = interaction.options.getUser('player');
    const points = interaction.options.getInteger('points');
    const month = getCurrentMonth();

    ensurePlayerForMonth(player.id, player.username, month, (ensureErr) => {
      if (ensureErr) {
        console.error('set_score ensure error:', ensureErr);
        return interaction.editReply('Error preparing player record.');
      }
      db.run(`UPDATE players SET points = ? WHERE id = ? AND month = ?`, [points, player.id, month], function(err) {
        if (err) {
          console.error(err);
          return interaction.editReply('Error setting score.');
        }
        interaction.editReply(`${player.username}'s score has been set to ${points} points.`);
      });
    });
  }
});

// Handle button interactions (match confirmations)
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const { customId } = interaction;
  if (!customId.startsWith('confirm_') && !customId.startsWith('deny_')) return;

  const matchId = customId.replace('confirm_', '').replace('deny_', '');
  const pending = pendingMatches.get(matchId);

  if (!pending) {
    return interaction.reply({ content: 'This match request has already been handled or has expired.', ephemeral: true });
  }

  const { winner, loser, reporter, month, confirmerId, interaction: originalInteraction } = pending;

  // Only the designated confirmer (the other player) can respond
  if (interaction.user.id !== confirmerId) {
    return interaction.reply({ content: 'Only the other player involved in this match can confirm or deny it.', ephemeral: true });
  }

  pendingMatches.delete(matchId);
  await interaction.deferUpdate();

  if (customId.startsWith('confirm_')) {
    recordMatch(winner, loser, reporter, month, originalInteraction);
  } else {
    const deniedEmbed = new EmbedBuilder()
      .setTitle('Match Denied')
      .setColor(0xFF4444)
      .setDescription(`**${interaction.user.username}** denied the match result.\n**${winner.username}** vs **${loser.username}** — no points recorded.`);
    originalInteraction.editReply({ embeds: [deniedEmbed], components: [] });
  }
});

// Monthly rollover notifier (1st of every month at midnight)
cron.schedule('0 0 1 * *', () => {
  console.log('New monthly leaderboard cycle started:', getCurrentMonth());
});

// Discord client error handling — prevents crashes from connection issues
client.on('error', (error) => {
  console.error('Discord client error:', error.message);
});

client.on('warn', (info) => {
  console.warn('Discord warning:', info);
});


// Catch unhandled promise rejections — prevents the process from crashing
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection:', reason);
});

// Catch uncaught exceptions — log and keep running instead of crashing
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error.message);
  console.error(error.stack);
});

// Ensure token exists
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN not found in .env file!');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);