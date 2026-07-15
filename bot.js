const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

const DEFAULT_COSMETICS = [
  { name: 'Bronze Frame', cost: 250, emoji: '🟫', category: 'frame', rarity: 'common', slot: 'frame' },
  { name: 'Spark Tag', cost: 300, emoji: '⚡', category: 'suffix', rarity: 'common', slot: 'suffix' },
  { name: 'Forest Banner', cost: 450, emoji: '🌿', category: 'banner', rarity: 'common', slot: 'banner' },
  { name: 'Arena Pro', cost: 1200, emoji: '🏟️', category: 'prefix', rarity: 'rare', slot: 'prefix' },
  { name: 'Neon Frame', cost: 900, emoji: '🟦', category: 'frame', rarity: 'rare', slot: 'frame' },
  { name: 'Victory Confetti', cost: 1500, emoji: '🎉', category: 'effect', rarity: 'rare', slot: 'effect' },
  { name: 'Elite Duelist', cost: 2800, emoji: '🛡️', category: 'prefix', rarity: 'epic', slot: 'prefix' },
  { name: 'Cosmic Banner', cost: 3200, emoji: '🌌', category: 'banner', rarity: 'epic', slot: 'banner' },
  { name: 'Flame Aura', cost: 2200, emoji: '🔥', category: 'aura', rarity: 'epic', slot: 'aura' },
  { name: 'Hideout Legend', cost: 5000, emoji: '👑', category: 'prefix', rarity: 'legendary', slot: 'prefix' },
  { name: 'Golden Crown', cost: 6500, emoji: '💫', category: 'badge', rarity: 'legendary', slot: 'badge' },
  { name: 'Founders Star', cost: 8000, emoji: '🌟', category: 'badge', rarity: 'legendary', slot: 'badge' },
];

const activeBlackjackGames = new Map();
const BLACKJACK_TIMEOUT_MS = 2 * 60 * 1000;
const activeRouletteGames = new Map();
const ROULETTE_TIMEOUT_MS = 90 * 1000;
const ROULETTE_RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const activeHorseRaceGames = new Map();
const HORSE_RACE_TIMEOUT_MS = 90 * 1000;
const HORSE_OPTIONS = [
  { id: 'comet', name: 'Comet', emoji: '🐎', payout: 2, weight: 34 },
  { id: 'blaze', name: 'Blaze', emoji: '🔥', payout: 3, weight: 25 },
  { id: 'storm', name: 'Storm', emoji: '🌩️', payout: 4, weight: 18 },
  { id: 'shadow', name: 'Shadow', emoji: '🌑', payout: 6, weight: 14 },
  { id: 'wildcard', name: 'Wildcard', emoji: '🃏', payout: 10, weight: 9 },
];

const activePokerGames = new Map();
const POKER_TIMEOUT_MS = 2 * 60 * 1000;
const POKER_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const POKER_SUITS = ['S', 'H', 'D', 'C'];

const POKER_PAY_TABLE = [
  { name: 'Royal Flush', multiplier: 300 },
  { name: 'Straight Flush', multiplier: 60 },
  { name: 'Four of a Kind', multiplier: 30 },
  { name: 'Full House', multiplier: 10 },
  { name: 'Flush', multiplier: 7 },
  { name: 'Straight', multiplier: 5 },
  { name: 'Three of a Kind', multiplier: 4 },
  { name: 'Two Pair', multiplier: 2 },
  { name: 'Jacks or Better', multiplier: 2 },
];

function drawBlackjackCard() {
  return Math.ceil(Math.random() * 13);
}

function getBlackjackCardValue(card) {
  if (card >= 2 && card <= 9) return card;
  if (card === 1) return 11;
  return 10;
}

function getBlackjackScore(hand) {
  let score = hand.reduce((sum, card) => sum + getBlackjackCardValue(card), 0);
  let aces = hand.filter(card => card === 1).length;

  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }

  return score;
}

function getBlackjackCardDisplay(card) {
  const displays = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  return displays[card] || '?';
}

function formatBlackjackHand(hand) {
  return hand.map(card => getBlackjackCardDisplay(card)).join(' ');
}

function getBlackjackButtons(gameKey, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`blackjack_hit:${gameKey}`)
        .setLabel('Hit')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`blackjack_stand:${gameKey}`)
        .setLabel('Stand')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
  ];
}

function createBlackjackEmbed(game, options = {}) {
  const revealDealer = options.revealDealer || false;
  const playerScore = getBlackjackScore(game.playerHand);
  const dealerScore = getBlackjackScore(game.dealerHand);
  const color = options.color || '#1E90FF';
  const statusText = options.statusText || 'Choose **Hit** to draw a card or **Stand** to end your turn.';

  const dealerValuePreview = getBlackjackCardValue(game.dealerHand[0]);
  const dealerHandText = revealDealer
    ? `${formatBlackjackHand(game.dealerHand)} (${dealerScore})`
    : `${getBlackjackCardDisplay(game.dealerHand[0])} ? (${dealerValuePreview}+)`;

  const embed = new EmbedBuilder()
    .setTitle('🃏 Blackjack')
    .setColor(color)
    .setDescription(statusText)
    .addFields(
      { name: 'Your Hand', value: `${formatBlackjackHand(game.playerHand)} (${playerScore})`, inline: true },
      { name: 'Dealer Hand', value: dealerHandText, inline: true },
      { name: 'Bet', value: `${game.bet} coins`, inline: true }
    );

  if (typeof options.payout === 'number') {
    embed.addFields({ name: 'Payout', value: `${options.payout} coins`, inline: true });
  }

  if (typeof options.balance === 'number') {
    embed.addFields({ name: 'Balance', value: `${options.balance} coins`, inline: true });
  }

  return embed;
}

function resolveBlackjackResult(game) {
  const playerScore = getBlackjackScore(game.playerHand);

  while (getBlackjackScore(game.dealerHand) < 17) {
    game.dealerHand.push(drawBlackjackCard());
  }

  const dealerScore = getBlackjackScore(game.dealerHand);
  if (playerScore > 21) return 'loss';
  if (dealerScore > 21) return 'win';
  if (playerScore > dealerScore) return 'win';
  if (playerScore === dealerScore) return 'push';
  return 'loss';
}

function getBlackjackPayout(bet, result) {
  if (result === 'win') return bet * 2;
  if (result === 'push') return bet;
  return 0;
}

function persistBlackjackOutcome(guildId, userId, bet, result, callback) {
  const payout = getBlackjackPayout(bet, result);

  db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
    if (err || !row || row.coins < bet) {
      return callback(err || new Error('Not enough coins to settle blackjack hand'));
    }

    const newCoins = row.coins - bet + payout;
    db.run('UPDATE player_coins SET coins = ? WHERE guild_id = ? AND user_id = ?', [newCoins, guildId, userId], (updateErr) => {
      if (updateErr) return callback(updateErr);

      db.run(
        'INSERT INTO gambling_history (guild_id, user_id, game_type, amount_bet, amount_won, result) VALUES (?, ?, ?, ?, ?, ?)',
        [guildId, userId, 'blackjack', bet, payout, result],
        (insertErr) => {
          if (insertErr) return callback(insertErr);
          callback(null, { payout, newCoins });
        }
      );
    });
  });
}

function clearBlackjackTimeout(game) {
  if (game && game.timeoutId) {
    clearTimeout(game.timeoutId);
    game.timeoutId = null;
  }
}

function editBlackjackMessage(game, payload) {
  if (!game?.channelId || !game?.messageId) return;

  client.channels.fetch(game.channelId)
    .then((channel) => {
      if (!channel?.isTextBased()) return;
      channel.messages.fetch(game.messageId)
        .then((message) => message.edit(payload))
        .catch((err) => {
          console.error('Blackjack message fetch/edit error:', err);
        });
    })
    .catch((err) => {
      console.error('Blackjack channel fetch error:', err);
    });
}

function autoStandBlackjackGame(gameKey) {
  const game = activeBlackjackGames.get(gameKey);
  if (!game) return;

  clearBlackjackTimeout(game);
  activeBlackjackGames.delete(gameKey);

  const result = resolveBlackjackResult(game);
  persistBlackjackOutcome(game.guildId, game.userId, game.bet, result, (err, outcome) => {
    if (err) {
      console.error('Blackjack auto-stand settle error:', err);
      editBlackjackMessage(game, {
        content: 'This blackjack hand timed out, but there was an error settling it. Please contact an admin.',
        embeds: [],
        components: [],
      });
      return;
    }

    const statusText = result === 'win'
      ? '⏱️ Hand timed out. Auto-stand applied and you win!'
      : result === 'push'
        ? '⏱️ Hand timed out. Auto-stand resulted in a push.'
        : '⏱️ Hand timed out. Auto-stand applied and dealer wins.';

    const color = result === 'win' ? '#00FF99' : result === 'push' ? '#FFD700' : '#FF6B6B';
    const embed = createBlackjackEmbed(game, {
      revealDealer: true,
      color,
      statusText,
      payout: outcome.payout,
      balance: outcome.newCoins,
    });

    editBlackjackMessage(game, { embeds: [embed], components: getBlackjackButtons(gameKey, true) });
  });
}

function scheduleBlackjackTimeout(game) {
  clearBlackjackTimeout(game);
  game.timeoutId = setTimeout(() => {
    autoStandBlackjackGame(game.gameKey);
  }, BLACKJACK_TIMEOUT_MS);
}

