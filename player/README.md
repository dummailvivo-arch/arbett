# Football Transfermarkt Telegram Bot

This bot accepts a football player name and replies with the player's total
matches and goals for each club, using Transfermarkt's detailed performance
data.

The bot uses Transfermarkt's current frontend performance-data API to count
records marked as played and sum each record's official goals by club. This
endpoint is not a versioned public API, so a future Transfermarkt change may
require an update.

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Create a virtual environment and install dependencies:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

3. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.
4. Start the bot:

   ```powershell
   python bot.py
   ```

5. In Telegram, send `/player Lionel Messi`.

## Using a Telegram channel

You can also trigger lookups from channel posts. Create a channel, add the bot
as an administrator with permission to post messages, and post:

```text
/player Cristiano Ronaldo
```

The bot will reply with the club breakdown and total matches/goals. Telegram
does not let a bot create a channel automatically; the channel must be created
in the Telegram app or client first. The bot must be an administrator in that
channel, and its privacy mode does not affect channel posts.

The bot uses Telegram polling, so no public webhook URL is needed. Keep the
bot token private and do not commit `.env`. Transfermarkt may change its HTML
or rate-limit automated requests; use this for reasonable, low-volume lookups
and respect Transfermarkt's terms and robots policy.
