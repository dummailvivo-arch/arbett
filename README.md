# AR BET → Telegram live-score alert

This monitor checks AR BET's live soccer page every 45 seconds and sends a Telegram message whenever it sees a **"to score (incl. overtime)"** market whose **Yes rate is above 40%**. It remembers sent alerts, so it will not repeatedly message you for the same displayed rate.

Each alert extracts the player name from the market. The alert is sent through
the main bot, while the player's Transfermarkt club-by-club matches and goals,
totals, and profile link are sent through an optional separate bot. A player's
stats are sent only once per monitor process, even if the player appears in
multiple alerts. After each new player stats message, the stats bot sends an
updated session list with both the legacy **Goals-based safe score list**
(sorted by goals per match, lower values first) and an **AI-based list for safe
players** (lower score first). The AI-based score combines all-time,
latest-season, current-club, and recent goals per appearance; shots and shots
on target; penalty involvement; position; height; and the current season's
team and opponent goal context. It is a transparent heuristic, not a trained
prediction model. Data that Transfermarkt does not provide, such as expected
minutes, corner assignment, headed-goal splits, xG, lineups, possession,
corners, and live score state, is not fabricated and contributes no score
adjustment. The message includes the available figures used by the ranking.
When an enriched qualifying player is identified as a goalkeeper, the main
alert bot also sends a **Goalkeeper alert** each time that qualifying alert is
processed. Duplicate goalkeeper alerts are intentionally allowed. This is
informational because goalkeeper goals are rare but can occur through
penalties or unusual late-game situations.
When a live match ends or its target player market disappears, that player's
entry is retained for 10 minutes from the last rates fetch. It is removed only
if the player is still absent after that retention window, and the updated
list is sent.
The list lasts for the monitor process session and starts over when the process
restarts. If Transfermarkt is unavailable, the alert still sends and the stats
bot retries that player on a later qualifying alert.

## Set up Telegram

1. In Telegram, open **@BotFather**, send `/newbot`, and follow the prompts. Copy the bot token it gives you.
2. Open a chat with your new bot and press **Start** (or send it any message).
3. In a browser, open this address after replacing `TOKEN` with your token:
   `https://api.telegram.org/botTOKEN/getUpdates`
4. Find the number after `"chat":{"id":` in the response. That is your chat ID. For a group, add the bot to the group and send a message there first. To alert multiple people, separate their chat IDs with commas in `TELEGRAM_CHAT_ID`.

## Run it

1. Copy `.env.example` to `.env`.
2. Add your `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.
3. Install the app packages:

   ```powershell
   npm install
   ```

   On Windows the monitor uses the locally installed Microsoft Edge browser. On another system, set `ARBET_BROWSER_PATH` to the full path of Chrome or Edge, or install Playwright's Chromium with `npx playwright install chromium`.

4. Test one check:

   ```powershell
   npm run check
   ```

5. Leave it running:

   ```powershell
   npm start
   ```

6. Open the local dashboard at `http://127.0.0.1:3000`. It refreshes every
   five seconds, lists current player-to-score rates above the configured
   `YES_RATE_THRESHOLD` with the highest rates first, and shows enriched player
   statistics and AI safety scores. The live-match list shows each match's
   highest current target-market rate when that market is available, and
   `No rate` otherwise. A match/player remains visible for up to 10 minutes
   after it stops arriving in the live list, so a temporary zero-alert scan
   does not clear the list. It also lists all live matches successfully
   discovered during the latest scan. The dashboard identifies the target
   `To score (incl. overtime)` market in a **Target markets available** label
   and separately reports the total target markets discovered and the live
   markets above `YES_RATE_THRESHOLD`. It keeps the latest 50 qualifying alert
   entries with their match, rate, market, and send time. Change
   `DASHBOARD_PORT` in `.env` if port 3000 is unavailable.

## Notes

- Change `YES_RATE_THRESHOLD=40` or `CHECK_INTERVAL_SECONDS=45` in `.env` if desired.
- Set `DRY_RUN=true` to verify the scanner without sending Telegram messages. Set it back to `false` to enable alerts.
- Cookie, welcome, marketing, and notification popups are dismissed automatically before every scan. If a site popup changes substantially, run with `HEADLESS=false` to see it and share its wording or a screenshot so the rule can be extended.
- The scanner switches AR BET's Soccer page to its tournament/list view before following the scrollable live-match panels. This is required because the default match-row view exposes only the highlighted matches. It does not intentionally cap the number of matches and stops after the list reaches the bottom and remains unchanged for several passes; the safety limit is 80 scroll passes.
- If AR BET presents a CAPTCHA or requires a login, set `HEADLESS=false` for a visible browser window and complete it there; the site can also change its page layout, in which case the text parser in `src/index.js` may need a small update.
- Never share `.env`; it contains the secret Telegram bot token.
- To enable the separate stats bot, add `TRANSFERMARKT_BOT_TOKEN` and
  `TRANSFERMARKT_CHAT_ID` to `.env`. The chat ID may be comma-separated for
  multiple destinations. The stats bot is optional; the monitor continues
  sending main alerts if it is not configured.
- Transfermarkt lookups use the same performance-data approach as the bot in
  [`player/bot.py`](./player/bot.py). AR BET formats player names as
  `Surname, Given name`, so the monitor tries both name orders. Player
  discovery uses Transfermarkt's JSON quick-search API rather than relying
  only on its WAF-protected HTML search. Transfermarkt may rate-limit
  automated requests or present an anti-bot challenge; in that case the
  market alert remains available and the log identifies the blocked
  enrichment instead of reporting a misleading missing player.
