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
    id TEXT PRIMARY KEY,
    name TEXT,
    points INTEGER DEFAULT 0,
    month TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    winner_id TEXT,
    loser_id TEXT,
    reported_by TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    month TEXT
  )`);
});

// Function to get current month
function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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

    db.run(`INSERT OR IGNORE INTO players (id, name, points, month) VALUES (?, ?, 0, ?)`, [userId, userName, month], function(err) {
      if (err) {
        console.error(err);
        return interaction.reply('Error registering. Please try again.');
      }
      if (this.changes > 0) {
        interaction.reply('You have been registered for the leaderboard!');
      } else {
        interaction.reply('You are already registered.');
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

    // Check if both are registered
    db.get(`SELECT id FROM players WHERE id = ? AND month = ?`, [winner.id, month], (err, row) => {
      if (err || !row) {
        if (err) console.error('Winner check error:', err);
        return interaction.editReply('Winner is not registered. Please register first.');
      }
      db.get(`SELECT id FROM players WHERE id = ? AND month = ?`, [loser.id, month], (err2, row2) => {
        if (err2 || !row2) {
          if (err2) console.error('Loser check error:', err2);
          return interaction.editReply('Loser is not registered. Please ensure both players are registered.');
        }

        // Record match
        db.run(`INSERT INTO matches (winner_id, loser_id, reported_by, month) VALUES (?, ?, ?, ?)`, [winner.id, loser.id, reporter, month], function(err3) {
          if (err3) {
            console.error('Match insert error:', err3);
            return interaction.editReply('Error reporting match. Please try again.');
          }

          // Update points
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
  } else if (commandName === 'reset_monthly') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('You do not have permission to reset the leaderboard.');
    }

    const newMonth = getCurrentMonth();
    // Reset points to 0 for current month? Or archive?
    // For simplicity, just reset points
    db.run(`UPDATE players SET points = 0 WHERE month = ?`, [newMonth], function(err) {
      if (err) {
        console.error(err);
        return interaction.reply('Error resetting leaderboard.');
      }
      interaction.reply('Monthly leaderboard has been reset.');
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

    db.run(`UPDATE players SET points = ? WHERE id = ? AND month = ?`, [points, player.id, month], function(err) {
      if (err) {
        console.error(err);
        return interaction.reply('Error setting score.');
      }
      interaction.reply(`${player.username}'s score has been set to ${points} points.`);
    });
  }
});

// Monthly reset cron job (1st of every month at midnight)
cron.schedule('0 0 1 * *', () => {
  const currentMonth = getCurrentMonth();
  // Reset points for the new month
  db.run(`UPDATE players SET points = 0 WHERE month = ?`, [currentMonth]);
  console.log('Monthly leaderboard reset.');
});

// Ensure token exists
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN not found in .env file!');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);