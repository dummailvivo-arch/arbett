import 'dotenv/config';
import { chromium } from 'playwright';

const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
}

const url = process.env.ARBET_URL || 'https://inr.arbet.club/live/soccer';
const threshold = Number(process.env.YES_RATE_THRESHOLD || 40);
const intervalMs = Math.max(15, Number(process.env.CHECK_INTERVAL_SECONDS || 45)) * 1000;
const once = process.argv.includes('--once');
const defaultWindowsEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let stopRequested = false;

async function dismissPopups(page) {
  const actions = [
    'button[aria-label*="close" i]',
    'button[title*="close" i]',
    '[role="dialog"] button:has-text("Accept")',
    '[role="dialog"] button:has-text("I agree")',
    '[role="dialog"] button:has-text("Got it")',
    '[role="dialog"] button:has-text("Continue")',
    '[role="dialog"] button:has-text("Not now")',
    '[class*="cookie" i] button:has-text("Accept")',
    '[class*="cookie" i] button:has-text("Allow all")',
    '[class*="modal" i] button[aria-label*="close" i]',
    '[class*="popup" i] button[aria-label*="close" i]',
  ];

  for (const selector of actions) {
    const candidate = page.locator(selector).first();
    try {
      if (await candidate.isVisible({ timeout: 350 })) {
        await candidate.click({ timeout: 1_000 });
        await page.waitForTimeout(150);
      }
    } catch {
      // The selector may match an element that disappears while the page is
      // updating. That is harmless; continue with the other dismissal options.
    }
  }

  // Many marketing modals use Escape even when they have no accessible close
  // button. It is safe here because no input is focused by the monitor.
  await page.keyboard.press('Escape').catch(() => {});

  // AR BET's first-run "Browse Sports & Markets" tutorial has no conventional
  // modal role or close button. Opt out and advance any remaining tour slides.
  const optOut = page.getByText('Do not show again', { exact: true }).last();
  try {
    if (await optOut.isVisible({ timeout: 500 })) await optOut.click({ timeout: 1_000, force: true });
  } catch {}
  for (let step = 0; step < 6; step += 1) {
    const next = page.getByText('Next', { exact: true }).last();
    try {
      if (!await next.isVisible({ timeout: 300 })) break;
      await next.click({ timeout: 1_000, force: true });
      await page.waitForTimeout(150);
    } catch {
      break;
    }
  }
  // The tour occasionally absorbs clicks in headless browsers. As a last
  // resort remove only the overlay that contains its distinctive opt-out text.
  // This does not touch any betting controls or market data.
  try {
    await page.getByText('Do not show again', { exact: true }).last().evaluate((element) => {
      let node = element;
      while (node.parentElement && node.parentElement !== document.body) {
        const style = getComputedStyle(node);
        if (style.position === 'fixed' || style.position === 'absolute') break;
        node = node.parentElement;
      }
      node.remove();
    });
  } catch {}
}

async function openMarketList(page) {
  for (const frame of page.frames()) {
    try {
      const list = frame.getByText('List of markets', { exact: true }).last();
      if (await list.isVisible({ timeout: 400 })) {
        await list.click({ timeout: 1_000 });
        await page.waitForTimeout(500);
      }
    } catch {}
  }
}

/*
 * Extracts rendered market cards. AR BET can alter its markup; keeping this
 * text-based makes the selector resilient and easy to tune from a saved page.
 */
function extractMarkets(bodyText) {
  const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    const market = lines[index];
    if (!/to\s+score\s*\(\s*incl\.?\s*overtime\s*\)/i.test(market)) continue;

    // A market title is generally followed by its Yes/No selections. Search
    // only the nearby text so a percentage from another market is not used.
    const window = lines.slice(Math.max(0, index - 3), index + 14);
    const yesIndex = window.findIndex((line) => /^yes\b/i.test(line));
    if (yesIndex === -1) continue;
    const yesText = window.slice(yesIndex, yesIndex + 4).join(' ');
    // AR BET's layouts can use either "Yes 41%" or "Yes 41".
    const rate = yesText.match(/\byes\b[^\d]{0,24}(\d+(?:[.,]\d+)?)/i);
    if (!rate) continue;

    const event = lines.slice(Math.max(0, index - 12), index)
      .find((line) => /\b(v|vs|–|-)\b/i.test(line)) || 'Live soccer match';
    matches.push({
      event,
      market,
      yesRate: Number(rate[1].replace(',', '.')),
    });
  }
  return matches;
}

