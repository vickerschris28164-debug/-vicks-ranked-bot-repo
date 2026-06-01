const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
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
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
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

  db.run(`CREATE TABLE IF NOT EXISTS archived_leaderboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT,
    player_id TEXT,
    player_name TEXT,
    final_points INTEGER,
    wins INTEGER,
    losses INTEGER,
    archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS archived_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT,
    winner_id TEXT,
    loser_id TEXT,
    reported_by TEXT,
    timestamp DATETIME,
    archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

function parseMonthInput(input) {
  if (!input) return null;
  const month = input.trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
}

function getPreviousMonth() {
  const now = new Date();
  now.setMonth(now.getMonth() - 1);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function archiveMonth(month, callback) {
  db.serialize(() => {
    db.all(
      `SELECT
         p.id AS player_id,
         p.name AS player_name,
         p.points AS final_points,
         COALESCE(w.wins, 0) AS wins,
         COALESCE(l.losses, 0) AS losses
       FROM players p
       LEFT JOIN (
         SELECT winner_id, COUNT(*) AS wins
         FROM matches WHERE month = ?
         GROUP BY winner_id
       ) w ON w.winner_id = p.id
       LEFT JOIN (
         SELECT loser_id, COUNT(*) AS losses
         FROM matches WHERE month = ?
         GROUP BY loser_id
       ) l ON l.loser_id = p.id
       WHERE p.month = ?`,
      [month, month, month],
      (err, rows) => {
        if (err) return callback(err);
        if (rows.length === 0) return callback(null, 0);

        const insertStmt = db.prepare(
          `INSERT INTO archived_leaderboards (month, player_id, player_name, final_points, wins, losses)
           VALUES (?, ?, ?, ?, ?, ?)`
        );

        let insertError = null;
        rows.forEach(row => {
          insertStmt.run(
            [month, row.player_id, row.player_name, row.final_points, row.wins, row.losses],
            err2 => { if (err2) insertError = err2; }
          );
        });

        insertStmt.finalize(err2 => {
          if (err2 || insertError) return callback(err2 || insertError);

          db.all(
            `SELECT winner_id, loser_id, reported_by, timestamp, month
             FROM matches
             WHERE month = ?`,
            [month],
            (err3, matchRows) => {
              if (err3) return callback(err3);

              const matchInsert = db.prepare(
                `INSERT INTO archived_matches (month, winner_id, loser_id, reported_by, timestamp)
                 VALUES (?, ?, ?, ?, ?)`
              );

              let matchInsertError = null;
              matchRows.forEach(matchRow => {
                matchInsert.run(
                  [matchRow.month, matchRow.winner_id, matchRow.loser_id, matchRow.reported_by, matchRow.timestamp],
                  err4 => { if (err4) matchInsertError = err4; }
                );
              });

              matchInsert.finalize(err4 => {
                if (err4 || matchInsertError) return callback(err4 || matchInsertError);

                db.run(`DELETE FROM players WHERE month = ?`, [month], err5 => {
                  if (err5) return callback(err5);

                  db.run(`DELETE FROM matches WHERE month = ?`, [month], err6 => {
                    if (err6) return callback(err6);
                    callback(null, rows.length);
                  });
                });
              });
            }
          );
        });
      }
    );
  });
}

function fetchLeaderboardForMonth(month, callback) {
  if (month === getCurrentMonth()) {
    db.all(`SELECT name, points FROM players WHERE month = ? ORDER BY points DESC LIMIT 10`, [month], callback);
  } else {
    db.all(`SELECT player_name AS name, final_points AS points FROM archived_leaderboards WHERE month = ? ORDER BY final_points DESC LIMIT 10`, [month], callback);
  }
}

function fetchRecentHistoryMonths(limit, callback) {
  db.all(
    `SELECT month FROM (
       SELECT DISTINCT month FROM players
       UNION
       SELECT DISTINCT month FROM archived_leaderboards
     ) ORDER BY month DESC LIMIT ?`,
    [limit],
    callback
  );
}

function fetchMonthTopPlayers(month, limit, callback) {
  if (month === getCurrentMonth()) {
    db.all(`SELECT name, points FROM players WHERE month = ? ORDER BY points DESC LIMIT ?`, [month, limit], callback);
  } else {
    db.all(`SELECT player_name AS name, final_points AS points FROM archived_leaderboards WHERE month = ? ORDER BY final_points DESC LIMIT ?`, [month, limit], callback);
  }
}

function fetchArchivedPlayerStats(playerId, month, callback) {
  db.get(
    `SELECT final_points, wins, losses FROM archived_leaderboards WHERE player_id = ? AND month = ? LIMIT 1`,
    [playerId, month],
    (err, row) => {
      if (err) return callback(err);
      if (!row) return callback(null, null);

      db.all(
        `SELECT winner_id, loser_id FROM archived_matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? ORDER BY id DESC`,
        [playerId, playerId, month],
        (err2, matchRows) => {
          if (err2) return callback(err2);

          let streak = 0;
          let streakType = null;
          for (const matchRow of matchRows) {
            const didWin = matchRow.winner_id === playerId;
            if (streakType === null) {
              streakType = didWin ? 'win' : 'loss';
              streak = 1;
            } else if ((didWin && streakType === 'win') || (!didWin && streakType === 'loss')) {
              streak += 1;
            } else {
              break;
            }
          }

          callback(null, {
            points: row.final_points,
            wins: row.wins,
            losses: row.losses,
            streak,
            streakType,
          });
        }
      );
    }
  );
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
      .setName('leaderboard_history')
      .setDescription('View leaderboard history for a month')
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Month to view (YYYY-MM). Leave empty for current month.')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('history_months')
      .setDescription('Show months with saved leaderboard history'),
    new SlashCommandBuilder()
      .setName('monthly_summary')
      .setDescription('Show a summary of recent monthly leaderboards')
      .addIntegerOption(option =>
        option.setName('months')
          .setDescription('Number of recent months to summarize (default 3)')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Show leaderboard stats for a player')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to view stats for')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Month to view (YYYY-MM). Leave empty for current month.')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show bot commands and usage'),
    new SlashCommandBuilder()
      .setName('reset_monthly')
      .setDescription('Reset monthly leaderboard (Admin only)')
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Month to archive (YYYY-MM). Leave empty for current month.')
          .setRequired(false))
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
        rows.forEach((row, index) => {
          embed.addFields({ name: `${index + 1}. ${row.name}`, value: `${row.points} points`, inline: false });
        });
      }

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'leaderboard_history') {
    const monthArg = interaction.options.getString('month');
    const month = monthArg ? parseMonthInput(monthArg) : getCurrentMonth();
    if (monthArg && !month) {
      return interaction.reply('Invalid month format. Use YYYY-MM.');
    }

    fetchLeaderboardForMonth(month, (err, rows) => {
      if (err) {
        console.error('Leaderboard history error:', err);
        return interaction.reply('Error fetching leaderboard history.');
      }

      const embed = new EmbedBuilder()
        .setTitle(`Leaderboard History - ${month}`)
        .setColor(0x0099FF);

      if (rows.length === 0) {
        embed.setDescription(`No leaderboard history found for ${month}.`);
      } else {
        rows.forEach((row, index) => {
          embed.addFields({ name: `${index + 1}. ${row.name}`, value: `${row.points} points`, inline: false });
        });
      }

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'history_months') {
    fetchRecentHistoryMonths(20, (err, rows) => {
      if (err) {
        console.error('History months error:', err);
        return interaction.reply('Error fetching saved history months.');
      }

      const embed = new EmbedBuilder()
        .setTitle('Saved History Months')
        .setColor(0x00AAFF);

      if (rows.length === 0) {
        embed.setDescription('No saved history months found.');
      } else {
        embed.setDescription(rows.map(row => `• ${row.month}`).join('\n'));
      }

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'monthly_summary') {
    const months = interaction.options.getInteger('months') || 3;
    if (months <= 0 || months > 12) {
      return interaction.reply('Please enter a months value between 1 and 12.');
    }

    await interaction.deferReply();

    fetchRecentHistoryMonths(months, async (err, rows) => {
      if (err) {
        console.error('Monthly summary error:', err);
        return interaction.editReply('Error fetching monthly summary.');
      }
      if (rows.length === 0) {
        return interaction.editReply('No monthly history available to summarize.');
      }

      const tempEmbed = new EmbedBuilder()
        .setTitle(`Monthly Summary - Last ${rows.length} Month${rows.length === 1 ? '' : 's'}`)
        .setColor(0x00CC99);

      rows.forEach(row => {
        tempEmbed.addFields({ name: row.month, value: 'Loading...', inline: false });
      });

      await interaction.editReply({ embeds: [tempEmbed] });

      const summaryPromises = rows.map(row => {
        return new Promise((resolve) => {
          fetchMonthTopPlayers(row.month, 3, (err2, monthRows) => {
            if (err2) {
              return resolve({ month: row.month, text: 'Error loading month.' });
            }
            if (!monthRows || monthRows.length === 0) {
              return resolve({ month: row.month, text: 'No leaderboard data.' });
            }

            const lines = monthRows.map((playerRow, index) => `${index + 1}. ${playerRow.name}: ${playerRow.points} pts`);
            resolve({ month: row.month, text: lines.join('\n') });
          });
        });
      });

      const summaryRows = await Promise.all(summaryPromises);
      const updatedEmbed = new EmbedBuilder()
        .setTitle(`Monthly Summary - Last ${summaryRows.length} Month${summaryRows.length === 1 ? '' : 's'}`)
        .setColor(0x00CC99);

      summaryRows.forEach(item => {
        updatedEmbed.addFields({ name: item.month, value: item.text, inline: false });
      });

      interaction.editReply({ embeds: [updatedEmbed] });
    });
  } else if (commandName === 'stats') {
    const player = interaction.options.getUser('player') || interaction.user;
    const monthArg = interaction.options.getString('month');
    const month = monthArg ? parseMonthInput(monthArg) : getCurrentMonth();
    if (monthArg && !month) {
      return interaction.reply('Invalid month format. Use YYYY-MM.');
    }

    if (month === getCurrentMonth()) {
      db.get(`SELECT points FROM players WHERE id = ? AND month = ?`, [player.id, month], (err, playerRow) => {
        if (err) {
          console.error('Stats player lookup error:', err);
          return interaction.reply('Error fetching stats.');
        }
        if (!playerRow) {
          return interaction.reply(`${player.username} is not registered for ${month}.`);
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
                  { name: 'Current Streak', value: `${streakText}`, inline: true }
                );

              interaction.reply({ embeds: [embed] });
            });
          });
        });
      });
    } else {
      fetchArchivedPlayerStats(player.id, month, (err, statsRow) => {
        if (err) {
          console.error('Archived stats lookup error:', err);
          return interaction.reply('Error fetching archived stats.');
        }
        if (!statsRow) {
          return interaction.reply(`${player.username} has no stats saved for ${month}.`);
        }

        const totalMatches = statsRow.wins + statsRow.losses;
        const winRate = totalMatches === 0 ? '0%' : `${Math.round((statsRow.wins / totalMatches) * 100)}%`;
        const streakText = statsRow.streakType ? `${statsRow.streak} ${statsRow.streakType}${statsRow.streak === 1 ? '' : 's'}` : 'None';

        const embed = new EmbedBuilder()
          .setTitle(`${player.username}'s Monthly Stats - ${month}`)
          .setColor(0x00FF99)
          .addFields(
            { name: 'Points', value: `${statsRow.points}`, inline: true },
            { name: 'Wins', value: `${statsRow.wins}`, inline: true },
            { name: 'Losses', value: `${statsRow.losses}`, inline: true },
            { name: 'Win Rate', value: `${winRate}`, inline: true },
            { name: 'Current Streak', value: `${streakText}`, inline: true }
          );

        interaction.reply({ embeds: [embed] });
      });
    }
  } else if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('Hideout TCG Ranked Bot Help')
      .setColor(0xFFD700)
      .setDescription('Use these commands to manage rankings, view stats, and access month history.')
      .addFields(
        { name: '/register', value: 'Register yourself for the monthly leaderboard.', inline: false },
        { name: '/report_match', value: 'Report a match result with winner and loser.', inline: false },
        { name: '/leaderboard', value: 'View the current monthly leaderboard.', inline: false },
        { name: '/leaderboard_history', value: 'View leaderboard history for a previous month.', inline: false },
        { name: '/history_months', value: 'Show months with saved leaderboard history.', inline: false },
        { name: '/monthly_summary', value: 'Summarize recent monthly leaderboards.', inline: false },
        { name: '/stats', value: 'Show monthly stats for yourself or another player.', inline: false },
        { name: '/reset_monthly', value: 'Reset the monthly leaderboard and save the month to history (Admin only).', inline: false },
        { name: '/undo_match', value: 'Undo the last match for a player (Admin only).', inline: false },
        { name: '/set_score', value: 'Set a player score manually (Admin only).', inline: false }
      );

    interaction.reply({ embeds: [embed], ephemeral: true });
  } else if (commandName === 'reset_monthly') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('You do not have permission to reset the leaderboard.');
    }

    await interaction.deferReply();

    const monthArg = interaction.options.getString('month');
    const targetMonth = monthArg ? parseMonthInput(monthArg) : getCurrentMonth();
    if (monthArg && !targetMonth) {
      return interaction.editReply('Invalid month format. Use YYYY-MM.');
    }

    archiveMonth(targetMonth, (err, count) => {
      if (err) {
        console.error('Reset monthly archive error:', err);
        return interaction.editReply('Error archiving leaderboard data.');
      }

      if (count === 0) {
        return interaction.editReply(`No players found for **${archiveMonth}**. Nothing to archive.`);
      }

      console.log(`Archived ${count} player(s) for month ${archiveMonth} and cleared leaderboard.`);
      interaction.editReply(
        `✅ **${archiveMonth}** leaderboard archived (${count} player${count === 1 ? '' : 's'}) and reset for the new month.`
      );
    });
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

    ensurePlayerForMonth(player.id, player.username, month, (ensureErr) => {
      if (ensureErr) {
        console.error('set_score ensure error:', ensureErr);
        return interaction.reply('Error preparing player record.');
      }

      db.run(`UPDATE players SET points = ? WHERE id = ? AND month = ?`, [points, player.id, month], function(err) {
        if (err) {
          console.error(err);
          return interaction.reply('Error setting score.');
        }
        interaction.reply(`${player.username}'s score has been set to ${points} points.`);
      });
    });
  }
});

// Automatic monthly archive for the previous month (runs at 00:00 on the 1st of each month)
cron.schedule('0 0 1 * *', () => {
  const previousMonth = getPreviousMonth();
  archiveMonth(previousMonth, (err, count) => {
    if (err) {
      return console.error(`Automatic archive error for ${previousMonth}:`, err);
    }
    if (count > 0) {
      console.log(`Automatically archived ${count} player(s) for month ${previousMonth}.`);
    } else {
      console.log(`No data found for automatic archive of ${previousMonth}.`);
    }
  });
});

// Ensure token exists
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN not found in .env file!');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);