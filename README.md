# HIDEOUT TCG Ranked Bot

A Discord bot for managing ranked Pokémon TCG matches and monthly leaderboards on the HIDEOUT TCG server.

## Features

- Player registration for leaderboards
- Report match results with winner/loser
- Monthly leaderboard tracking
- Automatic monthly reset on the 1st of each month
- Admin command to manually reset leaderboard

## Setup

1. Clone this repository
2. Install dependencies: `npm install`
3. Create a `.env` file in the root directory with your Discord bot token:
   ```
   DISCORD_TOKEN=your_bot_token_here
   ```
4. Run the bot: `npm start`

## Commands

- `/register`: Register yourself for the leaderboard
- `/report_match winner:@user loser:@user`: Report a match result
- `/leaderboard`: View the current monthly leaderboard
- `/stats [player:@user]`: View monthly stats for yourself or another player
- `/history_list`: View all months with leaderboard data
- `/history month:YYYY-MM`: View leaderboard for a specific past month
- `/player_history [player:@user]`: View a player's stats across all months
- `/match_history [limit:number] [month:YYYY-MM]`: View recent matches (optionally filter by month)
- `/help`: Show bot commands and usage
- `/reset_monthly`: Reset the monthly leaderboard (Admin only)
- `/undo_match player:@user`: Undo the last match for a player (Admin only)
- `/set_score player:@user points:number`: Set a player's score manually (Admin only)

## How It Works

- Each player starts with 0 points each month
- Winner of a match gains 1 point, loser loses 1 point
- Leaderboard is sorted by points (descending)
- Monthly leaderboards reset to 0 points on the 1st of each month, but all historical data is preserved
- Matches are recorded with timestamp, reporter, and associated month
- All past months' leaderboards and match history can be viewed using history commands
- Players can track their performance across multiple months
- Leaderboard is sorted by points (descending)
- Leaderboard resets to 0 points on the 1st of each month
- Matches are recorded with timestamp and reporter

## Database

The bot uses SQLite (`leaderboard.db`) to store player data and match history.

## Deployment

This bot is ready to deploy on any Node.js hosting platform:

### Railway (Recommended)
1. Push your repository to GitHub
2. Login to [Railway.app](https://railway.app)
3. Create a new project and select your GitHub repository
4. Add environment variable: `DISCORD_TOKEN` with your bot token
5. Deploy!

### Render
1. Connect your GitHub repository
2. Create a new Web Service
3. Set the build and start commands to use npm
4. Add environment variables

### Other Platforms (Heroku, Fly.io, etc.)
- Ensure `npm start` is set as the start command
- Add your `DISCORD_TOKEN` environment variable
- The bot will automatically create the database on first run

**Important:** Make sure your `.env` file is in `.gitignore` (it is by default). Never commit your bot token to GitHub.
