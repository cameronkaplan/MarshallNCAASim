from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORKBOOK = ROOT / "NCAA_2026_Teams.xlsx"
DEFAULT_JSON_OUTPUT = ROOT / "data" / "marshall-simulator-data.json"
DEFAULT_JS_OUTPUT = ROOT / "app-data.js"
DEFAULT_SNAPSHOT = ROOT / "data" / "source" / "boxscorus-march-madness.html"

BOXSCORUS_URL = "https://www.boxscorus.com/ncaab/march-madness"
BOXSCORUS_PAGE_REGEX = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>'
)

REGION_ORDER = ["south", "east", "west", "midwest"]
REGION_LABELS = {
    "south": "South",
    "east": "East",
    "west": "West",
    "midwest": "Midwest",
}
ROUND_META = OrderedDict(
    [
        ("firstFour", {"label": "First Four", "points": 0, "order": 0}),
        ("roundOf64", {"label": "Round of 64", "points": 1, "order": 1}),
        ("roundOf32", {"label": "Round of 32", "points": 2, "order": 2}),
        ("sweet16", {"label": "Sweet 16", "points": 3, "order": 3}),
        ("elite8", {"label": "Elite 8", "points": 4, "order": 4}),
        ("finalFour", {"label": "Final Four", "points": 5, "order": 5}),
        ("championship", {"label": "Championship", "points": 6, "order": 6}),
    ]
)
FIRST_ROUND_PAIRINGS = [
    (1, 16),
    (8, 9),
    (5, 12),
    (4, 13),
    (6, 11),
    (3, 14),
    (7, 10),
    (2, 15),
]
SEED_COSTS = {
    1: 50,
    2: 30,
    3: 20,
    4: 15,
    5: 12,
    6: 10,
    7: 7,
    8: 5,
    9: 5,
    10: 5,
    11: 4,
    12: 4,
    13: 2,
    14: 1,
    15: 1,
    16: 1,
}


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


ROSTER_ALIASES = {
    normalize_key("Brigham Young"): "byu",
    normalize_key("Cal Baptist"): "california-baptist",
    normalize_key("Central Florida"): "ucf",
    normalize_key("Connecticut"): "uconn",
    normalize_key("Iowa State"): "iowa-st",
    normalize_key("Kennesaw State"): "kennesaw-st",
    normalize_key("Long Island"): "long-island",
    normalize_key("McNeese State"): "mcneese",
    normalize_key("Michigan State"): "michigan-st",
    normalize_key("North Dakota State"): "north-dakota-st",
    normalize_key("Northern Iowa"): "uni",
    normalize_key("Ohio State"): "ohio-st",
    normalize_key("Pennsylvania"): "penn",
    normalize_key("Queens"): "queens-nc",
    normalize_key("Saint Louis"): "saint-louis",
    normalize_key("South Florida"): "south-fla",
    normalize_key("St. John's"): "st-johns-ny",
    normalize_key("St. John's "): "st-johns-ny",
    normalize_key("St. Mary's"): "st-marys-ca",
    normalize_key("Texas Christian"): "tcu",
    normalize_key("Utah State"): "utah-st",
    normalize_key("Virgina"): "virginia",
    normalize_key("Virginia Commonwealth"): "vcu",
    normalize_key("Viriginia Commonwealth"): "vcu",
    normalize_key("Wright State"): "wright-st",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the Marshall Game Simulator data bundle."
    )
    parser.add_argument(
        "--workbook",
        type=Path,
        default=DEFAULT_WORKBOOK,
        help="Path to the roster workbook.",
    )
    parser.add_argument(
        "--html",
        type=Path,
        help="Use a local Boxscorus HTML snapshot instead of fetching.",
    )
    parser.add_argument(
        "--snapshot",
        type=Path,
        default=DEFAULT_SNAPSHOT,
        help="Snapshot path to read or refresh.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Fetch a fresh Boxscorus page and overwrite the snapshot.",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        default=DEFAULT_JSON_OUTPUT,
        help="Where to write the JSON data bundle.",
    )
    parser.add_argument(
        "--js-output",
        type=Path,
        default=DEFAULT_JS_OUTPUT,
        help="Where to write the browser data bundle.",
    )
    return parser.parse_args()


