"""Telegram bot for looking up football player club totals on Transfermarkt."""

from __future__ import annotations

import logging
import os
import re
import unicodedata
from dataclasses import dataclass
from html import unescape
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import quote_plus, urljoin

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

BASE_URL = "https://www.transfermarkt.com"
API_URL = "https://tmapi.transfermarkt.technology"
USER_AGENT = (
    "Mozilla/5.0 (compatible; FootballStatsTelegramBot/1.0; "
    "+https://www.transfermarkt.com/)"
)
logger = logging.getLogger(__name__)


class TransfermarktError(RuntimeError):
    """Raised when Transfermarkt cannot provide a usable result."""


@dataclass(frozen=True)
class ClubStats:
    club: str
    appearances: int
    goals: int


@dataclass(frozen=True)
class PlayerResult:
    name: str
    profile_url: str
    clubs: tuple[ClubStats, ...]


class TransfermarktClient:
    def __init__(self, timeout: float = 15.0) -> None:
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})

    def _get(self, path: str) -> str:
        try:
            response = self.session.get(urljoin(BASE_URL, path), timeout=self.timeout)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise TransfermarktError("Transfermarkt could not be reached right now.") from exc
        return response.content.decode("utf-8", errors="replace")

    def _get_json(self, path: str) -> dict[str, Any]:
        try:
            response = self.session.get(urljoin(API_URL, path), timeout=self.timeout)
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            raise TransfermarktError("Transfermarkt statistics could not be loaded right now.") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), (dict, list)):
            raise TransfermarktError("Transfermarkt returned an invalid statistics response.")
        return payload

    def find_player(self, name: str) -> tuple[str, str]:
        queries = [name]
        parts = [part.strip() for part in name.split(",") if part.strip()]
        if len(parts) == 2:
            queries.append(f"{parts[1]} {parts[0]}")
        queries.extend(token for token in name.split() if len(token) >= 4)
        candidates: list[tuple[str, str]] = []
        for query in dict.fromkeys(queries):
            try:
                search = self._get_json(
                    f"/quick-search?term={quote_plus(query)}&page=1"
                )
                player_ids = (search.get("result") or {}).get("playerIds", [])
                for player_id in player_ids[:10]:
                    profile = self._get_json(f"/player/{player_id}")
                    profile_name = profile.get("name")
                    relative_url = profile.get("relativeUrl")
                    if isinstance(profile_name, str) and isinstance(relative_url, str):
                        candidates.append((profile_name, urljoin(BASE_URL, relative_url)))
                if candidates:
                    break
            except TransfermarktError:
                continue
        blocked = False
        for query in dict.fromkeys(queries):
            if candidates:
                break
            try:
                candidates.extend(self._search_candidates(query))
            except TransfermarktError as exc:
                blocked = blocked or "blocked" in str(exc).lower()
            if candidates:
                break
        requested = self._normalize_name(name)

        def score(candidate: tuple[str, str]) -> float:
            candidate_name = self._normalize_name(candidate[0])
            return SequenceMatcher(None, requested, candidate_name).ratio() + 0.5 * len(
                set(requested.split()) & set(candidate_name.split())
            )

        if not candidates or max(map(score, candidates)) < 1.2:
            for token in name.split():
                if len(token) >= 4:
                    candidates.extend(self._search_candidates(token))
        if not candidates:
            if blocked:
                raise TransfermarktError("Transfermarkt search was blocked by its anti-bot challenge.")
            raise TransfermarktError(f'No Transfermarkt player found for "{name}".')
        return max(candidates, key=score)

    def _search_candidates(self, query: str) -> list[tuple[str, str]]:
        response = self._get_response(
            f"/schnellsuche/ergebnis/schnellsuche?query={quote_plus(query)}"
        )
        html = response.content.decode("utf-8", errors="replace")
        soup = BeautifulSoup(html, "html.parser")
        candidates: list[tuple[str, str]] = []
        for link in soup.select('a[href*="/profil/spieler/"]'):
            href = link.get("href")
            label = link.get_text(" ", strip=True)
            if isinstance(href, str) and label:
                candidates.append((label, urljoin(BASE_URL, href)))
        return candidates

    def _get_response(self, path: str) -> requests.Response:
        try:
            response = self.session.get(urljoin(BASE_URL, path), timeout=self.timeout)
            if response.status_code == 202:
                raise TransfermarktError("Transfermarkt search was blocked by its anti-bot challenge.")
            response.raise_for_status()
        except TransfermarktError:
            raise
        except requests.RequestException as exc:
            raise TransfermarktError("Transfermarkt could not be reached right now.") from exc
        return response

    @staticmethod
    def _normalize_name(value: str) -> str:
        return "".join(
            character
            for character in unicodedata.normalize("NFKD", value.casefold())
            if not unicodedata.combining(character)
        ).translate(str.maketrans({character: " " for character in ",.-"})).strip()

    def get_player_stats(self, name: str) -> PlayerResult:
        player_name, profile_url = self.find_player(name)
        player_id_match = re.search(r"/spieler/(\d+)", profile_url)
        if player_id_match is None:
            raise TransfermarktError("Transfermarkt returned an invalid player profile.")
        player_id = player_id_match.group(1)
        performance_payload = self._get_json(f"/player/{player_id}/performance-game")
        performance = performance_payload["data"]
        if not isinstance(performance, dict):
            raise TransfermarktError("Transfermarkt returned an invalid performance response.")
        records = performance.get("performance")
        if not isinstance(records, list):
            raise TransfermarktError("No performance data was found for this player.")

        totals: dict[str, list[int]] = {}
        club_names: dict[str, str] = {}
        for record in records:
            if not isinstance(record, dict):
                continue
            clubs_information = record.get("clubsInformation")
            statistics = record.get("statistics")
            if not isinstance(clubs_information, dict) or not isinstance(statistics, dict):
                continue
            club = clubs_information.get("club")
            general = statistics.get("generalStatistics")
            goals = statistics.get("goalStatistics")
            if not isinstance(club, dict) or not isinstance(general, dict) or not isinstance(goals, dict):
                continue
            club_id = str(general.get("primaryClubId") or club.get("clubId") or "")
            if not club_id or general.get("participationState") not in (None, "played"):
                continue
            total = totals.setdefault(club_id, [0, 0])
            total[0] += 1
            total[1] += int(goals.get("goalsScoredTotalOfficial") or goals.get("goalsScoredTotal") or 0)

        for club_id in totals:
            club_payload = self._get_json(f"/club/{club_id}")["data"]
            if isinstance(club_payload, dict) and isinstance(club_payload.get("name"), str):
                club_names[club_id] = club_payload["name"]
        clubs = tuple(
            ClubStats(club_names.get(club_id, f"Club {club_id}"), values[0], values[1])
            for club_id, values in totals.items()
        )
        if not clubs:
            raise TransfermarktError("No club totals were found for this player.")
        return PlayerResult(unescape(player_name), profile_url, clubs)