function describeMatchText(bodyText, fallbackUrl) {
  const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const eventIndex = lines.findIndex((line) =>
    /[\p{L}].{1,80}\s+(?:-|–|vs?\.?|v\.)\s+[\p{L}]/iu.test(line)
    && !/to\s+score|overtime|handicap|total|winner/i.test(line),
  );
  const event = eventIndex >= 0 ? lines[eventIndex] : `Match ${fallbackUrl.match(/\d+(?:\/)?$/)?.[0]?.replace('/', '') || ''}`;
  // League names are normally shown immediately above the teams. Prefer a
  // nearby short text label and skip generic navigation/market labels.
  const league = eventIndex > 0
    ? lines.slice(Math.max(0, eventIndex - 5), eventIndex).reverse().find((line) =>
      line.length < 100
      && !/^(live|soccer|football|markets?|all|main|popular)$/i.test(line)
      && !/\d{1,2}:\d{2}|\d+%/.test(line),
    )
    : null;
  return { event, league: league || 'League unavailable' };
}

async function describeMatchPage(page, fallbackUrl) {
  for (const frame of page.frames()) {
    try {
      const description = describeMatchText(await frame.locator('body').innerText({ timeout: 3_000 }), fallbackUrl);
      if (!description.event.startsWith('Match ')) return description;
    } catch {}
  }
  return describeMatchText('', fallbackUrl);
}

async function findQualifyingMarkets(page) {
  const allMarkets = [];
  // The live odds UI is sometimes served from an iframe. Read the visible text
  // of the top-level document and every accessible child frame.
  for (const frame of page.frames()) {
    try {
      const bodyText = await frame.locator('body').innerText({ timeout: 5_000 });
      allMarkets.push(...extractMarkets(bodyText));
    } catch {
      // Cross-origin frames can be removed while loading; the other frames are
      // still useful and will be checked on the next polling pass.
    }
  }
  return allMarkets;
}

async function findLiveMatchUrls(page) {
  const matchUrls = new Set();
  for (const frame of page.frames()) {
    try {
      const urls = await frame.locator('a[href*="/live/soccer/"]').evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.href),
      );
      for (const candidate of urls) {
        const parsed = new URL(candidate);
        if (/\/live\/soccer\/\d+\/?$/.test(parsed.pathname)) matchUrls.add(parsed.href);
      }
      // Some single-page UI cards do not use anchor elements. Scan the frame's
      // rendered HTML as a fallback for route strings embedded in attributes.
      const html = await frame.content();
      for (const match of html.matchAll(/\/live\/soccer\/(\d+)/g)) {
        matchUrls.add(new URL(match[0], url).href);
      }
    } catch {
      // A frame may have been replaced while its live content was refreshing.
    }
  }
  return [...matchUrls];
}

async function collectVisibleEventIds(page, eventIds) {
  for (const frame of page.frames()) {
    try {
      const cardEventIds = await frame.locator('[data-event-id]').evaluateAll((cards) =>
        cards.map((card) => card.getAttribute('data-event-id')).filter(Boolean),
      );
      for (const eventId of cardEventIds) eventIds.add(eventId);
      const hrefs = await frame.locator('a[href*="/live/soccer/"]').evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.href),
      );
      for (const href of hrefs) {
        const match = new URL(href).pathname.match(/\/live\/soccer\/(\d+)\/?$/);
        if (match) eventIds.add(`sr:match:${match[1]}`);
      }
      const html = await frame.content();
      for (const match of html.matchAll(/\/live\/soccer\/(\d+)/g)) {
        eventIds.add(`sr:match:${match[1]}`);
      }
    } catch {}
  }
}