function settleCasinoBet(guildId, userId, gameType, bet, payout, result, callback) {
  db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
    if (err || !row || row.coins < bet) {
      return callback(err || new Error('Not enough coins to settle bet'));
    }

    const newCoins = row.coins - bet + payout;
    db.run('UPDATE player_coins SET coins = ? WHERE guild_id = ? AND user_id = ?', [newCoins, guildId, userId], (updateErr) => {
      if (updateErr) return callback(updateErr);

      db.run(
        'INSERT INTO gambling_history (guild_id, user_id, game_type, amount_bet, amount_won, result) VALUES (?, ?, ?, ?, ?, ?)',
        [guildId, userId, gameType, bet, payout, result],
        (insertErr) => {
          if (insertErr) return callback(insertErr);
          callback(null, { payout, newCoins });
        }
      );
    });
  });
}

function clearRouletteTimeout(game) {
  if (game?.timeoutId) {
    clearTimeout(game.timeoutId);
    game.timeoutId = null;
  }
}

function spinRouletteNumber() {
  return Math.floor(Math.random() * 37);
}

function getRouletteColor(number) {
  if (number === 0) return 'green';
  return ROULETTE_RED_NUMBERS.has(number) ? 'red' : 'black';
}

function rouletteChoiceLabel(choice) {
  const labels = {
    red: 'Red',
    black: 'Black',
    even: 'Even',
    odd: 'Odd',
    low: '1-18',
    high: '19-36',
    green: 'Green (0)',
  };
  return labels[choice] || choice;
}

function isRouletteWin(number, choice) {
  const color = getRouletteColor(number);
  if (choice === 'red') return color === 'red';
  if (choice === 'black') return color === 'black';
  if (choice === 'green') return number === 0;
  if (number === 0) return false;
  if (choice === 'even') return number % 2 === 0;
  if (choice === 'odd') return number % 2 === 1;
  if (choice === 'low') return number >= 1 && number <= 18;
  if (choice === 'high') return number >= 19 && number <= 36;
  return false;
}

function getRoulettePayout(bet, choice) {
  if (choice === 'green') return bet * 36;
  return bet * 2;
}

function isRouletteEvenMoneyChoice(choice) {
  return ['red', 'black', 'even', 'odd', 'low', 'high'].includes(choice);
}

function getRouletteButtons(gameKey, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`roulette_pick:${gameKey}:red`).setLabel('Red').setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`roulette_pick:${gameKey}:black`).setLabel('Black').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`roulette_pick:${gameKey}:even`).setLabel('Even').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`roulette_pick:${gameKey}:odd`).setLabel('Odd').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`roulette_pick:${gameKey}:green`).setLabel('Green 0').setStyle(ButtonStyle.Success).setDisabled(disabled)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`roulette_pick:${gameKey}:low`).setLabel('1-18').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`roulette_pick:${gameKey}:high`).setLabel('19-36').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`roulette_cancel:${gameKey}`).setLabel('Cancel').setStyle(ButtonStyle.Danger).setDisabled(disabled)
    ),
  ];
}

function createRouletteEmbed(game, options = {}) {
  const statusText = options.statusText || 'Place your roulette bet using the buttons below.';
  const color = options.color || '#1E90FF';

  const embed = new EmbedBuilder()
    .setTitle('🎡 Roulette Table')
    .setColor(color)
    .setDescription(statusText)
    .addFields(
      { name: 'Bet', value: `${game.bet} coins`, inline: true },
      { name: 'Payouts', value: 'Red/Black/Even/Odd/1-18/19-36: x2\nGreen 0: x36\nZero split-rule: half back on even-money bets', inline: true }
    );

  if (typeof options.number === 'number') {
    embed.addFields({ name: 'Wheel', value: `${options.number} (${getRouletteColor(options.number)})`, inline: true });
  }

  if (typeof options.choice === 'string') {
    embed.addFields({ name: 'Your Bet', value: rouletteChoiceLabel(options.choice), inline: true });
  }

  if (typeof options.payout === 'number') {
    embed.addFields({ name: 'Payout', value: `${options.payout} coins`, inline: true });
  }

  if (typeof options.balance === 'number') {
    embed.addFields({ name: 'Balance', value: `${options.balance} coins`, inline: true });
  }

  return embed;
}

function clearHorseRaceTimeout(game) {
  if (game?.timeoutId) {
    clearTimeout(game.timeoutId);
    game.timeoutId = null;
  }
}

function getHorseRaceButtons(gameKey, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      ...HORSE_OPTIONS.map((horse) =>
        new ButtonBuilder()
          .setCustomId(`horserace_pick:${gameKey}:${horse.id}`)
          .setLabel(horse.name)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled)
      )
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`horserace_cancel:${gameKey}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    ),
  ];
}

function pickWinningHorse() {
  const totalWeight = HORSE_OPTIONS.reduce((sum, horse) => sum + horse.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const horse of HORSE_OPTIONS) {
    roll -= horse.weight;
    if (roll <= 0) return horse;
  }

  return HORSE_OPTIONS[0];
}

function buildHorseRaceSummary(winningHorse) {
  const positions = {};
  HORSE_OPTIONS.forEach((horse) => {
    positions[horse.id] = 0;
  });

  const log = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    for (const horse of HORSE_OPTIONS) {
      const baseMove = Math.floor(Math.random() * 3) + 1;
      const bonus = horse.id === winningHorse.id ? 1 : 0;
      positions[horse.id] += baseMove + bonus;
    }

    const leader = HORSE_OPTIONS
      .slice()
      .sort((a, b) => positions[b.id] - positions[a.id])[0];

    log.push(`Turn ${turn}: ${leader.emoji} ${leader.name} leads at ${positions[leader.id]} lengths.`);
  }

  const standings = HORSE_OPTIONS
    .slice()
    .sort((a, b) => positions[b.id] - positions[a.id]);

  log.push(`🏁 Winner: ${winningHorse.emoji} ${winningHorse.name}`);
  log.push(`🥈 Runner-up: ${standings[1].emoji} ${standings[1].name}`);

  return {
    recap: log.join('\n'),
    standings,
  };
}

function createHorseRaceEmbed(game, options = {}) {
  const statusText = options.statusText || 'Pick your horse and watch the race unfold.';
  const color = options.color || '#1E90FF';
  const oddsText = HORSE_OPTIONS
    .map((horse) => `${horse.emoji} ${horse.name}: x${horse.payout}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🏇 Horse Race')
    .setColor(color)
    .setDescription(statusText)
    .addFields(
      { name: 'Bet', value: `${game.bet} coins`, inline: true },
      { name: 'Odds', value: oddsText, inline: true }
    );

  if (options.selectedHorse) {
    embed.addFields({ name: 'Your Horse', value: `${options.selectedHorse.emoji} ${options.selectedHorse.name}`, inline: true });
  }

  if (options.winningHorse) {
    embed.addFields({ name: 'Winner', value: `${options.winningHorse.emoji} ${options.winningHorse.name}`, inline: true });
  }

  if (options.raceSummary) {
    embed.addFields({ name: 'Race Recap', value: options.raceSummary, inline: false });
  }

  if (typeof options.payout === 'number') {
    embed.addFields({ name: 'Payout', value: `${options.payout} coins`, inline: true });
  }

  if (typeof options.balance === 'number') {
    embed.addFields({ name: 'Balance', value: `${options.balance} coins`, inline: true });
  }

  return embed;
}

function clearPokerTimeout(game) {
  if (game?.timeoutId) {
    clearTimeout(game.timeoutId);
    game.timeoutId = null;
  }
}