def _format_result(result: PlayerResult) -> str:
    lines = [f"<b>{result.name}</b>", ""]
    lines.extend(f"- {item.club}: <b>{item.appearances}</b> matches, <b>{item.goals}</b> goals" for item in result.clubs)
    total_appearances = sum(item.appearances for item in result.clubs)
    total_goals = sum(item.goals for item in result.clubs)
    lines.append("")
    lines.append(f"<b>Total Matches:</b> {total_appearances}")
    lines.append(f"<b>Total Goals:</b> {total_goals}")
    lines.append("")
    lines.append(f'<a href="{result.profile_url}">Transfermarkt profile</a>')
    return "\n".join(lines)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message:
        await update.message.reply_text(
            "Send /player followed by a footballer's name.\nExample: /player Lionel Messi"
        )


async def lookup_player(update: Update, name: str) -> None:
    message = update.message or update.channel_post
    if not message:
        return
    reply_to_message_id = message.message_id if update.channel_post else None

    async def reply(text: str, **kwargs: Any) -> None:
        if reply_to_message_id is not None:
            kwargs["reply_to_message_id"] = reply_to_message_id
        await message.reply_text(text, **kwargs)

    if not name:
        await reply("Please send a football player's name.")
        return
    await reply(f"Searching Transfermarkt for {name}...")
    try:
        result = TransfermarktClient().get_player_stats(name)
        await reply(_format_result(result), parse_mode=ParseMode.HTML)
    except TransfermarktError as exc:
        await reply(str(exc))
    except Exception:
        logger.exception("Unexpected error while processing player lookup")
        await reply("An unexpected error occurred. Please try again later.")


async def player(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await lookup_player(update, " ".join(context.args).strip())


async def player_name_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message and update.message.text:
        await lookup_player(update, update.message.text.strip())


async def channel_player(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.channel_post and update.channel_post.text:
        name = update.channel_post.text.partition(" ")[2].strip()
        await lookup_player(update, name)


def main() -> None:
    load_dotenv()
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit("TELEGRAM_BOT_TOKEN is not set. Add it to .env or the environment.")
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    application = Application.builder().token(token).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("player", player))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, player_name_message))
    application.add_handler(
        MessageHandler(
            filters.UpdateType.CHANNEL_POST & filters.COMMAND,
            channel_player,
        )
    )
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