async function scrollLiveMatchLists(page) {
  const scrollResult = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frame.evaluate(() => {
        const candidates = [
          document.scrollingElement,
          ...document.querySelectorAll('*'),
        ].filter((element, index, elements) =>
          element
          && elements.indexOf(element) === index
          && element.scrollHeight > element.clientHeight + 20
          && element.clientHeight > 100,
        );
        let changed = false;
        let atBottom = true;
        for (const element of candidates) {
          const before = element.scrollTop;
          const step = Math.max(element.clientHeight * 0.8, 500);
          element.scrollTop = Math.min(element.scrollHeight, before + step);
          changed ||= element.scrollTop > before;
          atBottom &&= element.scrollTop + element.clientHeight >= element.scrollHeight - 5;
        }
        return { changed, atBottom };
      });
    } catch {
      return { changed: false, atBottom: true };
    }
  }));
  return {
    changed: scrollResult.some((result) => result.changed),
    atBottom: scrollResult.every((result) => result.atBottom),
  };
}

async function sendTelegramMessage(token, chatIds, message, botLabel) {
  if (process.env.DRY_RUN === 'true') {
    console.log(`DRY RUN — ${botLabel} Telegram message suppressed:\n${message}`);
    return false;
  }
  for (const chatId of chatIds) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`${botLabel} Telegram rejected the message for chat ${chatId}: ${JSON.stringify(result)}`);
  }
  return true;
}

async function sendTelegram(message) {
  const chatIds = process.env.TELEGRAM_CHAT_ID.split(',').map((id) => id.trim()).filter(Boolean);
  return sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatIds, message, 'Alert bot');
}

const TRANSFERMARKT_BASE_URL = 'https://www.transfermarkt.com';
const TRANSFERMARKT_API_URL = 'https://tmapi.transfermarkt.technology';
const sentPlayerStats = new Set();
const playerStatsInFlight = new Map();