def fetch_boxscorus_html() -> str:
    result = subprocess.run(
        ["curl", "-sS", BOXSCORUS_URL],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def load_boxscorus_html(args: argparse.Namespace) -> tuple[str, str]:
    if args.html:
        return args.html.read_text(), f"local HTML ({args.html})"

    if args.refresh:
        html = fetch_boxscorus_html()
        args.snapshot.parent.mkdir(parents=True, exist_ok=True)
        args.snapshot.write_text(html)
        return html, f"fresh fetch ({BOXSCORUS_URL})"

    if args.snapshot.exists():
        return args.snapshot.read_text(), f"snapshot ({args.snapshot})"

    html = fetch_boxscorus_html()
    args.snapshot.parent.mkdir(parents=True, exist_ok=True)
    args.snapshot.write_text(html)
    return html, f"fresh fetch ({BOXSCORUS_URL})"


def extract_bracket_data(html: str) -> dict[str, Any]:
    match = BOXSCORUS_PAGE_REGEX.search(html)
    if not match:
        raise ValueError("Could not locate __NEXT_DATA__ in the Boxscorus HTML.")

    payload = json.loads(match.group(1))
    return payload["props"]["pageProps"]["bracketData"]


def build_team_entries(bracket_data: dict[str, Any]) -> list[dict[str, Any]]:
    team_locations: dict[str, dict[str, Any]] = {}

    for region, seed_map in bracket_data["regions"].items():
        for seed_str, slug in seed_map.items():
            team_locations[slug] = {
                "region": region,
                "seed": int(seed_str),
                "playInTeam": False,
            }

    for game in bracket_data["firstFour"]:
        for slug in game["teams"]:
            team_locations.setdefault(
                slug,
                {
                    "region": game["region"],
                    "seed": int(game["seed"]),
                    "playInTeam": True,
                },
            )

    team_entries: list[dict[str, Any]] = []
    for slug, info in sorted(bracket_data["teams"].items(), key=lambda item: item[1]["name"]):
        location = team_locations.get(slug, {})
        team_entries.append(
            {
                "slug": slug,
                "name": info["name"],
                "seed": int(location.get("seed", info["seed"])),
                "region": location.get("region"),
                "playInTeam": bool(location.get("playInTeam", False)),
                "color": info["color"],
                "elo": float(info["elo"]),
                "pace": float(info["pace"]),
                "adjOff": float(info["adjOff"]),
                "adjDef": float(info["adjDef"]),
                "netRating": round(float(info["adjOff"]) - float(info["adjDef"]), 2),
                "sourceOdds": {
                    "r64": float(info["r64"]),
                    "r32": float(info["r32"]),
                    "s16": float(info["s16"]),
                    "e8": float(info["e8"]),
                    "ff": float(info["ff"]),
                    "champGame": float(info["champGame"]),
                    "champ": float(info["champ"]),
                },
            }
        )

    return team_entries


def build_slug_lookup(bracket_data: dict[str, Any]) -> dict[str, str]:
    lookup: dict[str, str] = {}

    for slug, info in bracket_data["teams"].items():
        lookup[normalize_key(info["name"])] = slug
        lookup[normalize_key(slug.replace("-", " "))] = slug

    lookup.update(ROSTER_ALIASES)
    return lookup


def map_roster_team_name(name: str, seed: int, slug_lookup: dict[str, str]) -> str:
    normalized = normalize_key(name)
    direct = slug_lookup.get(normalized)
    if direct:
        return direct

    if normalized == normalize_key("Virginia") and seed == 11:
        return "vcu"
    if normalized == normalize_key("Virginia") and seed == 3:
        return "virginia"

    raise KeyError(f"Could not map roster team '{name}' (seed {seed}).")


def build_participants(
    workbook_path: Path, slug_lookup: dict[str, str]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rosters = pd.read_excel(workbook_path, sheet_name="Rosters")
    rosters["First"] = rosters["First"].astype(str).str.strip()
    rosters["Last"] = rosters["Last"].astype(str).str.strip()
    rosters["Team"] = rosters["Team"].astype(str).str.strip()
    rosters["Seed"] = rosters["Seed"].astype(int)
    rosters["Cost"] = rosters["Cost"].astype(int)
    rosters["Participant"] = rosters["First"] + " " + rosters["Last"]
    rosters["slug"] = rosters.apply(
        lambda row: map_roster_team_name(row["Team"], int(row["Seed"]), slug_lookup),
        axis=1,
    )

    duplicates = (
        rosters.groupby(["Participant", "slug"]).size().reset_index(name="count").query("count > 1")
    )
    if not duplicates.empty:
        problems = ", ".join(
            f"{row.Participant} -> {row.slug} x{row.count}" for row in duplicates.itertuples()
        )
        raise ValueError(f"Duplicate normalized teams found in roster workbook: {problems}")

    participants: list[dict[str, Any]] = []
    for participant_name, group in rosters.groupby("Participant", sort=False):
        participants.append(
            {
                "id": normalize_key(participant_name),
                "name": participant_name,
                "firstName": group["First"].iloc[0],
                "lastName": group["Last"].iloc[0],
                "teamCount": int(len(group)),
                "budgetSpent": int(group["Cost"].sum()),
                "teams": group["slug"].tolist(),
            }
        )

    summary = {
        "entryCount": int(rosters["Participant"].nunique()),
        "selectedTeamSlots": int(rosters["slug"].nunique()),
        "rosterRowCount": int(len(rosters)),
    }
    return participants, summary


def attach_source_result(
    game: dict[str, Any], completed_results: dict[str, Any]
) -> None:
    source_result = completed_results.get(game["id"])
    if source_result:
        game["sourceResult"] = {
            "winner": source_result["winner"],
            "loser": source_result["loser"],
            "scoreA": int(source_result["scoreA"]),
            "scoreB": int(source_result["scoreB"]),
        }
    else:
        game["sourceResult"] = None


def build_published_round_one_probabilities(
    bracket_data: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    published: dict[str, dict[str, Any]] = {}
    teams = bracket_data["teams"]
    completed_results = bracket_data["completedResults"]

    for region in REGION_ORDER:
        region_slots = {int(seed): slug for seed, slug in bracket_data["regions"][region].items()}
        for index, (seed_a, seed_b) in enumerate(FIRST_ROUND_PAIRINGS):
            game_id = f"{region}-r64-{index}"
            if game_id in completed_results:
                continue
            if seed_a not in region_slots or seed_b not in region_slots:
                continue

            team_a = region_slots[seed_a]
            team_b = region_slots[seed_b]
            probability_a = float(teams[team_a]["r32"])
            probability_b = float(teams[team_b]["r32"])
            if abs((probability_a + probability_b) - 1.0) > 0.02:
                continue

            published[game_id] = {
                "teamA": team_a,
                "teamB": team_b,
                "probabilityA": round(probability_a, 4),
            }

    return published


def build_games(bracket_data: dict[str, Any]) -> list[dict[str, Any]]:
    completed_results = bracket_data["completedResults"]
    published_round_one = build_published_round_one_probabilities(bracket_data)
    first_four_lookup: dict[tuple[str, int], str] = {}
    games: list[dict[str, Any]] = []

    for first_four in bracket_data["firstFour"]:
        region = first_four["region"]
        seed = int(first_four["seed"])
        game_id = f"first-four-{region}-{seed}"
        first_four_lookup[(region, seed)] = game_id
        game = {
            "id": game_id,
            "title": f"First Four • {REGION_LABELS[region]} {seed}-seed",
            "roundKey": "firstFour",
            "roundLabel": ROUND_META["firstFour"]["label"],
            "roundOrder": ROUND_META["firstFour"]["order"],
            "points": ROUND_META["firstFour"]["points"],
            "region": region,
            "regionLabel": REGION_LABELS[region],
            "seedPair": [seed, seed],
            "slotA": {"type": "team", "team": first_four["teams"][0]},
            "slotB": {"type": "team", "team": first_four["teams"][1]},
        }
        attach_source_result(game, completed_results)
        games.append(game)

    for region in REGION_ORDER:
        region_slots = {int(seed): slug for seed, slug in bracket_data["regions"][region].items()}
        round_of_64_ids: list[str] = []

        for index, (seed_a, seed_b) in enumerate(FIRST_ROUND_PAIRINGS):
            game_id = f"{region}-r64-{index}"
            slot_a = (
                {"type": "team", "team": region_slots[seed_a]}
                if seed_a in region_slots
                else {"type": "game", "gameId": first_four_lookup[(region, seed_a)]}
            )
            slot_b = (
                {"type": "team", "team": region_slots[seed_b]}
                if seed_b in region_slots
                else {"type": "game", "gameId": first_four_lookup[(region, seed_b)]}
            )

            game = {
                "id": game_id,
                "title": f"{REGION_LABELS[region]} • {seed_a} vs {seed_b}",
                "roundKey": "roundOf64",
                "roundLabel": ROUND_META["roundOf64"]["label"],
                "roundOrder": ROUND_META["roundOf64"]["order"],
                "points": ROUND_META["roundOf64"]["points"],
                "region": region,
                "regionLabel": REGION_LABELS[region],
                "seedPair": [seed_a, seed_b],
                "slotA": slot_a,
                "slotB": slot_b,
            }
            published_probability = published_round_one.get(game_id)
            if published_probability:
                game["publishedProbability"] = published_probability
            attach_source_result(game, completed_results)
            games.append(game)
            round_of_64_ids.append(game_id)

        round_of_32_ids: list[str] = []
        for index in range(4):
            game_id = f"{region}-r32-{index}"
            game = {
                "id": game_id,
                "title": f"{REGION_LABELS[region]} • Round of 32 • Game {index + 1}",
                "roundKey": "roundOf32",
                "roundLabel": ROUND_META["roundOf32"]["label"],
                "roundOrder": ROUND_META["roundOf32"]["order"],
                "points": ROUND_META["roundOf32"]["points"],
                "region": region,
                "regionLabel": REGION_LABELS[region],
                "slotA": {"type": "game", "gameId": round_of_64_ids[index * 2]},
                "slotB": {"type": "game", "gameId": round_of_64_ids[index * 2 + 1]},
            }
            attach_source_result(game, completed_results)
            games.append(game)
            round_of_32_ids.append(game_id)

        sweet_16_ids: list[str] = []
        for index in range(2):
            game_id = f"{region}-s16-{index}"
            game = {
                "id": game_id,
                "title": f"{REGION_LABELS[region]} • Sweet 16 • Game {index + 1}",
                "roundKey": "sweet16",
                "roundLabel": ROUND_META["sweet16"]["label"],
                "roundOrder": ROUND_META["sweet16"]["order"],
                "points": ROUND_META["sweet16"]["points"],
                "region": region,
                "regionLabel": REGION_LABELS[region],
                "slotA": {"type": "game", "gameId": round_of_32_ids[index * 2]},
                "slotB": {"type": "game", "gameId": round_of_32_ids[index * 2 + 1]},
            }
            attach_source_result(game, completed_results)
            games.append(game)
            sweet_16_ids.append(game_id)

        game_id = f"{region}-e8-0"
        game = {
            "id": game_id,
            "title": f"{REGION_LABELS[region]} • Elite 8",
            "roundKey": "elite8",
            "roundLabel": ROUND_META["elite8"]["label"],
            "roundOrder": ROUND_META["elite8"]["order"],
            "points": ROUND_META["elite8"]["points"],
            "region": region,
            "regionLabel": REGION_LABELS[region],
            "slotA": {"type": "game", "gameId": sweet_16_ids[0]},
            "slotB": {"type": "game", "gameId": sweet_16_ids[1]},
        }
        attach_source_result(game, completed_results)
        games.append(game)

    for index, matchup in enumerate(bracket_data["finalFourMatchups"]):
        game = {
            "id": f"final-four-{index}",
            "title": f"Final Four • {REGION_LABELS[matchup[0]]} vs {REGION_LABELS[matchup[1]]}",
            "roundKey": "finalFour",
            "roundLabel": ROUND_META["finalFour"]["label"],
            "roundOrder": ROUND_META["finalFour"]["order"],
            "points": ROUND_META["finalFour"]["points"],
            "region": None,
            "regionLabel": None,
            "slotA": {"type": "game", "gameId": f"{matchup[0]}-e8-0"},
            "slotB": {"type": "game", "gameId": f"{matchup[1]}-e8-0"},
        }
        attach_source_result(game, completed_results)
        games.append(game)

    championship = {
        "id": "championship-0",
        "title": "National Championship",
        "roundKey": "championship",
        "roundLabel": ROUND_META["championship"]["label"],
        "roundOrder": ROUND_META["championship"]["order"],
        "points": ROUND_META["championship"]["points"],
        "region": None,
        "regionLabel": None,
        "slotA": {"type": "game", "gameId": "final-four-0"},
        "slotB": {"type": "game", "gameId": "final-four-1"},
    }
    attach_source_result(championship, completed_results)
    games.append(championship)

    return games


def build_payload(args: argparse.Namespace) -> dict[str, Any]:
    html, html_source = load_boxscorus_html(args)
    bracket_data = extract_bracket_data(html)
    slug_lookup = build_slug_lookup(bracket_data)
    participants, roster_summary = build_participants(args.workbook, slug_lookup)
    teams = build_team_entries(bracket_data)
    games = build_games(bracket_data)

    payload = {
        "meta": {
            "title": "Marshall NCAA Tournament Simulator",
            "season": 2026,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "boxscorusSource": {
                "url": BOXSCORUS_URL,
                "loadedFrom": html_source,
                "note": "Bracket snapshot and team ratings extracted from the Boxscorus __NEXT_DATA__ payload.",
            },
            "simulation": {
                "defaultRuns": 10000,
                "eloScale": 320,
                "modelNote": "Round-of-64 uses Boxscorus published probabilities when directly available; all other open games use a Boxscorus Elo-based win curve.",
            },
            "pool": {
                "entryCount": roster_summary["entryCount"],
                "selectedTeamSlots": roster_summary["selectedTeamSlots"],
                "budget": 100,
                "seedCosts": SEED_COSTS,
                "scoring": {key: meta["points"] for key, meta in ROUND_META.items()},
                "rulesSummary": [
                    "Each entry has a mythical $100 budget to buy teams by seed cost.",
                    "Points come from wins after the field is set: 1, 2, 3, 4, 5, and 6 by round.",
                    "First Four games do not score in the pool.",
                    "The simulator tracks first-place ties separately from outright winners and also identifies second place by the next distinct score.",
                ],
            },
            "rosterWorkbook": str(args.workbook),
        },
        "teams": teams,
        "participants": participants,
        "games": games,
    }
    return payload


def write_outputs(payload: dict[str, Any], json_output: Path, js_output: Path) -> None:
    json_output.parent.mkdir(parents=True, exist_ok=True)
    json_output.write_text(json.dumps(payload, indent=2))
    js_output.write_text(
        "window.MARSHALL_SIM_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n"
    )


def main() -> None:
    args = parse_args()
    payload = build_payload(args)
    write_outputs(payload, args.json_output, args.js_output)
    print(f"Wrote {args.json_output}")
    print(f"Wrote {args.js_output}")


if __name__ == "__main__":
    main()
