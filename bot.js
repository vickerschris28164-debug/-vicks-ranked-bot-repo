const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

  db.run(`CREATE TABLE IF NOT EXISTS pending_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    winner_id TEXT,
    winner_name TEXT,
    loser_id TEXT,
    loser_name TEXT,
    reported_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    month TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

function canReportMatch(winnerId, loserId, callback) {
  db.get(
    `SELECT COUNT(*) AS count FROM matches
     WHERE ((winner_id = ? AND loser_id = ?) OR (winner_id = ? AND loser_id = ?))
       AND timestamp >= datetime('now','-2 hours')`,
    [winnerId, loserId, loserId, winnerId],
    (err, row) => {
      if (err) return callback(err);
      if (row && row.count > 0) return callback(null, false);
      db.get(
        `SELECT COUNT(*) AS count FROM pending_reports
         WHERE ((winner_id = ? AND loser_id = ?) OR (winner_id = ? AND loser_id = ?))
           AND created_at >= datetime('now','-2 hours')`,
        [winnerId, loserId, loserId, winnerId],
        (err2, row2) => {
          if (err2) return callback(err2);
          callback(null, !row2 || row2.count === 0);
        }
      );
    }
  );
}

function storePendingAction(type, payload, callback) {
  db.run(`INSERT INTO pending_actions (action_type, payload) VALUES (?, ?)`, [type, JSON.stringify(payload)], function(err) {
    callback(err, this.lastID);
  });
}

function getPendingActionById(id, callback) {
  db.get(`SELECT * FROM pending_actions WHERE id = ?`, [id], callback);
}

function deletePendingActionById(id, callback) {
  db.run(`DELETE FROM pending_actions WHERE id = ?`, [id], callback);
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

function determineLevel(points) {
  if (points >= 20) return 'Legend';
  if (points >= 10) return 'Elite';
  if (points >= 5) return 'Challenger';
  if (points >= 1) return 'Apprentice';
  if (points === 0) return 'Rookie';
  return 'Novice';
}

function determineBadges(stats) {
  const badges = [];
  if (!stats) return badges;
  if (stats.wins >= 10 && stats.winRate >= 80) badges.push('Clutch Winner');
  if (stats.streakType === 'win' && stats.streak >= 3) badges.push('Hot Streak');
  if (stats.losses === 0 && stats.wins >= 3) badges.push('Unbeaten');
  if (stats.winRate >= 60 && stats.wins >= 5) badges.push('Resilient');
  if (stats.points >= 15) badges.push('Power Player');
  if (stats.points < 0) badges.push('Battle Tested');
  if (badges.length === 0) badges.push('Rising Star');
  return badges;
}

function getPlayerMonthStats(playerId, month, callback) {
  if (month === getCurrentMonth()) {
    db.get(`SELECT points FROM players WHERE id = ? AND month = ?`, [playerId, month], (err, playerRow) => {
      if (err) return callback(err);
      if (!playerRow) return callback(null, null);

      db.get(`SELECT COUNT(*) AS wins FROM matches WHERE winner_id = ? AND month = ?`, [playerId, month], (err2, winsRow) => {
        if (err2) return callback(err2);

        db.get(`SELECT COUNT(*) AS losses FROM matches WHERE loser_id = ? AND month = ?`, [playerId, month], (err3, lossesRow) => {
          if (err3) return callback(err3);

          db.all(`SELECT winner_id, loser_id FROM matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? ORDER BY id DESC`, [playerId, playerId, month], (err4, matchRows) => {
            if (err4) return callback(err4);

            let streak = 0;
            let streakType = null;
            for (const row of matchRows) {
              const didWin = row.winner_id === playerId;
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
            const winRate = totalMatches === 0 ? 0 : Math.round((wins / totalMatches) * 100);

            callback(null, {
              points: playerRow.points,
              wins,
              losses,
              winRate,
              streak,
              streakType,
            });
          });
        });
      });
    });
  } else {
    fetchArchivedPlayerStats(playerId, month, (err, statsRow) => {
      if (err) return callback(err);
      if (!statsRow) return callback(null, null);

      const totalMatches = statsRow.wins + statsRow.losses;
      const winRate = totalMatches === 0 ? 0 : Math.round((statsRow.wins / totalMatches) * 100);
      callback(null, {
        points: statsRow.points,
        wins: statsRow.wins,
        losses: statsRow.losses,
        winRate,
        streak: statsRow.streak,
        streakType: statsRow.streakType,
      });
    });
  }
}

function computeCurrentStreakForPlayer(playerId, month, callback) {
  db.all(`SELECT winner_id, loser_id FROM matches WHERE (winner_id = ? OR loser_id = ?) AND month = ? ORDER BY id DESC`, [playerId, playerId, month], (err, matchRows) => {
    if (err) return callback(err);

    let streak = 0;
    let streakType = null;
    for (const row of matchRows) {
      const didWin = row.winner_id === playerId;
      if (streakType === null) {
        streakType = didWin ? 'win' : 'loss';
        streak = 1;
      } else if ((didWin && streakType === 'win') || (!didWin && streakType === 'loss')) {
        streak += 1;
      } else {
        break;
      }
    }

    callback(null, { streak, streakType });
  });
}

function computeTopStreaks(month, limit, callback) {
  db.all(`SELECT id, name FROM players WHERE month = ?`, [month], (err, players) => {
    if (err) return callback(err);
    if (!players || players.length === 0) return callback(null, []);

    let pending = players.length;
    const results = [];

    players.forEach(player => {
      computeCurrentStreakForPlayer(player.id, month, (err2, streakInfo) => {
        if (!err2 && streakInfo.streak > 0) {
          results.push({ name: player.name, ...streakInfo });
        }
        pending -= 1;
        if (pending === 0) {
          results.sort((a, b) => b.streak - a.streak || (a.streakType === 'win' ? 0 : 1) - (b.streakType === 'win' ? 0 : 1));
          callback(null, results.slice(0, limit));
        }
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
      .setName('top_streaks')
      .setDescription('Show the current top win streaks'),
    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Show a player profile with level and badges')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to view')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Month to view (YYYY-MM). Leave empty for current month.')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('winrate')
      .setDescription('Show a player win rate')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to view')
          .setRequired(false))
      .addStringOption(option =>
        option.setName('month')
          .setDescription('Month to view (YYYY-MM). Leave empty for current month.')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('shoutout')
      .setDescription('Give a player a public shoutout')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to shoutout')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('reason')
          .setDescription('Reason for the shoutout')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('monthly_summary')
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
    new SlashCommandBuilder()
      .setName('rules')
      .setDescription('Display the server rules for ranked players'),
  ];

  await client.application.commands.set(commands);
  console.log('Slash commands registered.');
});

// Handle interactions
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    const customId = interaction.customId || '';

    if (customId.startsWith('confirm_match_') || customId.startsWith('reject_match_')) {
      const [action, , idString] = customId.split('_');
      const pendingId = parseInt(idString, 10);
      if (isNaN(pendingId)) {
        return interaction.reply({ content: 'Invalid match confirmation request.', ephemeral: true });
      }

      db.get(`SELECT * FROM pending_reports WHERE id = ?`, [pendingId], (err, row) => {
        if (err) {
          console.error('Pending report lookup error:', err);
          return interaction.reply({ content: 'Error processing match confirmation.', ephemeral: true });
        }
        if (!row) {
          return interaction.reply({ content: 'This match report is no longer pending or has already been resolved.', ephemeral: true });
        }
        if (interaction.user.id !== row.loser_id) {
          return interaction.reply({ content: 'Only the reported loser can confirm or reject this match.', ephemeral: true });
        }

        if (action === 'reject') {
          db.run(`DELETE FROM pending_reports WHERE id = ?`, [pendingId], err2 => {
            if (err2) console.error('Pending report delete error:', err2);
            interaction.update({ content: `Match report rejected by ${interaction.user.username}.`, components: [] });
          });
          return;
        }

        // Confirm the match and apply it to the leaderboard
        ensurePlayerForMonth(row.winner_id, row.winner_name, row.month, (err2) => {
          if (err2) {
            console.error('Winner ensure error on confirmation:', err2);
            return interaction.reply({ content: 'Error confirming match.', ephemeral: true });
          }

          ensurePlayerForMonth(row.loser_id, row.loser_name, row.month, (err3) => {
            if (err3) {
              console.error('Loser ensure error on confirmation:', err3);
              return interaction.reply({ content: 'Error confirming match.', ephemeral: true });
            }

            db.run(
              `INSERT INTO matches (winner_id, loser_id, reported_by, month) VALUES (?, ?, ?, ?)`,
              [row.winner_id, row.loser_id, row.reported_by, row.month],
              function(err4) {
                if (err4) {
                  console.error('Match insert error on confirmation:', err4);
                  return interaction.reply({ content: 'Error saving confirmed match.', ephemeral: true });
                }

                db.run(`UPDATE players SET points = points + 1 WHERE id = ? AND month = ?`, [row.winner_id, row.month], err5 => {
                  if (err5) console.error('Winner points update error on confirmation:', err5);
                });
                db.run(`UPDATE players SET points = points - 1 WHERE id = ? AND month = ?`, [row.loser_id, row.month], err6 => {
                  if (err6) console.error('Loser points update error on confirmation:', err6);
                });
                db.run(`DELETE FROM pending_reports WHERE id = ?`, [pendingId], err7 => {
                  if (err7) console.error('Pending report delete error on confirmation:', err7);
                  interaction.update({ content: `Match confirmed! ${row.winner_name} defeated ${row.loser_name}.`, components: [] });
                });
              }
            );
          });
        });
      });
      return;
    }

    if (customId.startsWith('confirm_reset_month_') || customId.startsWith('reject_reset_month_')) {
      const [action, , , idString] = customId.split('_');
      const pendingId = parseInt(idString, 10);
      if (isNaN(pendingId)) {
        return interaction.reply({ content: 'Invalid reset confirmation request.', ephemeral: true });
      }

      getPendingActionById(pendingId, (err, pending) => {
        if (err) {
          console.error('Pending action lookup error:', err);
          return interaction.reply({ content: 'Error processing reset confirmation.', ephemeral: true });
        }
        if (!pending) {
          return interaction.reply({ content: 'This reset request is no longer pending or has already been resolved.', ephemeral: true });
        }
        const payload = JSON.parse(pending.payload);
        if (interaction.user.id !== payload.requestedBy) {
          return interaction.reply({ content: 'Only the admin who requested this reset can confirm or reject it.', ephemeral: true });
        }

        if (action === 'reject') {
          deletePendingActionById(pendingId, err2 => {
            if (err2) console.error('Pending reset delete error:', err2);
            interaction.update({ content: `Monthly reset cancelled by ${interaction.user.username}.`, components: [] });
          });
          return;
        }

        archiveMonth(payload.month, (err2, count) => {
          if (err2) {
            console.error('Reset monthly archive error:', err2);
            return interaction.update({ content: 'Error archiving leaderboard data.', components: [] });
          }

          deletePendingActionById(pendingId, err3 => {
            if (err3) console.error('Pending reset delete error:', err3);
            if (count === 0) {
              interaction.update({ content: `No players found for **${payload.month}**. Nothing was archived.`, components: [] });
            } else {
              interaction.update({ content: `✅ **${payload.month}** leaderboard archived (${count} player${count === 1 ? '' : 's'}) and reset for the new month.`, components: [] });
            }
          });
        });
      });
      return;
    }

    if (customId.startsWith('confirm_undo_match_') || customId.startsWith('reject_undo_match_')) {
      const [action, , , idString] = customId.split('_');
      const pendingId = parseInt(idString, 10);
      if (isNaN(pendingId)) {
        return interaction.reply({ content: 'Invalid undo confirmation request.', ephemeral: true });
      }

      getPendingActionById(pendingId, (err, pending) => {
        if (err) {
          console.error('Pending action lookup error:', err);
          return interaction.reply({ content: 'Error processing undo confirmation.', ephemeral: true });
        }
        if (!pending) {
          return interaction.reply({ content: 'This undo request is no longer pending or has already been resolved.', ephemeral: true });
        }
        const payload = JSON.parse(pending.payload);
        if (interaction.user.id !== payload.requestedBy) {
          return interaction.reply({ content: 'Only the admin who requested this undo can confirm or reject it.', ephemeral: true });
        }

        if (action === 'reject') {
          deletePendingActionById(pendingId, err2 => {
            if (err2) console.error('Pending undo delete error:', err2);
            interaction.update({ content: `Undo cancelled by ${interaction.user.username}.`, components: [] });
          });
          return;
        }

        db.get(`SELECT id, winner_id, loser_id FROM matches WHERE id = ?`, [payload.matchId], (err2, row) => {
          if (err2 || !row) {
            if (err2) console.error('Undo match lookup error:', err2);
            deletePendingActionById(pendingId, () => {});
            return interaction.update({ content: 'The match could not be found or was already removed.', components: [] });
          }

          if (payload.playerId === row.winner_id) {
            db.run(`UPDATE players SET points = points - 1 WHERE id = ? AND month = ?`, [payload.playerId, payload.month], err3 => {
              if (err3) console.error('Undo winner points update error:', err3);
            });
          } else {
            db.run(`UPDATE players SET points = points + 1 WHERE id = ? AND month = ?`, [payload.playerId, payload.month], err3 => {
              if (err3) console.error('Undo loser points update error:', err3);
            });
          }

          db.run(`DELETE FROM matches WHERE id = ?`, [payload.matchId], err3 => {
            if (err3) {
              console.error('Undo match delete error:', err3);
              return interaction.update({ content: 'Error undoing match.', components: [] });
            }
            deletePendingActionById(pendingId, err4 => {
              if (err4) console.error('Pending undo delete error:', err4);
              interaction.update({ content: `Last match for ${payload.playerName} has been undone.`, components: [] });
            });
          });
        });
      });
      return;
    }

    return;
  }

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

        canReportMatch(winner.id, loser.id, (err3, allowed) => {
          if (err3) {
            console.error('Cooldown check error:', err3);
            return interaction.editReply('Error checking match cooldown. Please try again.');
          }
          if (!allowed) {
            return interaction.editReply('You can only report a match against the same opponent once every 2 hours. Wait until the previous match is confirmed or the cooldown expires.');
          }

          db.run(
            `INSERT INTO pending_reports (winner_id, winner_name, loser_id, loser_name, reported_by, month) VALUES (?, ?, ?, ?, ?, ?)`,
            [winner.id, winner.username, loser.id, loser.username, reporter, month],
            function(err4) {
              if (err4) {
                console.error('Pending report insert error:', err4);
                return interaction.editReply('Error reporting match. Please try again.');
              }

              const pendingId = this.lastID;
              const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`confirm_match_${pendingId}`)
                  .setLabel('Confirm')
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`reject_match_${pendingId}`)
                  .setLabel('Reject')
                  .setStyle(ButtonStyle.Danger)
              );

              interaction.editReply({
                content: `Match reported! ${winner.username} defeated ${loser.username}. Waiting for ${loser.username} to confirm the result.`,
                components: [actionRow]
              });
            }
          );
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
  } else if (commandName === 'top_streaks') {
    const month = getCurrentMonth();
    computeTopStreaks(month, 10, (err, streaks) => {
      if (err) {
        console.error('Top streaks error:', err);
        return interaction.reply('Error fetching top streaks.');
      }

      const embed = new EmbedBuilder()
        .setTitle(`Top Win Streaks - ${month}`)
        .setColor(0x00BBFF);

      if (streaks.length === 0) {
        embed.setDescription('No active streaks found for this month.');
      } else {
        embed.setDescription(streaks.map((item, index) => `${index + 1}. ${item.name} — ${item.streak} ${item.streakType}`).join('\n'));
      }

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'profile') {
    const player = interaction.options.getUser('player') || interaction.user;
    const monthArg = interaction.options.getString('month');
    const month = monthArg ? parseMonthInput(monthArg) : getCurrentMonth();
    if (monthArg && !month) {
      return interaction.reply('Invalid month format. Use YYYY-MM.');
    }

    getPlayerMonthStats(player.id, month, (err, stats) => {
      if (err) {
        console.error('Profile error:', err);
        return interaction.reply('Error fetching profile.');
      }
      if (!stats) {
        return interaction.reply(`${player.username} has no data for ${month}.`);
      }

      const level = determineLevel(stats.points);
      const badges = determineBadges(stats);
      const streakText = stats.streakType ? `${stats.streak} ${stats.streakType}${stats.streak === 1 ? '' : 's'}` : 'None';

      const embed = new EmbedBuilder()
        .setTitle(`${player.username}'s Profile - ${month}`)
        .setColor(0x00FFAA)
        .addFields(
          { name: 'Points', value: `${stats.points}`, inline: true },
          { name: 'Level', value: level, inline: true },
          { name: 'Win Rate', value: `${stats.winRate}%`, inline: true },
          { name: 'Wins', value: `${stats.wins}`, inline: true },
          { name: 'Losses', value: `${stats.losses}`, inline: true },
          { name: 'Streak', value: streakText, inline: true },
          { name: 'Badges', value: badges.join(', '), inline: false }
        );

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'winrate') {
    const player = interaction.options.getUser('player') || interaction.user;
    const monthArg = interaction.options.getString('month');
    const month = monthArg ? parseMonthInput(monthArg) : getCurrentMonth();
    if (monthArg && !month) {
      return interaction.reply('Invalid month format. Use YYYY-MM.');
    }

    getPlayerMonthStats(player.id, month, (err, stats) => {
      if (err) {
        console.error('Winrate error:', err);
        return interaction.reply('Error fetching win rate.');
      }
      if (!stats) {
        return interaction.reply(`${player.username} has no data for ${month}.`);
      }

      const totalMatches = stats.wins + stats.losses;
      const embed = new EmbedBuilder()
        .setTitle(`${player.username}'s Win Rate - ${month}`)
        .setColor(0x00FFAA)
        .addFields(
          { name: 'Win Rate', value: `${stats.winRate}%`, inline: true },
          { name: 'Record', value: `${stats.wins}W / ${stats.losses}L`, inline: true },
          { name: 'Matches', value: `${totalMatches}`, inline: true }
        );

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'shoutout') {
    const player = interaction.options.getUser('player');
    const reason = interaction.options.getString('reason') || 'Great performance!';
    const embed = new EmbedBuilder()
      .setTitle('Player Shoutout!')
      .setColor(0xFFD700)
      .setDescription(`${player} deserves a shoutout!\n\n**Reason:** ${reason}`)
      .setFooter({ text: `Shoutout by ${interaction.user.username}` });

    interaction.reply({ embeds: [embed] });
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
        { name: '/report_match', value: 'Report a match result with winner and loser (loser must confirm).', inline: false },
        { name: '/leaderboard', value: 'View the current monthly leaderboard.', inline: false },
        { name: '/leaderboard_history', value: 'View leaderboard history for a previous month.', inline: false },
        { name: '/history_months', value: 'Show months with saved leaderboard history.', inline: false },
        { name: '/monthly_summary', value: 'Summarize recent monthly leaderboards.', inline: false },
        { name: '/top_streaks', value: 'Show the current top win streaks.', inline: false },
        { name: '/profile', value: 'Show a player profile with level and badges.', inline: false },
        { name: '/winrate', value: 'Show a player win rate.', inline: false },
        { name: '/shoutout', value: 'Give a player a public shoutout.', inline: false },
        { name: '/stats', value: 'Show monthly stats for yourself or another player.', inline: false },
        { name: '/reset_monthly', value: 'Reset the monthly leaderboard and save the month to history (Admin only, requires confirmation).', inline: false },
        { name: '/undo_match', value: 'Undo the last match for a player (Admin only, requires confirmation).', inline: false },
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

    storePendingAction('reset_month', { month: targetMonth, requestedBy: interaction.user.id }, (err, pendingId) => {
      if (err) {
        console.error('Pending reset create error:', err);
        return interaction.editReply('Error creating reset confirmation. Please try again.');
      }

      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_reset_month_${pendingId}`)
          .setLabel('Confirm Reset')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`reject_reset_month_${pendingId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      interaction.editReply({
        content: `Are you sure you want to reset the leaderboard for **${targetMonth}**? Click Confirm Reset to proceed.`,
        components: [actionRow]
      });
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

      storePendingAction('undo_match', {
        matchId: row.id,
        playerId: player.id,
        playerName: player.username,
        month,
        requestedBy: interaction.user.id
      }, (err2, pendingId) => {
        if (err2) {
          console.error('Pending undo create error:', err2);
          return interaction.reply('Error creating undo confirmation. Please try again.');
        }

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_undo_match_${pendingId}`)
            .setLabel('Confirm Undo')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`reject_undo_match_${pendingId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );

        interaction.reply({
          content: `Are you sure you want to undo the last match for ${player.username}? Click Confirm Undo to proceed.`,
          components: [actionRow]
        });
      });
    });
  } else if (commandName === 'rules') {
    const embed = new EmbedBuilder()
      .setTitle('📋 Ranked Server Rules')
      .setColor(0xFF4500)
      .setDescription('Please read and follow these rules to participate in the ranked leaderboard.')
      .addFields(
        { name: '1. Be Respectful', value: 'Be respectful to all players at all times.', inline: false },
        { name: '2. Honest Reporting', value: 'Report match results honestly and accurately.', inline: false },
        { name: '3. Fair Play', value: 'No cheating, manipulation, or false reporting.', inline: false },
        { name: '4. Admin Decisions', value: 'Admins have final say on disputes.', inline: false },
        { name: '5. Discord ToS', value: 'Follow Discord Terms of Service.', inline: false },
        { name: '6. Consequences', value: 'Violations may result in removal from the leaderboard.', inline: false },
        { name: '7. Have Fun', value: 'Have fun and play fairly!', inline: false }
      )
      .setFooter({ text: 'Good luck and enjoy the competition!' });

    interaction.reply({ embeds: [embed] });
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