function normalizePlayerName(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function playerNameQueries(name) {
  const parts = name.split(',').map((part) => part.trim()).filter(Boolean);
  const reordered = parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
  return [...new Set([name, reordered, ...name.split(/\s+/).filter((part) => part.length >= 4)])];
}

async function transfermarktRequest(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl), {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Transfermarkt returned HTTP ${response.status}`);
  return response;
}

async function transfermarktApiJson(path) {
  const response = await transfermarktRequest(TRANSFERMARKT_API_URL, path);
  const payload = await response.json();
  if (!payload?.data) throw new Error('Transfermarkt returned an invalid API response');
  return payload.data;
}

async function findTransfermarktPlayer(name) {
  const candidates = [];
  const searchQueries = playerNameQueries(name);
  let apiError;
  for (const query of searchQueries) {
    try {
      const search = await transfermarktApiJson(`/quick-search?term=${encodeURIComponent(query)}&page=1`);
      const playerIds = search?.result?.playerIds;
      if (!Array.isArray(playerIds)) continue;
      const profiles = await Promise.all(playerIds.slice(0, 10).map(async (id) => {
        const profile = await transfermarktApiJson(`/player/${id}`);
        const profileName = profile?.name;
        const relativeUrl = profile?.relativeUrl;
        return profileName && relativeUrl
          ? { name: profileName, url: new URL(relativeUrl, TRANSFERMARKT_BASE_URL).href }
          : null;
      }));
      candidates.push(...profiles.filter(Boolean));
      if (candidates.length) break;
    } catch (error) {
      apiError = error;
    }
  }
  let wasBlocked = false;
  for (const query of searchQueries) {
    if (candidates.length) break;
    try {
      const response = await transfermarktRequest(
        TRANSFERMARKT_BASE_URL,
        `/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(query)}`,
      );
      const html = await response.text();
      const linkPattern = /<a\b[^>]*href="([^"]*\/profil\/spieler\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      for (const match of html.matchAll(linkPattern)) {
        const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (label) candidates.push({ name: label, url: new URL(match[1], TRANSFERMARKT_BASE_URL).href });
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('HTTP 202')) wasBlocked = true;
    }
    if (candidates.length) break;
  }
  const requested = normalizePlayerName(name);
  const score = (candidate) => {
    const candidateName = normalizePlayerName(candidate.name);
    const requestedTokens = new Set(requested.split(/\s+/));
    const commonTokens = candidateName.split(/\s+/).filter((token) => requestedTokens.has(token)).length;
    let prefix = 0;
    for (let index = 0; index < Math.min(requested.length, candidateName.length); index += 1) {
      if (requested[index] !== candidateName[index]) break;
      prefix += 1;
    }
    return commonTokens * 100 + prefix / Math.max(requested.length, candidateName.length);
  };
  const player = candidates.sort((left, right) => score(right) - score(left))[0];
  if (!player && wasBlocked) {
    throw new Error('Transfermarkt search was blocked by its anti-bot challenge');
  }
  if (!player && apiError && candidates.length === 0) {
    const reason = apiError instanceof Error ? apiError.message : String(apiError);
    throw new Error(`Transfermarkt player search failed: ${reason}`);
  }
  if (!player || score(player) < 1) throw new Error(`No Transfermarkt player found for "${name}"`);
  return player;
}

async function getTransfermarktInfo(name) {
  const player = await findTransfermarktPlayer(name);
  const playerId = player.url.match(/\/spieler\/(\d+)/)?.[1];
  if (!playerId) throw new Error('Transfermarkt returned an invalid player profile');
  const performanceResponse = await transfermarktRequest(
    TRANSFERMARKT_API_URL,
    `/player/${playerId}/performance-game`,
  );
  const performancePayload = await performanceResponse.json();
  const records = performancePayload?.data?.performance;
  if (!Array.isArray(records)) throw new Error('Transfermarkt returned no performance data');

  const totals = new Map();
  for (const record of records) {
    const general = record?.clubsInformation && record?.statistics?.generalStatistics;
    const goals = record?.statistics?.goalStatistics;
    const club = record?.clubsInformation?.club;
    if (!general || !goals || !club || (general.participationState !== undefined && general.participationState !== 'played')) continue;
    const clubId = String(general.primaryClubId || club.clubId || '');
    if (!clubId) continue;
    const total = totals.get(clubId) || { appearances: 0, goals: 0, name: club.name || `Club ${clubId}` };
    total.appearances += 1;
    total.goals += Number(goals.goalsScoredTotalOfficial || goals.goalsScoredTotal || 0);
    totals.set(clubId, total);
  }
  if (!totals.size) throw new Error('Transfermarkt returned no club totals');

  const clubs = await Promise.all([...totals].map(async ([clubId, total]) => {
    if (total.name !== `Club ${clubId}`) return total;
    const clubResponse = await transfermarktRequest(TRANSFERMARKT_API_URL, `/club/${clubId}`);
    const clubPayload = await clubResponse.json();
    return { ...total, name: clubPayload?.data?.name || total.name };
  }));
  const appearances = clubs.reduce((sum, club) => sum + club.appearances, 0);
  const goals = clubs.reduce((sum, club) => sum + club.goals, 0);
  return { player, clubs, appearances, goals };
}

function formatTransfermarktInfo(info) {
  return [
    `Transfermarkt: ${info.player.name}`,
    ...info.clubs.map((club) => `- ${club.name}: ${club.appearances} matches, ${club.goals} goals`),
    `Total Matches: ${info.appearances}`,
    `Total Goals: ${info.goals}`,
    `Profile: ${info.player.url}`,
  ].join('\n');
}

async function sendPlayerStatsOnce(player) {
  const key = normalizePlayerName(player);
  if (sentPlayerStats.has(key)) return false;
  if (playerStatsInFlight.has(key)) return playerStatsInFlight.get(key);

  const task = (async () => {
    const token = process.env.TRANSFERMARKT_BOT_TOKEN;
    const chatIds = (process.env.TRANSFERMARKT_CHAT_ID || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (!token || !chatIds.length) {
      console.warn(`[${new Date().toISOString()}] Transfermarkt bot is not configured; stats were not sent for ${player}.`);
      return false;
    }

    let timeoutId;
    try {
      const lookup = getTransfermarktInfo(player);
      const info = await Promise.race([
        lookup,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('lookup timed out')), 15_000);
        }),
      ]);
      await sendTelegramMessage(
        token,
        chatIds,
        formatTransfermarktInfo(info),
        'Transfermarkt stats bot',
      );
      sentPlayerStats.add(key);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[${new Date().toISOString()}] Transfermarkt stats failed for ${player}: ${reason}`);
      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      playerStatsInFlight.delete(key);
    }
  })();
  playerStatsInFlight.set(key, task);
  return task;
}