function createPokerDeck() {
  const deck = [];
  for (const suit of POKER_SUITS) {
    for (const rank of POKER_RANKS) {
      deck.push({ rank, suit });
    }
  }

  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function getPokerSuitSymbol(suit) {
  const symbols = {
    S: '♠',
    H: '♥',
    D: '♦',
    C: '♣',
  };
  return symbols[suit] || suit;
}

function formatPokerCard(card) {
  return `${card.rank}${getPokerSuitSymbol(card.suit)}`;
}

function formatPokerHand(hand, held = new Set()) {
  return hand
    .map((card, index) => `${index + 1}:${formatPokerCard(card)}${held.has(index) ? ' [HELD]' : ''}`)
    .join('  ');
}

function getPokerButtons(gameKey, held = new Set(), disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      ...Array.from({ length: 5 }, (_, idx) => (
        new ButtonBuilder()
          .setCustomId(`poker_hold:${gameKey}:${idx}`)
          .setLabel(`Hold ${idx + 1}`)
          .setStyle(held.has(idx) ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(disabled)
      ))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`poker_draw:${gameKey}`)
        .setLabel('Draw')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`poker_cancel:${gameKey}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    ),
  ];
}

function getPokerRankValue(rank) {
  return POKER_RANKS.indexOf(rank) + 2;
}

function isStraight(values) {
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (unique.length !== 5) return false;
  if (unique[4] - unique[0] === 4) return true;
  return JSON.stringify(unique) === JSON.stringify([2, 3, 4, 5, 14]);
}

function evaluatePokerHand(hand) {
  const values = hand.map((card) => getPokerRankValue(card.rank));
  const suits = hand.map((card) => card.suit);
  const counts = {};

  values.forEach((value) => {
    counts[value] = (counts[value] || 0) + 1;
  });

  const countValues = Object.values(counts).sort((a, b) => b - a);
  const isFlush = suits.every((suit) => suit === suits[0]);
  const straight = isStraight(values);
  const sortedValues = [...new Set(values)].sort((a, b) => a - b);
  const isRoyal = JSON.stringify(sortedValues) === JSON.stringify([10, 11, 12, 13, 14]);

  if (isFlush && straight && isRoyal) return { name: 'Royal Flush', multiplier: 300 };
  if (isFlush && straight) return { name: 'Straight Flush', multiplier: 60 };
  if (countValues[0] === 4) return { name: 'Four of a Kind', multiplier: 30 };
  if (countValues[0] === 3 && countValues[1] === 2) return { name: 'Full House', multiplier: 10 };
  if (isFlush) return { name: 'Flush', multiplier: 7 };
  if (straight) return { name: 'Straight', multiplier: 5 };
  if (countValues[0] === 3) return { name: 'Three of a Kind', multiplier: 4 };
  if (countValues[0] === 2 && countValues[1] === 2) return { name: 'Two Pair', multiplier: 2 };

  const pairValue = Object.keys(counts).find((value) => counts[value] === 2);
  if (pairValue && Number(pairValue) >= 11) {
    return { name: 'Jacks or Better', multiplier: 2 };
  }

  return { name: 'High Card', multiplier: 0 };
}

function getPokerPayTableText() {
  return POKER_PAY_TABLE.map((row) => `${row.name}: x${row.multiplier}`).join('\n');
}

function createPokerEmbed(game, options = {}) {
  const statusText = options.statusText || 'Choose which cards to hold, then press Draw.';
  const color = options.color || '#1E90FF';

  const embed = new EmbedBuilder()
    .setTitle('♠ Poker Table')
    .setColor(color)
    .setDescription(statusText)
    .addFields(
      { name: 'Hand', value: formatPokerHand(game.hand, game.held), inline: false },
      { name: 'Bet', value: `${game.bet} coins`, inline: true },
      { name: 'Pay Table', value: getPokerPayTableText(), inline: true }
    );

  if (options.resultName) {
    embed.addFields({ name: 'Result', value: options.resultName, inline: true });
  }

  if (typeof options.payout === 'number') {
    embed.addFields({ name: 'Payout', value: `${options.payout} coins`, inline: true });
  }

  if (typeof options.balance === 'number') {
    embed.addFields({ name: 'Balance', value: `${options.balance} coins`, inline: true });
  }

  return embed;
}

function editPokerMessage(game, payload) {
  if (!game?.channelId || !game?.messageId) return;

  client.channels.fetch(game.channelId)
    .then((channel) => {
      if (!channel?.isTextBased()) return;
      channel.messages.fetch(game.messageId)
        .then((message) => message.edit(payload))
        .catch((err) => {
          console.error('Poker message fetch/edit error:', err);
        });
    })
    .catch((err) => {
      console.error('Poker channel fetch error:', err);
    });
}

function autoExpirePokerGame(gameKey) {
  const game = activePokerGames.get(gameKey);
  if (!game) return;

  clearPokerTimeout(game);
  activePokerGames.delete(gameKey);
  const embed = createPokerEmbed(game, {
    color: '#808080',
    statusText: '⏱️ Poker hand timed out. No coins were wagered.',
  });
  editPokerMessage(game, { embeds: [embed], components: getPokerButtons(gameKey, game.held, true) });
}

function schedulePokerTimeout(game) {
  clearPokerTimeout(game);
  game.timeoutId = setTimeout(() => {
    autoExpirePokerGame(game.gameKey);
  }, POKER_TIMEOUT_MS);
}

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

function getEquippedCosmetics(guildId, userId, callback) {
  db.all(`
    SELECT cs.name, cs.emoji, cs.slot, cs.rarity, cs.category
    FROM player_cosmetics pc
    JOIN cosmetics_shop cs ON pc.cosmetic_id = cs.id
    WHERE pc.guild_id = ? AND pc.user_id = ? AND pc.is_equipped = 1
  `, [guildId, userId], (err, rows) => {
    if (err) return callback(err);
    callback(null, rows || []);
  });
}

function getCosmeticBySlot(cosmetics, slot) {
  return cosmetics.find((item) => item.slot === slot);
}

function decoratePlayerName(baseName, cosmetics) {
  let displayName = baseName;

  const prefix = getCosmeticBySlot(cosmetics, 'prefix');
  const suffix = getCosmeticBySlot(cosmetics, 'suffix');
  const badge = getCosmeticBySlot(cosmetics, 'badge');
  const aura = getCosmeticBySlot(cosmetics, 'aura');
  const effect = getCosmeticBySlot(cosmetics, 'effect');
  const banner = getCosmeticBySlot(cosmetics, 'banner');
  const frame = getCosmeticBySlot(cosmetics, 'frame');

  if (prefix) displayName = `${prefix.emoji} ${displayName}`;
  if (suffix) displayName = `${displayName} ${suffix.emoji}`;
  if (badge) displayName = `${displayName} ${badge.emoji}`;
  if (aura) displayName = `${displayName} ${aura.emoji}`;
  if (effect) displayName = `${displayName} ${effect.emoji}`;
  if (banner) displayName = `${displayName} ${banner.emoji}`;
  if (frame) displayName = `${frame.emoji} ${displayName} ${frame.emoji}`;

  return displayName;
}

function formatEquippedCosmetics(cosmetics) {
  if (!cosmetics || cosmetics.length === 0) return 'None';
  return cosmetics
    .map((item) => `${item.slot}: ${item.emoji} ${item.name}`)
    .join('\n');
}

function decorateLeaderboardRows(guildId, rows, callback) {
  const decoratedRows = [];
  let index = 0;

  const next = () => {
    if (index >= rows.length) {
      return callback(null, decoratedRows);
    }

    const row = rows[index];
    index += 1;

    getEquippedCosmetics(guildId, row.id, (err, cosmetics) => {
      if (err) return callback(err);
      decoratedRows.push({
        ...row,
        displayName: decoratePlayerName(row.name, cosmetics),
      });
      next();
    });
  };

  next();
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
        const oldMilestone = Math.floor(currentXP / 50);
        const newMilestone = Math.floor(newXP / 50);
        const crossedMilestone = newMilestone > oldMilestone;
        callback(err3, { xp: newXP, level: newLevel, crossedMilestone, milestone: newMilestone * 50 });
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
  db.run(`CREATE TABLE IF NOT EXISTS player_coins (
    guild_id TEXT,
    user_id TEXT,
    coins INTEGER DEFAULT 0,
    last_daily TEXT,
    PRIMARY KEY (guild_id, user_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS gambling_history (
    guild_id TEXT,
    user_id TEXT,
    game_type TEXT,
    amount_bet INTEGER,
    amount_won INTEGER,
    result TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cosmetics_shop (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    cost INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    rarity TEXT DEFAULT 'common',
    slot TEXT DEFAULT 'badge'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS player_cosmetics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    cosmetic_id INTEGER NOT NULL,
    is_equipped INTEGER DEFAULT 0,
    UNIQUE(guild_id, user_id, cosmetic_id),
    FOREIGN KEY (cosmetic_id) REFERENCES cosmetics_shop(id)
  )`);

  db.all(`PRAGMA table_info(cosmetics_shop)`, (tableErr, rows = []) => {
    if (tableErr) {
      return console.error('Cosmetics shop table info error:', tableErr);
    }

    const columns = rows.map((row) => row.name);
    if (!columns.includes('category')) {
      db.run(`ALTER TABLE cosmetics_shop ADD COLUMN category TEXT DEFAULT 'general'`);
    }
    if (!columns.includes('rarity')) {
      db.run(`ALTER TABLE cosmetics_shop ADD COLUMN rarity TEXT DEFAULT 'common'`);
    }
    if (!columns.includes('slot')) {
      db.run(`ALTER TABLE cosmetics_shop ADD COLUMN slot TEXT DEFAULT 'badge'`);
    }
  });

  const seedStmt = db.prepare(`
    INSERT OR IGNORE INTO cosmetics_shop (name, cost, emoji, category, rarity, slot)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  DEFAULT_COSMETICS.forEach((item) => {
    seedStmt.run(item.name, item.cost, item.emoji, item.category, item.rarity, item.slot);
  });
  seedStmt.finalize();
});

// Register slash commands
client.once('clientReady', async () => {
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
      .setName('daily')
      .setDescription('Claim your daily coin reward'),
    new SlashCommandBuilder()
      .setName('coins')
      .setDescription('Check coin balance for a player')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('Player to check')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('coinflip')
      .setDescription('Bet coins on a coin flip')
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Bet amount')
          .setRequired(true))
      .addStringOption(option =>
        option.setName('choice')
          .setDescription('Heads or tails')
          .setRequired(true)
          .addChoices(
            { name: 'heads', value: 'heads' },
            { name: 'tails', value: 'tails' }
          )),
    new SlashCommandBuilder()
      .setName('slots')
      .setDescription('Play the slot machine')
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Bet amount')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('blackjack')
      .setDescription('Play interactive blackjack (Hit or Stand)')
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Bet amount')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('poker')
      .setDescription('Play interactive poker (hold cards then draw)')
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Bet amount')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('roulette')
      .setDescription('Play interactive roulette with live bet choices')
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Bet amount')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('horse_race')
      .setDescription('Pick a horse and run an immersive race')
      .addIntegerOption(option =>
        option.setName('amount')
          .setDescription('Bet amount')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('shop')
      .setDescription('Browse or buy XP cosmetics')
      .addSubcommand(subcommand =>
        subcommand
          .setName('view')
          .setDescription('View all cosmetics, optionally filtered by category')
          .addStringOption(option =>
            option.setName('category')
              .setDescription('Filter by cosmetic type')
              .setRequired(false)
              .addChoices(
                { name: 'All', value: 'all' },
                { name: 'Prefix', value: 'prefix' },
                { name: 'Suffix', value: 'suffix' },
                { name: 'Frame', value: 'frame' },
                { name: 'Banner', value: 'banner' },
                { name: 'Aura', value: 'aura' },
                { name: 'Effect', value: 'effect' },
                { name: 'Badge', value: 'badge' }
              )))
      .addSubcommand(subcommand =>
        subcommand
          .setName('buy')
          .setDescription('Buy a cosmetic with XP')
          .addStringOption(option =>
            option.setName('item')
              .setDescription('Name of the cosmetic item')
              .setRequired(true))),
    new SlashCommandBuilder()
      .setName('cosmetic')
      .setDescription('Manage your owned cosmetics')
      .addSubcommand(subcommand =>
        subcommand
          .setName('inventory')
          .setDescription('View your owned cosmetics'))
      .addSubcommand(subcommand =>
        subcommand
          .setName('equip')
          .setDescription('Equip a cosmetic you own')
          .addStringOption(option =>
            option.setName('item')
              .setDescription('Name of the cosmetic item')
              .setRequired(true)))
      .addSubcommand(subcommand =>
        subcommand
          .setName('unequip')
          .setDescription('Unequip all active cosmetics')),
    new SlashCommandBuilder()
      .setName('balance')
      .setDescription('Check XP balance and level')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('Player to check')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('bump')
      .setDescription('Bump the server on Disboard'),
    new SlashCommandBuilder()
      .setName('bo1')
      .setDescription('Show the BO1 leaderboard or register for BO1')
      .addStringOption(option =>
        option.setName('action')
          .setDescription('Choose what to do for BO1')
          .setRequired(false)
          .addChoices(
            { name: 'Leaderboard', value: 'leaderboard' },
            { name: 'Register', value: 'register' }
          )),
    new SlashCommandBuilder()
      .setName('bo3')
      .setDescription('Show the BO3 leaderboard or register for BO3')
      .addStringOption(option =>
        option.setName('action')
          .setDescription('Choose what to do for BO3')
          .setRequired(false)
          .addChoices(
            { name: 'Leaderboard', value: 'leaderboard' },
            { name: 'Register', value: 'register' }
          )),
    new SlashCommandBuilder()
      .setName('xp-balance')
      .setDescription('Check your current XP balance and progress to next milestone')
      .addUserOption(option =>
        option.setName('player')
          .setDescription('The player to check')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('timer')
      .setDescription('Start a match timer')
      .addStringOption(option =>
        option.setName('match_type')
          .setDescription('Match type')
          .setRequired(true)
          .addChoices(
            { name: 'Best of 1 (30 min)', value: 'bo1' },
            { name: 'Best of 3 (60 min)', value: 'bo3' }
          )),
    new SlashCommandBuilder()
      .setName('comments')
      .setDescription('Post or view match comments')
      .addSubcommand(sub =>
        sub.setName('post')
          .setDescription('Post a match comment')
          .addStringOption(option =>
            option.setName('message')
              .setDescription('Your comment')
              .setRequired(true)))
      .addSubcommand(sub =>
        sub.setName('view')
          .setDescription('View recent match comments')),
  ];

  slashCommands = commands;

  try {
    await registerSlashCommands(client, commands, { retries: 5, delayMs: 5000 });
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on('guildCreate', async (guild) => {
  if (!slashCommands.length) return;

  try {
    const payloads = slashCommands.map((command) => command.toJSON());
    await guild.commands.set([]);
    await guild.commands.set(payloads);
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

  awardXP(message.author.id, message.author.username, message.guild.id, 10, (err, result) => {
    if (err) return console.error('XP message award error:', err);

    if (result && result.crossedMilestone) {
      const lvlUpChannel = message.guild.channels.cache.get('1525991425995575457');
      if (lvlUpChannel) {
        lvlUpChannel.send(`✨ **${message.author.username}** leveled up! ✨\n🎉 You've reached **${result.milestone} total XP**! Level: **${result.level}** 📈`).catch(err2 => {
          console.error('Error sending XP milestone announcement:', err2);
        });
      }
    }
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
      awardXP(member.id, member.user.username, guild.id, 1, (err, result) => {
        if (err) return console.error('XP voice award error:', err);

        if (result && result.crossedMilestone) {
          const announceChannel = guild.channels.cache.get('1525991425995575457');
          if (announceChannel) {
            announceChannel.send(`✨ **${member.user.username}** leveled up! ✨\n🎉 You've reached **${result.milestone} total XP**! Level: **${result.level}** 📈`).catch(err2 => {
              console.error('Error sending XP milestone announcement:', err2);
            });
          }
        }
      });
    });
  });
}, 60 * 1000);

client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('poker_')) {
      const [action, ...parts] = interaction.customId.split(':');
      const gameKey = action === 'poker_hold' ? parts.slice(0, -1).join(':') : parts.join(':');
      const holdIndex = action === 'poker_hold' ? Number(parts[parts.length - 1]) : null;
      const game = activePokerGames.get(gameKey);

      if (!game) {
        return interaction.reply({ content: 'This poker hand is no longer active.', ephemeral: true });
      }

      if (interaction.user.id !== game.userId || interaction.guildId !== game.guildId) {
        return interaction.reply({ content: 'Only the player who started this poker hand can use these buttons.', ephemeral: true });
      }

      if (action === 'poker_cancel') {
        clearPokerTimeout(game);
        activePokerGames.delete(gameKey);
        const cancelledEmbed = createPokerEmbed(game, {
          color: '#808080',
          statusText: 'Poker hand canceled. No coins were wagered.',
        });
        return interaction.update({ embeds: [cancelledEmbed], components: getPokerButtons(gameKey, game.held, true) });
      }

      if (action === 'poker_hold') {
        if (Number.isNaN(holdIndex) || holdIndex < 0 || holdIndex > 4) {
          return interaction.reply({ content: 'Invalid hold index.', ephemeral: true });
        }

        if (game.held.has(holdIndex)) {
          game.held.delete(holdIndex);
        } else {
          game.held.add(holdIndex);
        }

        schedulePokerTimeout(game);
        const embed = createPokerEmbed(game, {
          color: '#1E90FF',
          statusText: 'Card hold updated. Press Draw when ready.',
        });
        return interaction.update({ embeds: [embed], components: getPokerButtons(gameKey, game.held, false) });
      }

      if (action === 'poker_draw') {
        for (let idx = 0; idx < 5; idx += 1) {
          if (!game.held.has(idx)) {
            game.hand[idx] = game.deck.pop();
          }
        }

        clearPokerTimeout(game);
        activePokerGames.delete(gameKey);

        const handResult = evaluatePokerHand(game.hand);
        const payout = game.bet * handResult.multiplier;
        const didWin = payout > 0;

        settleCasinoBet(game.guildId, game.userId, 'poker', game.bet, payout, didWin ? 'win' : 'loss', (err, outcome) => {
          if (err) {
            console.error('Poker settle error:', err);
            return interaction.update({
              content: 'Error settling this poker hand. No coins were changed.',
              embeds: [],
              components: [],
            });
          }

          const embed = createPokerEmbed(game, {
            color: didWin ? '#00FF99' : '#FF6B6B',
            statusText: didWin ? '✅ Nice hand! You got paid.' : '❌ No payout this hand.',
            resultName: handResult.name,
            payout: outcome.payout,
            balance: outcome.newCoins,
          });

          interaction.update({ embeds: [embed], components: getPokerButtons(gameKey, game.held, true) });
        });
        return;
      }
    }

    if (interaction.customId.startsWith('roulette_')) {
      const [action, ...parts] = interaction.customId.split(':');
      const gameKey = action === 'roulette_pick' ? parts.slice(0, -1).join(':') : parts.join(':');
      const choice = action === 'roulette_pick' ? parts[parts.length - 1] : null;
      const game = activeRouletteGames.get(gameKey);

      if (!game) {
        return interaction.reply({ content: 'This roulette bet is no longer active.', ephemeral: true });
      }

      if (interaction.user.id !== game.userId || interaction.guildId !== game.guildId) {
        return interaction.reply({ content: 'Only the player who started this roulette bet can use these buttons.', ephemeral: true });
      }

      if (action === 'roulette_cancel') {
        clearRouletteTimeout(game);
        activeRouletteGames.delete(gameKey);
        const cancelledEmbed = createRouletteEmbed(game, {
          color: '#808080',
          statusText: 'Bet cancelled. No coins were wagered.',
        });
        return interaction.update({ embeds: [cancelledEmbed], components: getRouletteButtons(gameKey, true) });
      }

      const validChoices = new Set(['red', 'black', 'even', 'odd', 'low', 'high', 'green']);
      if (!validChoices.has(choice)) {
        return interaction.reply({ content: 'Invalid roulette choice.', ephemeral: true });
      }

      clearRouletteTimeout(game);
      activeRouletteGames.delete(gameKey);

      const number = spinRouletteNumber();
      const won = isRouletteWin(number, choice);
      let payout = 0;
      let result = 'loss';
      let statusText = '❌ House wins this spin.';
      let color = '#FF6B6B';

      if (won) {
        payout = getRoulettePayout(game.bet, choice);
        result = 'win';
        statusText = '✅ You won the roulette spin!';
        color = '#00FF99';
      } else if (number === 0 && isRouletteEvenMoneyChoice(choice)) {
        payout = Math.floor(game.bet / 2);
        result = 'push';
        statusText = '🟡 Zero landed. Split-rule refunds half your even-money bet.';
        color = '#FFD700';
      }

      settleCasinoBet(game.guildId, game.userId, 'roulette', game.bet, payout, result, (err, outcome) => {
        if (err) {
          console.error('Roulette settle error:', err);
          return interaction.update({
            content: 'Error settling this roulette bet. No coins were changed.',
            embeds: [],
            components: [],
          });
        }

        const embed = createRouletteEmbed(game, {
          color,
          statusText,
          number,
          choice,
          payout: outcome.payout,
          balance: outcome.newCoins,
        });

        interaction.update({ embeds: [embed], components: getRouletteButtons(gameKey, true) });
      });
      return;
    }

    if (interaction.customId.startsWith('horserace_')) {
      const [action, ...parts] = interaction.customId.split(':');
      const gameKey = action === 'horserace_pick' ? parts.slice(0, -1).join(':') : parts.join(':');
      const selectedHorseId = action === 'horserace_pick' ? parts[parts.length - 1] : null;
      const game = activeHorseRaceGames.get(gameKey);

      if (!game) {
        return interaction.reply({ content: 'This horse race is no longer active.', ephemeral: true });
      }

      if (interaction.user.id !== game.userId || interaction.guildId !== game.guildId) {
        return interaction.reply({ content: 'Only the player who started this horse race can use these buttons.', ephemeral: true });
      }

      if (action === 'horserace_cancel') {
        clearHorseRaceTimeout(game);
        activeHorseRaceGames.delete(gameKey);
        const cancelledEmbed = createHorseRaceEmbed(game, {
          color: '#808080',
          statusText: 'Race cancelled. No coins were wagered.',
        });
        return interaction.update({ embeds: [cancelledEmbed], components: getHorseRaceButtons(gameKey, true) });
      }

      const selectedHorse = HORSE_OPTIONS.find((horse) => horse.id === selectedHorseId);
      if (!selectedHorse) {
        return interaction.reply({ content: 'Invalid horse selection.', ephemeral: true });
      }

      clearHorseRaceTimeout(game);
      activeHorseRaceGames.delete(gameKey);

      const winningHorse = pickWinningHorse();
      const raceResult = buildHorseRaceSummary(winningHorse);
      const raceSummary = raceResult.recap;
      const secondPlaceHorse = raceResult.standings[1];
      const won = selectedHorse.id === winningHorse.id;
      const runnerUpRefund = !won && selectedHorse.id === secondPlaceHorse.id;
      const payout = won ? game.bet * selectedHorse.payout : runnerUpRefund ? Math.floor(game.bet * 0.5) : 0;
      const result = won ? 'win' : runnerUpRefund ? 'push' : 'loss';

      settleCasinoBet(game.guildId, game.userId, 'horse_race', game.bet, payout, result, (err, outcome) => {
        if (err) {
          console.error('Horse race settle error:', err);
          return interaction.update({
            content: 'Error settling this horse race. No coins were changed.',
            embeds: [],
            components: [],
          });
        }

        const embed = createHorseRaceEmbed(game, {
          color: won ? '#00FF99' : runnerUpRefund ? '#FFD700' : '#FF6B6B',
          statusText: won
            ? '✅ Your horse won the race!'
            : runnerUpRefund
              ? '🟡 Photo finish! Your horse placed second, so half your bet was refunded.'
              : '❌ Your horse came up short this time.',
          selectedHorse,
          winningHorse,
          raceSummary,
          payout: outcome.payout,
          balance: outcome.newCoins,
        });

        interaction.update({ embeds: [embed], components: getHorseRaceButtons(gameKey, true) });
      });
      return;
    }

    if (!interaction.customId.startsWith('blackjack_')) return;

    const [action, ...gameKeyParts] = interaction.customId.split(':');
    const gameKey = gameKeyParts.join(':');
    const game = activeBlackjackGames.get(gameKey);

    if (!game) {
      try {
        let expiredEmbed;
        if (interaction.message?.embeds?.length) {
          expiredEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setDescription('⏱️ This blackjack hand expired or the bot restarted. Start a new hand with `/blackjack`.');
        } else {
          expiredEmbed = new EmbedBuilder()
            .setTitle('🃏 Blackjack')
            .setColor('#808080')
            .setDescription('⏱️ This blackjack hand expired or the bot restarted. Start a new hand with `/blackjack`.');
        }

        await interaction.update({
          embeds: [expiredEmbed],
          components: getBlackjackButtons(gameKey, true),
        });
      } catch (err) {
        console.error('Blackjack stale-hand update error:', err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'This blackjack hand is no longer active. Start a new one with `/blackjack`.', ephemeral: true });
        }
      }
      return;
    }

    if (interaction.user.id !== game.userId || interaction.guildId !== game.guildId) {
      return interaction.reply({ content: 'Only the player who started this hand can use these buttons.', ephemeral: true });
    }

    if (action === 'blackjack_hit') {
      game.playerHand.push(drawBlackjackCard());
      const playerScore = getBlackjackScore(game.playerHand);

      if (playerScore > 21) {
        clearBlackjackTimeout(game);
        activeBlackjackGames.delete(gameKey);
        persistBlackjackOutcome(game.guildId, game.userId, game.bet, 'loss', (err, outcome) => {
          if (err) {
            console.error('Blackjack settle error:', err);
            return interaction.update({
              content: 'Error settling this blackjack hand. No coins were changed.',
              embeds: [],
              components: [],
            });
          }

          const embed = createBlackjackEmbed(game, {
            revealDealer: true,
            color: '#FF6B6B',
            statusText: '❌ Bust! You went over 21.',
            payout: outcome.payout,
            balance: outcome.newCoins,
          });

          interaction.update({ embeds: [embed], components: getBlackjackButtons(gameKey, true) });
        });
      } else {
        scheduleBlackjackTimeout(game);
        const embed = createBlackjackEmbed(game, {
          revealDealer: false,
          color: '#1E90FF',
          statusText: 'Your move: Hit or Stand?',
        });

        interaction.update({ embeds: [embed], components: getBlackjackButtons(gameKey, false) });
      }
      return;
    }

    if (action === 'blackjack_stand') {
      clearBlackjackTimeout(game);
      activeBlackjackGames.delete(gameKey);
      const result = resolveBlackjackResult(game);

      persistBlackjackOutcome(game.guildId, game.userId, game.bet, result, (err, outcome) => {
        if (err) {
          console.error('Blackjack settle error:', err);
          return interaction.update({
            content: 'Error settling this blackjack hand. No coins were changed.',
            embeds: [],
            components: [],
          });
        }

        const statusText = result === 'win'
          ? '✅ You win!'
          : result === 'push'
            ? '🤝 Push!'
            : '❌ Dealer wins.';

        const color = result === 'win' ? '#00FF99' : result === 'push' ? '#FFD700' : '#FF6B6B';
        const embed = createBlackjackEmbed(game, {
          revealDealer: true,
          color,
          statusText,
          payout: outcome.payout,
          balance: outcome.newCoins,
        });

        interaction.update({ embeds: [embed], components: getBlackjackButtons(gameKey, true) });
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

    db.all(`SELECT id, name, points FROM players WHERE month = ? AND ladder_type = ? ORDER BY points DESC LIMIT 10`, [month, ladder], (err, rows) => {
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
        decorateLeaderboardRows(interaction.guild.id, rows, (decorateErr, decoratedRows) => {
          if (decorateErr) {
            console.error('Leaderboard cosmetics decorate error:', decorateErr);
            return interaction.reply('Error fetching leaderboard.');
          }

          let description = '';
          decoratedRows.forEach((row, index) => {
            description += `${index + 1}. ${row.displayName}: ${row.points} points\n`;
          });
          embed.setDescription(description);
          interaction.reply({ embeds: [embed] });
        });
        return;
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
        { name: '/shop view [category]', value: 'Browse cosmetics you can buy with XP.', inline: false },
        { name: '/shop buy item:name', value: 'Buy a cosmetic item with your XP.', inline: false },
        { name: '/cosmetic inventory', value: 'View your owned cosmetics and equipped items.', inline: false },
        { name: '/cosmetic equip item:name', value: 'Equip a cosmetic from your inventory.', inline: false },
        { name: '/cosmetic unequip', value: 'Unequip currently equipped cosmetics.', inline: false },
        { name: '/balance [player]', value: 'Check XP balance and current level.', inline: false },
        { name: '/daily', value: 'Claim your daily coin reward.', inline: false },
        { name: '/coins [player]', value: 'Check a player\'s coin balance.', inline: false },
        { name: '/coinflip amount:integer choice:heads|tails', value: 'Bet your coins on a coin flip.', inline: false },
        { name: '/slots amount:integer', value: 'Play the slot machine for coins.', inline: false },
        { name: '/blackjack amount:integer', value: 'Play interactive blackjack with Hit/Stand (auto-stands after 2 min idle).', inline: false },
        { name: '/poker amount:integer', value: 'Play interactive poker with hold-and-draw decisions.', inline: false },
        { name: '/roulette amount:integer', value: 'Play interactive roulette with multiple bet options (auto-cancels after inactivity).', inline: false },
        { name: '/horse_race amount:integer', value: 'Pick a horse with odds and run a race simulation.', inline: false },
        { name: '/history_list [ladder]', value: 'View all months with leaderboard data.', inline: false },
        { name: '/history month:YYYY-MM [ladder]', value: 'View leaderboard for a specific month.', inline: false },
        { name: '/player_history [player] [ladder]', value: 'View a player\'s stats across all months.', inline: false },
        { name: '/match_history [limit] [month] [ladder]', value: 'View recent matches with optional filters.', inline: false },
        { name: '/bo1 [action]', value: 'Quick BO1 command for leaderboard or registration.', inline: false },
        { name: '/bo3 [action]', value: 'Quick BO3 command for leaderboard or registration.', inline: false },
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
  } else if (commandName === 'bo1') {
    const action = interaction.options.getString('action') || 'leaderboard';
    if (action === 'register') {
      const userId = interaction.user.id;
      const userName = interaction.user.username;
      const month = getCurrentMonth();
      const ladder = 'bo1';

      ensurePlayerForMonth(userId, userName, month, ladder, (err, inserted) => {
        if (err) {
          console.error('BO1 register error:', err);
          return interaction.reply('Error registering for BO1. Please try again.');
        }

        if (inserted) {
          interaction.reply('You have been registered for the Best of 1 ladder for this month.');
        } else {
          interaction.reply('You are already registered for the Best of 1 ladder this month.');
        }
      });
      return;
    }

    const month = getCurrentMonth();
    const ladder = 'bo1';

    db.all(`SELECT id, name, points FROM players WHERE month = ? AND ladder_type = ? ORDER BY points DESC LIMIT 10`, [month, ladder], (err, rows) => {
      if (err) {
        console.error(err);
        return interaction.reply('Error fetching BO1 leaderboard.');
      }

      const embed = new EmbedBuilder()
        .setTitle('Best of 1 Monthly Leaderboard - ' + month)
        .setColor(0x0099FF);

      if (rows.length === 0) {
        embed.setDescription('No players registered yet for BO1.');
      } else {
        decorateLeaderboardRows(interaction.guild.id, rows, (decorateErr, decoratedRows) => {
          if (decorateErr) {
            console.error('BO1 cosmetics decorate error:', decorateErr);
            return interaction.reply('Error fetching BO1 leaderboard.');
          }

          let description = '';
          decoratedRows.forEach((row, index) => {
            description += `${index + 1}. ${row.displayName}: ${row.points} points\n`;
          });
          embed.setDescription(description);
          interaction.reply({ embeds: [embed] });
        });
        return;
      }

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'bo3') {
    const action = interaction.options.getString('action') || 'leaderboard';
    if (action === 'register') {
      const userId = interaction.user.id;
      const userName = interaction.user.username;
      const month = getCurrentMonth();
      const ladder = 'bo3';

      ensurePlayerForMonth(userId, userName, month, ladder, (err, inserted) => {
        if (err) {
          console.error('BO3 register error:', err);
          return interaction.reply('Error registering for BO3. Please try again.');
        }

        if (inserted) {
          interaction.reply('You have been registered for the Best of 3 ladder for this month.');
        } else {
          interaction.reply('You are already registered for the Best of 3 ladder this month.');
        }
      });
      return;
    }

    const month = getCurrentMonth();
    const ladder = 'bo3';

    db.all(`SELECT id, name, points FROM players WHERE month = ? AND ladder_type = ? ORDER BY points DESC LIMIT 10`, [month, ladder], (err, rows) => {
      if (err) {
        console.error(err);
        return interaction.reply('Error fetching BO3 leaderboard.');
      }

      const embed = new EmbedBuilder()
        .setTitle('Best of 3 Monthly Leaderboard - ' + month)
        .setColor(0x0099FF);

      if (rows.length === 0) {
        embed.setDescription('No players registered yet for BO3.');
      } else {
        decorateLeaderboardRows(interaction.guild.id, rows, (decorateErr, decoratedRows) => {
          if (decorateErr) {
            console.error('BO3 cosmetics decorate error:', decorateErr);
            return interaction.reply('Error fetching BO3 leaderboard.');
          }

          let description = '';
          decoratedRows.forEach((row, index) => {
            description += `${index + 1}. ${row.displayName}: ${row.points} points\n`;
          });
          embed.setDescription(description);
          interaction.reply({ embeds: [embed] });
        });
        return;
      }

      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'daily') {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    db.get('SELECT coins, last_daily FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
      if (err) return interaction.reply('Error checking daily reward');
      const lastDaily = row?.last_daily ? new Date(row.last_daily).toISOString().split('T')[0] : null;
      if (lastDaily === today) return interaction.reply('❌ You already claimed your daily reward today! Come back tomorrow.');
      const reward = 100;
      const newCoins = (row?.coins || 0) + reward;
      db.run('INSERT OR REPLACE INTO player_coins (guild_id, user_id, coins, last_daily) VALUES (?, ?, ?, ?)', [guildId, userId, newCoins, now.toISOString()], (err) => {
        if (err) return interaction.reply('Error claiming daily reward');
        const embed = new EmbedBuilder().setTitle('💰 Daily Reward Claimed!').setColor('#FFD700').addFields({ name: 'Coins Earned', value: `+100`, inline: true }, { name: 'Total Coins', value: `${newCoins}`, inline: true });
        interaction.reply({ embeds: [embed] });
      });
    });

  } else if (commandName === 'coins') {
    const player = interaction.options.getUser('player') || interaction.user;
    const guildId = interaction.guild.id;
    db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, player.id], (err, row) => {
      if (err) return interaction.reply('Error fetching coins');
      const coins = row?.coins || 0;
      const embed = new EmbedBuilder().setTitle(`💵 ${player.username}'s Coin Balance`).setColor('#FFD700').setDescription(`**${coins}** coins`);
      interaction.reply({ embeds: [embed] });
    });

  } else if (commandName === 'coinflip') {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const bet = interaction.options.getInteger('amount');
    const choice = interaction.options.getString('choice');
    db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
      if (err || !row || row.coins < bet) return interaction.reply(`❌ You don't have enough coins! You have ${row?.coins || 0}, bet is ${bet}`);
      const flip = Math.random() > 0.48 ? 'heads' : 'tails';
      const won = flip === choice;
      const payout = won ? bet * 2 : 0;
      const newCoins = row.coins - bet + payout;
      db.run('UPDATE player_coins SET coins = ? WHERE guild_id = ? AND user_id = ?', [newCoins, guildId, userId], (err) => {
        if (err) return interaction.reply('Error processing bet');
        db.run('INSERT INTO gambling_history (guild_id, user_id, game_type, amount_bet, amount_won, result) VALUES (?, ?, ?, ?, ?, ?)', [guildId, userId, 'coinflip', bet, payout, won ? 'win' : 'loss']);
        const resultEmoji = won ? '✅' : '❌';
        const embed = new EmbedBuilder().setTitle('🪙 Coin Flip').setColor(won ? '#00FF99' : '#FF6B6B').addFields({ name: 'You chose', value: choice, inline: true }, { name: 'Result', value: flip, inline: true }, { name: 'Bet', value: `${bet} coins`, inline: true }, { name: 'Payout', value: `${payout} coins`, inline: true }, { name: 'Balance', value: `${newCoins} coins`, inline: true }).setDescription(`${resultEmoji} ${won ? 'You won!' : 'You lost!'}`);
        interaction.reply({ embeds: [embed] });
      });
    });

  } else if (commandName === 'slots') {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const bet = interaction.options.getInteger('amount');
    db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
      if (err || !row || row.coins < bet) return interaction.reply(`❌ You don't have enough coins! You have ${row?.coins || 0}, bet is ${bet}`);
      const symbols = ['🍎', '🍊', '🍋', '🍌', '7️⃣'];
      const reel1 = symbols[Math.floor(Math.random() * symbols.length)];
      const reel2 = symbols[Math.floor(Math.random() * symbols.length)];
      const reel3 = symbols[Math.floor(Math.random() * symbols.length)];
      let multiplier = 0;
      if (reel1 === reel2 && reel2 === reel3) multiplier = 5;
      else if (reel1 === reel2 || reel2 === reel3) multiplier = 1;
      const payout = Math.floor(bet * multiplier);
      const newCoins = row.coins - bet + payout;
      db.run('UPDATE player_coins SET coins = ? WHERE guild_id = ? AND user_id = ?', [newCoins, guildId, userId], (err) => {
        if (err) return interaction.reply('Error processing bet');
        db.run('INSERT INTO gambling_history (guild_id, user_id, game_type, amount_bet, amount_won, result) VALUES (?, ?, ?, ?, ?, ?)', [guildId, userId, 'slots', bet, payout, multiplier > 0 ? 'win' : 'loss']);
        const resultEmoji = multiplier > 0 ? '✅' : '❌';
        const resultText = multiplier === 5 ? '🎉 JACKPOT!' : multiplier === 1 ? 'Two match!' : 'No match';
        const embed = new EmbedBuilder().setTitle('🎰 Slot Machine').setColor(multiplier > 0 ? '#00FF99' : '#FF6B6B').addFields({ name: 'Spin', value: `${reel1} ${reel2} ${reel3}`, inline: false }, { name: 'Bet', value: `${bet} coins`, inline: true }, { name: 'Payout', value: `${payout} coins`, inline: true }, { name: 'Balance', value: `${newCoins} coins`, inline: true }).setDescription(`${resultEmoji} ${resultText}`);
        interaction.reply({ embeds: [embed] });
      });
    });

  } else if (commandName === 'blackjack') {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const bet = interaction.options.getInteger('amount');

    if (bet <= 0) {
      return interaction.reply('Bet amount must be greater than 0.');
    }

    const gameKey = `${guildId}:${userId}`;
    if (activeBlackjackGames.has(gameKey)) {
      return interaction.reply({ content: 'You already have an active blackjack hand. Finish it before starting a new one.', ephemeral: true });
    }

    db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
      if (err || !row || row.coins < bet) return interaction.reply(`❌ You don't have enough coins! You have ${row?.coins || 0}, bet is ${bet}`);

      const game = {
        gameKey,
        guildId,
        userId,
        bet,
        playerHand: [drawBlackjackCard(), drawBlackjackCard()],
        dealerHand: [drawBlackjackCard(), drawBlackjackCard()],
      };

      const playerScore = getBlackjackScore(game.playerHand);
      const dealerScore = getBlackjackScore(game.dealerHand);

      if (playerScore === 21 || dealerScore === 21) {
        let result = 'loss';
        if (playerScore === 21 && dealerScore === 21) result = 'push';
        else if (playerScore === 21) result = 'win';

        return persistBlackjackOutcome(guildId, userId, bet, result, (settleErr, outcome) => {
          if (settleErr) {
            console.error('Blackjack settle error:', settleErr);
            return interaction.reply('Error processing blackjack outcome.');
          }

          const statusText = result === 'win'
            ? '✅ Blackjack! You win instantly.'
            : result === 'push'
              ? '🤝 Both hit blackjack. Push.'
              : '❌ Dealer blackjack.';

          const color = result === 'win' ? '#00FF99' : result === 'push' ? '#FFD700' : '#FF6B6B';
          const embed = createBlackjackEmbed(game, {
            revealDealer: true,
            color,
            statusText,
            payout: outcome.payout,
            balance: outcome.newCoins,
          });

          interaction.reply({ embeds: [embed] });
        });
      }

      activeBlackjackGames.set(gameKey, game);

      const embed = createBlackjackEmbed(game, {
        revealDealer: false,
        color: '#1E90FF',
        statusText: 'Choose **Hit** or **Stand** to play your hand.',
      });

      interaction.reply({ embeds: [embed], components: getBlackjackButtons(gameKey), fetchReply: true })
        .then((message) => {
          game.channelId = message.channelId;
          game.messageId = message.id;
          scheduleBlackjackTimeout(game);
        })
        .catch((replyErr) => {
          console.error('Blackjack reply error:', replyErr);
          activeBlackjackGames.delete(gameKey);
        });
    });

  } else if (commandName === 'poker') {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const bet = interaction.options.getInteger('amount');

    if (bet <= 0) {
      return interaction.reply('Bet amount must be greater than 0.');
    }

    const gameKey = `${guildId}:${userId}`;
    if (activePokerGames.has(gameKey)) {
      return interaction.reply({ content: 'You already have an active poker hand. Finish it before starting a new one.', ephemeral: true });
    }

    db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
      if (err || !row || row.coins < bet) return interaction.reply(`❌ You don't have enough coins! You have ${row?.coins || 0}, bet is ${bet}`);

      const deck = createPokerDeck();
      const hand = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
      const game = {
        gameKey,
        guildId,
        userId,
        bet,
        deck,
        hand,
        held: new Set(),
      };

      activePokerGames.set(gameKey, game);

      const embed = createPokerEmbed(game, {
        color: '#1E90FF',
        statusText: 'Select cards to hold, then press Draw. You have one draw.',
      });

      interaction.reply({ embeds: [embed], components: getPokerButtons(gameKey, game.held), fetchReply: true })
        .then((message) => {
          game.channelId = message.channelId;
          game.messageId = message.id;
          schedulePokerTimeout(game);
        })
        .catch((replyErr) => {
          console.error('Poker reply error:', replyErr);
          activePokerGames.delete(gameKey);
        });
    });

  } else if (commandName === 'roulette') {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const bet = interaction.options.getInteger('amount');

    if (bet <= 0) {
      return interaction.reply('Bet amount must be greater than 0.');
    }

    const gameKey = `${guildId}:${userId}`;
    if (activeRouletteGames.has(gameKey)) {
      return interaction.reply({ content: 'You already have an active roulette bet. Finish it before starting a new one.', ephemeral: true });
    }

    db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
      if (err || !row || row.coins < bet) return interaction.reply(`❌ You don't have enough coins! You have ${row?.coins || 0}, bet is ${bet}`);

      const game = { gameKey, guildId, userId, bet };
      activeRouletteGames.set(gameKey, game);

      const embed = createRouletteEmbed(game, {
        color: '#1E90FF',
        statusText: 'The dealer spins once after you choose your bet type. Choose wisely.',
      });

      interaction.reply({ embeds: [embed], components: getRouletteButtons(gameKey), fetchReply: true })
        .then(() => {
          game.timeoutId = setTimeout(() => {
            const staleGame = activeRouletteGames.get(gameKey);
            if (!staleGame) return;
            activeRouletteGames.delete(gameKey);
          }, ROULETTE_TIMEOUT_MS);
        })
        .catch((replyErr) => {
          console.error('Roulette reply error:', replyErr);
          activeRouletteGames.delete(gameKey);
        });
    });

  } else if (commandName === 'horse_race') {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const bet = interaction.options.getInteger('amount');

    if (bet <= 0) {
      return interaction.reply('Bet amount must be greater than 0.');
    }

    const gameKey = `${guildId}:${userId}`;
    if (activeHorseRaceGames.has(gameKey)) {
      return interaction.reply({ content: 'You already have an active horse race. Finish it before starting a new one.', ephemeral: true });
    }

    db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
      if (err || !row || row.coins < bet) return interaction.reply(`❌ You don't have enough coins! You have ${row?.coins || 0}, bet is ${bet}`);

      const game = { gameKey, guildId, userId, bet };
      activeHorseRaceGames.set(gameKey, game);

      const embed = createHorseRaceEmbed(game, {
        color: '#1E90FF',
        statusText: 'Choose your horse. Longshots pay more, favorites win more often.',
      });

      interaction.reply({ embeds: [embed], components: getHorseRaceButtons(gameKey), fetchReply: true })
        .then(() => {
          game.timeoutId = setTimeout(() => {
            const staleGame = activeHorseRaceGames.get(gameKey);
            if (!staleGame) return;
            activeHorseRaceGames.delete(gameKey);
          }, HORSE_RACE_TIMEOUT_MS);
        })
        .catch((replyErr) => {
          console.error('Horse race reply error:', replyErr);
          activeHorseRaceGames.delete(gameKey);
        });
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
  } else if (commandName === 'shop') {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'view') {
      const category = interaction.options.getString('category') || 'all';
      const query = category === 'all'
        ? 'SELECT id, name, cost, emoji, category, rarity FROM cosmetics_shop ORDER BY cost ASC'
        : 'SELECT id, name, cost, emoji, category, rarity FROM cosmetics_shop WHERE category = ? ORDER BY cost ASC';
      const params = category === 'all' ? [] : [category];

      db.all(query, params, (err, items) => {
        if (err) return interaction.reply('Error loading shop');
        if (!items || items.length === 0) return interaction.reply('No cosmetics found in this category.');

        const itemList = items
          .map(item => `${item.emoji} **${item.name}** - ${item.cost} XP (${item.rarity}, ${item.category})`)
          .join('\n');
        const embed = new EmbedBuilder()
          .setTitle('🛍️ Cosmetics Shop')
          .setDescription(itemList)
          .setColor('#FFD700');

        interaction.reply({ embeds: [embed] });
      });
    } else if (subcommand === 'buy') {
      const itemName = interaction.options.getString('item');
      const userId = interaction.user.id;
      const guildId = interaction.guild.id;

      db.get('SELECT * FROM cosmetics_shop WHERE name = ?', [itemName], (err, item) => {
        if (!item) return interaction.reply('Item not found');

        db.get('SELECT xp FROM user_levels WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, player) => {
          if (!player || player.xp < item.cost) {
            return interaction.reply(`❌ Not enough XP! Need ${item.cost} XP, you have ${player?.xp || 0}`);
          }

          db.run('UPDATE user_levels SET xp = xp - ? WHERE guild_id = ? AND user_id = ?', [item.cost, guildId, userId], (err) => {
            if (err) return interaction.reply('Error processing purchase');

            db.run('INSERT INTO player_cosmetics (guild_id, user_id, cosmetic_id) VALUES (?, ?, ?)', [guildId, userId, item.id], (err) => {
              if (err) return interaction.reply('Already own this item');
              interaction.reply(`✅ Purchased ${item.emoji} **${item.name}** for ${item.cost} XP!`);
            });
          });
        });
      });
    }
  } else if (commandName === 'cosmetic') {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    if (subcommand === 'equip') {
      const itemName = interaction.options.getString('item');

      db.get(`
        SELECT pc.id, cs.slot, cs.emoji FROM player_cosmetics pc
        JOIN cosmetics_shop cs ON pc.cosmetic_id = cs.id
        WHERE pc.guild_id = ? AND pc.user_id = ? AND cs.name = ?
      `, [guildId, userId, itemName], (err, cosmetic) => {
        if (!cosmetic) return interaction.reply('You don\'t own this cosmetic');

        db.run(`
          UPDATE player_cosmetics
          SET is_equipped = 0
          WHERE id IN (
            SELECT pc.id
            FROM player_cosmetics pc
            JOIN cosmetics_shop cs ON pc.cosmetic_id = cs.id
            WHERE pc.guild_id = ? AND pc.user_id = ? AND cs.slot = ?
          )
        `, [guildId, userId, cosmetic.slot], (clearErr) => {
          if (clearErr) {
            console.error('Clear slot equip error:', clearErr);
            return interaction.reply('Error equipping cosmetic');
          }

          db.run('UPDATE player_cosmetics SET is_equipped = 1 WHERE id = ?', [cosmetic.id], (equipErr) => {
            if (equipErr) {
              console.error('Set equip error:', equipErr);
              return interaction.reply('Error equipping cosmetic');
            }
            interaction.reply(`✅ Equipped ${cosmetic.emoji} ${itemName} in ${cosmetic.slot} slot!`);
          });
        });
      });
    } else if (subcommand === 'unequip') {
      db.run('UPDATE player_cosmetics SET is_equipped = 0 WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err) => {
        interaction.reply('✅ Unequipped cosmetic');
      });
    } else if (subcommand === 'inventory') {
      db.all(`
        SELECT cs.name, cs.emoji, cs.category, cs.rarity, cs.slot, pc.is_equipped FROM player_cosmetics pc
        JOIN cosmetics_shop cs ON pc.cosmetic_id = cs.id
        WHERE pc.guild_id = ? AND pc.user_id = ?
      `, [guildId, userId], (err, cosmetics) => {
        if (!cosmetics || cosmetics.length === 0) {
          return interaction.reply('You don\'t own any cosmetics yet. Use `/shop view` to buy some!');
        }

        const list = cosmetics.map(c => {
          return `${c.is_equipped ? '✅' : '  '} ${c.emoji} ${c.name} (${c.rarity}, ${c.category}, ${c.slot})`;
        }).join('\n');

        const embed = new EmbedBuilder()
          .setTitle('🎨 Your Cosmetics')
          .setDescription(list)
          .setColor('#9370DB');

        interaction.reply({ embeds: [embed] });
      });
    }
  } else if (commandName === 'balance') {
    const player = interaction.options.getUser('player') || interaction.user;
    const guildId = interaction.guild.id;

    db.get('SELECT xp, level FROM user_levels WHERE guild_id = ? AND user_id = ?', [guildId, player.id], (err, row) => {
      if (err) {
        console.error('Balance query error:', err);
        return interaction.reply('Error fetching balance');
      }

      if (!row) {
        return interaction.reply(`${player.username} has not earned any XP yet.`);
      }

      getEquippedCosmetics(guildId, player.id, (cosmeticErr, cosmetics) => {
        if (cosmeticErr) {
          console.error('Balance cosmetics lookup error:', cosmeticErr);
          return interaction.reply('Error fetching balance');
        }

        const displayName = decoratePlayerName(player.username, cosmetics);
        const embed = new EmbedBuilder()
          .setTitle(`💰 ${displayName}'s Balance`)
          .setColor('#00FF99')
          .addFields(
            { name: 'XP Balance', value: `${row.xp} XP`, inline: true },
            { name: 'Level', value: `${row.level}`, inline: true },
            { name: 'Equipped Cosmetics', value: formatEquippedCosmetics(cosmetics), inline: false }
          );

        interaction.reply({ embeds: [embed] });
      });
    });
  } else if (commandName === 'daily') {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    db.get('SELECT coins, last_daily FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, userId], (err, row) => {
      if (err) return interaction.reply('Error checking daily reward');
      const lastDaily = row?.last_daily ? new Date(row.last_daily).toISOString().split('T')[0] : null;
      if (lastDaily === today) {
        return interaction.reply('❌ You already claimed your daily reward today! Come back tomorrow.');
      }
      const reward = 100;
      const newCoins = (row?.coins || 0) + reward;
      db.run('INSERT OR REPLACE INTO player_coins (guild_id, user_id, coins, last_daily) VALUES (?, ?, ?, ?)', [guildId, userId, newCoins, now.toISOString()], (err) => {
        if (err) return interaction.reply('Error claiming daily reward');
        const embed = new EmbedBuilder().setTitle('💰 Daily Reward Claimed!').setColor('#FFD700').addFields({ name: 'Coins Earned', value: `+${reward}`, inline: true }, { name: 'Total Coins', value: `${newCoins}`, inline: true });
        interaction.reply({ embeds: [embed] });
      });
    });
  } else if (commandName === 'coins') {
    const player = interaction.options.getUser('player') || interaction.user;
    const guildId = interaction.guild.id;
    db.get('SELECT coins FROM player_coins WHERE guild_id = ? AND user_id = ?', [guildId, player.id], (err, row) => {
      if (err) return interaction.reply('Error fetching coins');
      const coins = row?.coins || 0;
      const embed = new EmbedBuilder().setTitle(`💵 ${player.username}'s Coin Balance`).setColor('#FFD700').setDescription(`**${coins}** coins`);
      interaction.reply({ embeds: [embed] });
    });
  } else if (commandName === 'xp-balance') {
    const player = interaction.options.getUser('player') || interaction.user;
    getLevelInfo(player.id, interaction.guildId, (err, row) => {
      if (err || !row) {
        return interaction.reply(`No XP data found for ${player.username}.`);
      }
      const currentMilestone = Math.floor(row.xp / 50) * 50;
      const nextMilestone = currentMilestone + 50;
      const xpToNextMilestone = nextMilestone - row.xp;
      
      getEquippedCosmetics(interaction.guildId, player.id, (cosmeticErr, cosmetics) => {
        if (cosmeticErr) {
          console.error('XP balance cosmetics lookup error:', cosmeticErr);
          return interaction.reply(`No XP data found for ${player.username}.`);
        }

        const displayName = decoratePlayerName(player.username, cosmetics);
        const embed = new EmbedBuilder()
          .setTitle(`💰 ${displayName}'s XP Balance`)
          .setColor(0x00FF00)
          .addFields(
            { name: 'Current XP', value: `${row.xp}`, inline: true },
            { name: 'Next Milestone', value: `${nextMilestone} XP`, inline: true },
            { name: 'XP to Milestone', value: `${xpToNextMilestone} XP`, inline: true },
            { name: 'Equipped Cosmetics', value: formatEquippedCosmetics(cosmetics), inline: false }
          )
          .setThumbnail(player.displayAvatarURL());
        interaction.reply({ embeds: [embed] });
      });
    });
  } else if (commandName === 'timer') {
    const matchType = interaction.options.getString('match_type');
    const duration = matchType === 'bo3' ? 60 : 30;
    const durationMs = duration * 60 * 1000;
    const startTime = Date.now();
    const endTime = startTime + durationMs;
    
    const msg = await interaction.reply({ 
      content: `⏱️ **${getLadderDisplayName(matchType)} Match Timer** - ${duration}min\nStarted at <t:${Math.floor(startTime / 1000)}:t>`, 
      fetchReply: true 
    });
    
    const updateInterval = setInterval(() => {
      const now = Date.now();
      const remaining = Math.max(0, endTime - now);
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      
      if (remaining <= 0) {
        clearInterval(updateInterval);
        msg.edit(`✅ **Match Complete!** Time's up!`).catch(err => console.error('Timer completion update error:', err));
      } else if (remaining <= 5 * 60 * 1000 && remaining > 4 * 60 * 1000) {
        msg.edit(`⚠️ **5 minutes remaining!**`).catch(err => console.error('Timer warning update error:', err));
      } else {
        msg.edit(`⏱️ **${getLadderDisplayName(matchType)} Match Timer**\n${minutes}m ${seconds}s remaining`).catch(err => console.error('Timer update error:', err));
      }
    }, 10000);
    
    setTimeout(() => clearInterval(updateInterval), durationMs + 5000);
  } else if (commandName === 'comments') {
    const subcommand = interaction.options.getSubcommand();
    
    if (subcommand === 'post') {
      const message = interaction.options.getString('message');
      const embed = new EmbedBuilder()
        .setTitle('💬 Comment Posted')
        .setColor(0x0099FF)
        .setDescription(message)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();
      
      const commentsChannel = interaction.guild.channels.cache.find(ch => ch.name === 'match-comments');
      if (commentsChannel) {
        commentsChannel.send({ embeds: [embed] }).catch(err => {
          console.error('Error posting comment to match-comments:', err);
          interaction.reply('Could not post comment to match-comments channel.');
        });
        interaction.reply('Your comment has been posted!');
      } else {
        interaction.reply('match-comments channel not found. Ask an admin to create it.');
      }
    } else if (subcommand === 'view') {
      interaction.reply('Match comments feature coming soon!');
    }
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