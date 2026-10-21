# AR BET → Telegram live-score alert

This monitor checks AR BET's live soccer page every 45 seconds and sends a Telegram message whenever it sees a **"to score (incl. overtime)"** market whose **Yes rate is above 40%**. It remembers sent alerts, so it will not repeatedly message you for the same displayed rate.

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

## Notes

- Change `YES_RATE_THRESHOLD=40` or `CHECK_INTERVAL_SECONDS=45` in `.env` if desired.
- Set `DRY_RUN=true` to verify the scanner without sending Telegram messages. Set it back to `false` to enable alerts.
- Cookie, welcome, marketing, and notification popups are dismissed automatically before every scan. If a site popup changes substantially, run with `HEADLESS=false` to see it and share its wording or a screenshot so the rule can be extended.
- The scanner follows AR BET's scrollable live-match panels and does not intentionally cap the number of matches. It stops after the list reaches the bottom and remains unchanged for several passes; the safety limit is 80 scroll passes.
- If AR BET presents a CAPTCHA or requires a login, set `HEADLESS=false` for a visible browser window and complete it there; the site can also change its page layout, in which case the text parser in `src/index.js` may need a small update.
- Never share `.env`; it contains the secret Telegram bot token.