async function sendAlertWithPlayerStats(message, player) {
  try {
    await sendTelegram(message);
    if (player) await sendPlayerStatsOnce(player);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[${new Date().toISOString()}] Alert delivery failed: ${reason}`);
  }
}

function eventFromDetails(payload) {
  const markets = payload?.data?.list || [];
  const oneXTwo = markets.find((market) => market.marketName === '1x2');
  const teams = oneXTwo ? Object.values(oneXTwo.outcomes || {})
    .map((outcome) => outcome.name)
    .filter((name) => name && name.toLowerCase() !== 'draw') : [];
  return teams.length >= 2 ? `${teams[0]} vs ${teams[1]}` : 'Live soccer match';
}

function matchDetailsToAlerts(payload, fallbackLeague = 'Live soccer') {
  const markets = payload?.data?.list || [];
  const event = eventFromDetails(payload);
  return markets
    .filter((market) => /to\s+score\s*\(\s*incl\.?\s*overtime\s*\)/i.test(market.marketName || ''))
    .map((market) => {
      const yes = Object.values(market.outcomes || {}).find((outcome) => /^yes\b/i.test(outcome.name || ''));
      const player = market.marketName.match(/^(.+?)\s+to\s+score\s*\(/i)?.[1]?.trim();
      return yes?.active && Number.isFinite(Number(yes.odds))
        ? { event, league: fallbackLeague, market: market.marketName, player, yesRate: Number(yes.odds) }
        : null;
    })
    .filter(Boolean);
}

function findLeague(overviewText, teams) {
  const lines = overviewText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstTeam = teams[0];
  const index = lines.indexOf(firstTeam);
  if (index < 0) return 'Live soccer';
  return lines.slice(Math.max(0, index - 20), index).reverse().find((line) =>
    /league|liga|serie|division|championship|libertadores|ligue|premier|\blpf\b|superliga|\bcopa\b|\bcup\b/i.test(line)
    && !/^soccer\s*\(\d+\)$/i.test(line),
  ) || 'Live soccer';
}

function findMatchClock(overviewText, teams) {
  const lines = overviewText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.indexOf(teams[0]);
  if (index < 0) return 'Unavailable';
  const context = lines.slice(Math.max(0, index - 12), index);
  const clock = [...context].reverse().find((line) => /^\d{1,2}:\d{2}$/.test(line));
  const period = [...context].reverse().find((line) => /^(?:1st|2nd) half$|^half[- ]?time$|^extra time$/i.test(line));
  return [clock, period].filter(Boolean).join(' · ') || 'Unavailable';
}

async function check(page) {
  const liveListResponses = [];
  const eventIds = new Set();
  const collectLiveListRequest = (request) => {
    if (!request.url().includes('/market-odds-live/v1/list-primary-markets')) return;
    try {
      const payload = JSON.parse(request.postData() || '{}');
      for (const eventId of payload.eventIds || []) eventIds.add(eventId);
    } catch {}
  };
  const collectLiveListResponse = (response) => {
    if (response.url().includes('/market-odds-live/v1/list-primary-markets')) {
      liveListResponses.push(response);
    }
  };
  page.on('request', collectLiveListRequest);
  page.on('response', collectLiveListResponse);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissPopups(page);
  await page.waitForTimeout(4_000);
  // AR BET loads matches lazily in a scrollable panel. Scroll every frame's
  // scroll containers so discovery does not depend on the page-level window.
  let stableScrolls = 0;
  let previousEventCount = eventIds.size;
  for (let attempt = 0; attempt < 80 && stableScrolls < 3; attempt += 1) {
    await collectVisibleEventIds(page, eventIds);
    await page.mouse.wheel(0, 1_000);
    const scrollState = await scrollLiveMatchLists(page);
    // The next lazy-loaded batch can be requested shortly after the list
    // reaches the bottom, so allow the request/response cycle to complete.
    await page.waitForTimeout(1_500);
    await collectVisibleEventIds(page, eventIds);
    if (eventIds.size === previousEventCount && !scrollState.changed) {
      stableScrolls += 1;
    } else {
      stableScrolls = 0;
      previousEventCount = eventIds.size;
    }
  }
  page.off('request', collectLiveListRequest);
  page.off('response', collectLiveListResponse);

  for (const response of liveListResponses) {
    try {
      const liveList = await response.json();
      for (const eventId of Object.keys(liveList?.data || {})) eventIds.add(eventId);
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] Could not read live match batch: ${error.message}`);
    }
  }
  const discoveredEventIds = [...eventIds];
  console.log(`[${new Date().toISOString()}] Discovered ${discoveredEventIds.length} live match page(s) from AR BET across ${liveListResponses.length} batch(es).`);
  const overviewText = await page.locator('body').innerText().catch(() => '');
  const markets = [];
  const detailsRequest = Promise.all(discoveredEventIds.map(async (eventId) => {
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await page.evaluate(async ({ eventId: currentEventId }) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          try {
            const response = await fetch('/api/bff/app/sport/data/market-odds-live/v1/details-page', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ eventId: currentEventId, sportId: 'sr:sport:1', pageNo: 1, pageSize: 200 }),
              signal: controller.signal,
            });
            const payload = await response.json();
            return { ok: response.ok, payload, error: response.ok ? null : `HTTP ${response.status}` };
          } finally {
            clearTimeout(timeout);
          }
        }, { eventId });
        if (!result.ok) throw new Error(result.error);
        return [eventId, result.payload, null];
      } catch (error) {
        lastError = error.message;
        if (attempt < 3) await page.waitForTimeout(500 * attempt);
      }
    }
    return [eventId, null, new Error(lastError)];
  }));
  const detailsByEvent = await detailsRequest;
  for (const [eventId, details, error] of detailsByEvent) {
    const numericId = eventId.split(':').at(-1);
    if (!details?.data?.list) {
      console.warn(`[${new Date().toISOString()}] Could not load match ${numericId}: ${error?.message || 'details response had no market list'}.`);
      continue;
    }
    const candidates = matchDetailsToAlerts(details);
    const event = eventFromDetails(details);
    const teams = event.split(' vs ');
    const league = findLeague(overviewText, teams);
    const gameTime = findMatchClock(overviewText, teams);
    const namedCandidates = candidates.map((candidate) => ({ ...candidate, league, gameTime }));
    const display = namedCandidates[0]?.event || event || `Match ${numericId}`;
    console.log(`[${new Date().toISOString()}] Scanning: ${league} — ${display} (${gameTime})`);
    markets.push(...namedCandidates);
  }
  let alerts = 0;

  for (const market of markets) {
    if (!(market.yesRate > threshold)) continue;
    const message = [
      '⚽ AR BET live-market alert',
      `League: ${market.league}`,
      `Match: ${market.event}`,
      `Game time: ${market.gameTime}`,
      `Market: ${market.market}`,
      `Yes rate: ${market.yesRate} (above ${threshold})`,
      url,
    ].join('\n');
    await sendAlertWithPlayerStats(message, market.player);
    alerts += 1;
  }
  console.log(`[${new Date().toISOString()}] Scanned ${discoveredEventIds.length} live match page(s); found ${markets.length} target market(s); sent ${alerts} alert(s).`);
}

async function main() {
  // Use the locally installed Edge on Windows so this works without Playwright
  // having to download its own browser. ARBET_BROWSER_PATH can override this.
  const executablePath = process.env.ARBET_BROWSER_PATH || (process.platform === 'win32' ? defaultWindowsEdge : undefined);
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    executablePath,
    args: ['--disable-notifications'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // Dismiss ordinary JavaScript dialogs as soon as they are raised, including
  // dialogs that appear while the page is still loading.
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  const requestStop = () => { stopRequested = true; };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    do {
      try {
        await check(page);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Check failed: ${error.message}`);
      }
      if (!once && !stopRequested) {
        // A short sleep loop lets Ctrl+C close the browser cleanly instead of
        // attempting another scan against a page that is already closing.
        const end = Date.now() + intervalMs;
        while (!stopRequested && Date.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(500, end - Date.now())));
        }
      }
    } while (!once && !stopRequested);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
