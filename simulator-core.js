(function (globalScope) {
  "use strict";

  function buildSeededRng(seed) {
    let state = seed >>> 0;
    if (!state) {
      state = 0x6d2b79f5;
    }

    return function nextRandom() {
      state += 0x6d2b79f5;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function compileData(data) {
    const teamIndexBySlug = new Map();
    const teamNameBySlug = new Map();
    const teams = data.teams.map(function mapTeam(team, index) {
      const compiledTeam = Object.assign({ index: index }, team);
      teamIndexBySlug.set(team.slug, index);
      teamNameBySlug.set(team.slug, team.name);
      return compiledTeam;
    });

    const participants = data.participants.map(function mapParticipant(participant, index) {
      return Object.assign({ index: index }, participant, {
        teamIndices: participant.teams.map(function toIndex(slug) {
          return teamIndexBySlug.get(slug);
        }),
      });
    });

    const gamesById = new Map();
    const games = data.games.map(function mapGame(game, index) {
      const compiledGame = Object.assign({ index: index }, game);
      gamesById.set(game.id, compiledGame);
      return compiledGame;
    });

    const possibleWinnerSlugsByGameId = new Map();

    function collectPossibleTeamsForSlot(slot) {
      if (slot.type === "team") {
        return [slot.team];
      }
      return collectPossibleTeamsForGame(slot.gameId);
    }

    function collectPossibleTeamsForGame(gameId) {
      if (possibleWinnerSlugsByGameId.has(gameId)) {
        return possibleWinnerSlugsByGameId.get(gameId);
      }

      const game = gamesById.get(gameId);
      const uniqueTeams = [];
      const seen = new Set();
      [game.slotA, game.slotB].forEach(function eachSlot(slot) {
        collectPossibleTeamsForSlot(slot).forEach(function eachTeam(teamSlug) {
          if (!seen.has(teamSlug)) {
            seen.add(teamSlug);
            uniqueTeams.push(teamSlug);
          }
        });
      });

      uniqueTeams.sort(function byName(teamA, teamB) {
        return teamNameBySlug.get(teamA).localeCompare(teamNameBySlug.get(teamB));
      });
      possibleWinnerSlugsByGameId.set(gameId, uniqueTeams);
      return uniqueTeams;
    }

    games.forEach(function eachGame(game) {
      game.possibleWinnerSlugs = collectPossibleTeamsForGame(game.id);
      game.possibleWinnerSet = new Set(game.possibleWinnerSlugs);
    });

    return {
      data: data,
      teams: teams,
      participants: participants,
      games: games,
      gamesById: gamesById,
      teamIndexBySlug: teamIndexBySlug,
      teamNameBySlug: teamNameBySlug,
      possibleWinnerSlugsByGameId: possibleWinnerSlugsByGameId,
      defaultModel: String((data.meta && data.meta.simulation && data.meta.simulation.defaultModel) || "boxscorus"),
      availableModels: Object.keys((data.meta && data.meta.simulation && data.meta.simulation.models) || { boxscorus: {} }),
      eloScale: Number(data.meta.simulation.eloScale || 320),
      kenpomNationalAverage: Number(data.meta.simulation.kenpomNationalAverage || 100.5),
      defaultRuns: Number(data.meta.simulation.defaultRuns || 10000),
    };
  }

  function defaultLockedResults(compiled) {
    const lockedResults = {};
    compiled.games.forEach(function eachGame(game) {
      if (game.sourceResult && game.sourceResult.winner) {
        lockedResults[game.id] = game.sourceResult.winner;
      }
    });
    return lockedResults;
  }

  function resolveSlot(slot, winnersByGameId) {
    if (slot.type === "team") {
      return slot.team;
    }
    return winnersByGameId[slot.gameId] || null;
  }

  function slotCanProduceTeam(compiled, slot, teamSlug) {
    if (slot.type === "team") {
      return slot.team === teamSlug;
    }

    const childGame = compiled.gamesById.get(slot.gameId);
    return childGame.possibleWinnerSet.has(teamSlug);
  }

  function getPossibleTeamsForSlot(compiled, slot) {
    if (slot.type === "team") {
      return [slot.team];
    }
    return compiled.gamesById.get(slot.gameId).possibleWinnerSlugs.slice();
  }

  function parseLockedSelection(selectionValue) {
    if (!selectionValue || typeof selectionValue !== "string") {
      return null;
    }
    if (selectionValue === "slot:A" || selectionValue === "slot:B") {
      return {
        kind: "slot",
        slotKey: selectionValue.slice(5),
      };
    }
    return {
      kind: "team",
      teamSlug: selectionValue,
    };
  }

  function getSlotByKey(game, slotKey) {
    if (slotKey === "A") {
      return game.slotA;
    }
    if (slotKey === "B") {
      return game.slotB;
    }
    return null;
  }

  function selectionContainsTeam(compiled, game, selectionValue, teamSlug) {
    const parsed = parseLockedSelection(selectionValue);
    if (!parsed) {
      return false;
    }
    if (parsed.kind === "team") {
      return parsed.teamSlug === teamSlug;
    }
    return slotCanProduceTeam(compiled, getSlotByKey(game, parsed.slotKey), teamSlug);
  }

  function selectionsAreCompatible(compiled, game, existingSelection, requestedSelection) {
    const existingParsed = parseLockedSelection(existingSelection);
    const requestedParsed = parseLockedSelection(requestedSelection);
    if (!existingParsed || !requestedParsed) {
      return false;
    }

    if (existingParsed.kind === "team" && requestedParsed.kind === "team") {
      return existingParsed.teamSlug === requestedParsed.teamSlug;
    }
    if (existingParsed.kind === "slot" && requestedParsed.kind === "slot") {
      return existingParsed.slotKey === requestedParsed.slotKey;
    }
    if (existingParsed.kind === "team") {
      return selectionContainsTeam(compiled, game, requestedSelection, existingParsed.teamSlug);
    }
    return selectionContainsTeam(compiled, game, existingSelection, requestedParsed.teamSlug);
  }

  function applyRequestedTeam(compiled, effectiveLockedResults, gameId, winnerSlug) {
    const game = compiled.gamesById.get(gameId);
    if (!game || !game.possibleWinnerSet.has(winnerSlug)) {
      return false;
    }

    const existingSelection = effectiveLockedResults[gameId];
    if (existingSelection && !selectionsAreCompatible(compiled, game, existingSelection, winnerSlug)) {
      return false;
    }

    let winningSlot = null;
    if (slotCanProduceTeam(compiled, game.slotA, winnerSlug)) {
      winningSlot = game.slotA;
    } else if (slotCanProduceTeam(compiled, game.slotB, winnerSlug)) {
      winningSlot = game.slotB;
    } else {
      return false;
    }

    if (winningSlot.type === "game" &&
        !applyRequestedTeam(compiled, effectiveLockedResults, winningSlot.gameId, winnerSlug)) {
      return false;
    }

    if (!existingSelection) {
      effectiveLockedResults[gameId] = winnerSlug;
    }
    return true;
  }

  function applyRequestedSlot(compiled, effectiveLockedResults, gameId, slotKey) {
    const game = compiled.gamesById.get(gameId);
    const slot = game ? getSlotByKey(game, slotKey) : null;
    const selectionValue = "slot:" + slotKey;
    if (!game || !slot) {
      return false;
    }

    const existingSelection = effectiveLockedResults[gameId];
    if (existingSelection && !selectionsAreCompatible(compiled, game, existingSelection, selectionValue)) {
      return false;
    }

    if (!existingSelection) {
      effectiveLockedResults[gameId] = selectionValue;
    }
    return true;
  }

  function applyRequestedSelection(compiled, effectiveLockedResults, gameId, selectionValue) {
    const parsed = parseLockedSelection(selectionValue);
    if (!parsed) {
      return false;
    }
    if (parsed.kind === "slot") {
      return applyRequestedSlot(compiled, effectiveLockedResults, gameId, parsed.slotKey);
    }
    return applyRequestedTeam(compiled, effectiveLockedResults, gameId, parsed.teamSlug);
  }

  function resolveSelectionWinner(compiled, game, selectionValue, winnersByGameId) {
    const parsed = parseLockedSelection(selectionValue);
    if (!parsed) {
      return null;
    }
    if (parsed.kind === "team") {
      return parsed.teamSlug;
    }
    return resolveSlot(getSlotByKey(game, parsed.slotKey), winnersByGameId);
  }

  function normalizeModelKey(compiled, modelKey) {
    const normalized = String(modelKey || compiled.defaultModel || "boxscorus");
    if (compiled.availableModels.indexOf(normalized) >= 0) {
      return normalized;
    }
    return compiled.defaultModel || "boxscorus";
  }

  function getTeamRatings(compiled, teamSlug, modelKey) {
    const teamInfo = compiled.teams[compiled.teamIndexBySlug.get(teamSlug)];
    if (!teamInfo) {
      return null;
    }
    const normalizedModelKey = normalizeModelKey(compiled, modelKey);
    if (teamInfo.ratings && teamInfo.ratings[normalizedModelKey]) {
      return teamInfo.ratings[normalizedModelKey];
    }
    return teamInfo;
  }

  function clampNumber(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(maxValue, value));
  }

  function sampleNormal(rng, mean, standardDeviation) {
    if (!standardDeviation) {
      return mean;
    }
    let u = 0;
    let v = 0;
    while (!u) { u = rng(); }
    while (!v) { v = rng(); }
    const magnitude = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    return mean + (standardDeviation * magnitude * Math.cos(angle));
  }

  function sampleTeamPoints(rng, possessions, offensiveRating) {
    const meanPoints = possessions * offensiveRating / 100;
    const standardDeviation = Math.max(4, Math.sqrt(possessions) * 1.45);
    return Math.max(40, Math.round(sampleNormal(rng, meanPoints, standardDeviation)));
  }

  function simulateKenPomGame(compiled, teamA, teamB, rng) {
    const ratingsA = getTeamRatings(compiled, teamA, "kenpom");
    const ratingsB = getTeamRatings(compiled, teamB, "kenpom");
    const averageEfficiency = compiled.kenpomNationalAverage || 100.5;
    const tempoMean = clampNumber((ratingsA.adjT + ratingsB.adjT) / 2, 58, 78);
    const possessions = clampNumber(Math.round(sampleNormal(rng, tempoMean, 3.6)), 54, 84);
    const offensiveRatingA = clampNumber((ratingsA.adjO * ratingsB.adjD) / averageEfficiency, 84, 132);
    const offensiveRatingB = clampNumber((ratingsB.adjO * ratingsA.adjD) / averageEfficiency, 84, 132);
    let scoreA = sampleTeamPoints(rng, possessions, offensiveRatingA);
    let scoreB = sampleTeamPoints(rng, possessions, offensiveRatingB);

    let overtimeCount = 0;
    while (scoreA === scoreB && overtimeCount < 6) {
      const overtimePossessions = clampNumber(Math.round(tempoMean / 8), 6, 12);
      scoreA += Math.max(2, Math.round(sampleNormal(rng, overtimePossessions * offensiveRatingA / 100, 2.4)));
      scoreB += Math.max(2, Math.round(sampleNormal(rng, overtimePossessions * offensiveRatingB / 100, 2.4)));
      overtimeCount += 1;
    }

    if (scoreA === scoreB) {
      if (rng() < 0.5) {
        scoreA += 1;
      } else {
        scoreB += 1;
      }
    }

    return {
      winner: scoreA > scoreB ? teamA : teamB,
      teamAScore: scoreA,
      teamBScore: scoreB,
      overtimeCount: overtimeCount,
    };
  }

  function simulateGameOutcome(compiled, game, teamA, teamB, rng, modelKey, lockedWinner) {
    if (lockedWinner) {
      return {
        winner: lockedWinner,
        teamAScore: null,
        teamBScore: null,
        overtimeCount: 0,
      };
    }

    const normalizedModelKey = normalizeModelKey(compiled, modelKey);
    if (normalizedModelKey === "kenpom") {
      return simulateKenPomGame(compiled, teamA, teamB, rng);
    }

    const probabilityA = getGameProbability(compiled, game, teamA, teamB, normalizedModelKey);
    return {
      winner: rng() < probabilityA ? teamA : teamB,
      teamAScore: null,
      teamBScore: null,
      overtimeCount: 0,
    };
  }

  function getGameProbability(compiled, game, teamA, teamB, modelKey) {
    const normalizedModelKey = normalizeModelKey(compiled, modelKey);
    if (normalizedModelKey === "boxscorus" && game.publishedProbability) {
      const published = game.publishedProbability;
      if (published.teamA === teamA && published.teamB === teamB) {
        return published.probabilityA;
      }
      if (published.teamA === teamB && published.teamB === teamA) {
        return 1 - published.probabilityA;
      }
    }

    if (normalizedModelKey === "kenpom") {
      const teamInfoA = getTeamRatings(compiled, teamA, "kenpom");
      const teamInfoB = getTeamRatings(compiled, teamB, "kenpom");
      return 1 / (1 + Math.exp(-((teamInfoA.adjEm - teamInfoB.adjEm) / 9.5)));
    }

    const teamInfoA = getTeamRatings(compiled, teamA, "boxscorus");
    const teamInfoB = getTeamRatings(compiled, teamB, "boxscorus");
    return 1 / (1 + Math.pow(10, (teamInfoB.elo - teamInfoA.elo) / compiled.eloScale));
  }

  function buildSelectionState(compiled, rawLockedResults) {
    let effectiveLockedResults = {};
    const acceptedEntriesReversed = [];
    const requestedEntries = Object.entries(Object.assign({}, rawLockedResults || {}))
      .filter(function onlyValidEntries(entry) {
        const game = compiled.gamesById.get(entry[0]);
        const parsed = parseLockedSelection(entry[1]);
        if (!game || !parsed) {
          return false;
        }
        if (parsed.kind === "slot") {
          return Boolean(getSlotByKey(game, parsed.slotKey));
        }
        return game.possibleWinnerSet.has(parsed.teamSlug);
      })
      .reverse();

    requestedEntries.forEach(function eachEntry(entry) {
      const gameId = entry[0];
      const selectionValue = entry[1];
      const candidateLockedResults = Object.assign({}, effectiveLockedResults);
      if (applyRequestedSelection(compiled, candidateLockedResults, gameId, selectionValue)) {
        effectiveLockedResults = candidateLockedResults;
        acceptedEntriesReversed.push([gameId, selectionValue]);
      }
    });

    const acceptedRequestedSelections = {};
    acceptedEntriesReversed.reverse().forEach(function eachAcceptedEntry(entry) {
      acceptedRequestedSelections[entry[0]] = entry[1];
    });

    return {
      acceptedRequestedSelections: acceptedRequestedSelections,
      effectiveLockedResults: effectiveLockedResults,
    };
  }

  function normalizeRequestedSelections(compiled, rawLockedResults) {
    return buildSelectionState(compiled, rawLockedResults).acceptedRequestedSelections;
  }

  function sanitizeLockedResults(compiled, rawLockedResults) {
    return buildSelectionState(compiled, rawLockedResults).effectiveLockedResults;
  }

  function getGameStates(compiled, lockedResults) {
    const selectionState = buildSelectionState(compiled, lockedResults);
    const cleanLockedResults = selectionState.effectiveLockedResults;
    const winnersByGameId = {};
    const requested = selectionState.acceptedRequestedSelections;

    return compiled.games.map(function mapGame(game) {
      const teamA = resolveSlot(game.slotA, winnersByGameId);
      const teamB = resolveSlot(game.slotB, winnersByGameId);
      const effectiveSelection = cleanLockedResults[game.id] || null;
      const lockedWinner = resolveSelectionWinner(compiled, game, effectiveSelection, winnersByGameId);
      if (lockedWinner) {
        winnersByGameId[game.id] = lockedWinner;
      }

      return {
        id: game.id,
        title: game.title,
        roundKey: game.roundKey,
        roundLabel: game.roundLabel,
        roundOrder: game.roundOrder,
        region: game.region,
        regionLabel: game.regionLabel,
        points: game.points,
        teamA: teamA,
        teamB: teamB,
        requestedSelection: requested[game.id] || null,
        effectiveSelection: effectiveSelection,
        lockedWinner: lockedWinner,
        possibleWinnerSlugs: game.possibleWinnerSlugs.slice(),
        sourceResult: game.sourceResult,
        slotA: game.slotA,
        slotB: game.slotB,
      };
    });
  }

  function computeLockedScoreboard(compiled, lockedResults) {
    const cleanLockedResults = sanitizeLockedResults(compiled, lockedResults);
    const winnersByGameId = {};
    const teamPoints = new Uint16Array(compiled.teams.length);
    const eliminated = new Uint8Array(compiled.teams.length);

    compiled.games.forEach(function eachGame(game) {
      const teamA = resolveSlot(game.slotA, winnersByGameId);
      const teamB = resolveSlot(game.slotB, winnersByGameId);
      const winner = resolveSelectionWinner(compiled, game, cleanLockedResults[game.id], winnersByGameId);
      if (!winner || !teamA || !teamB) {
        return;
      }
      winnersByGameId[game.id] = winner;
      const loser = winner === teamA ? teamB : teamA;
      if (loser) {
        eliminated[compiled.teamIndexBySlug.get(loser)] = 1;
      }
      if (game.points > 0) {
        teamPoints[compiled.teamIndexBySlug.get(winner)] += game.points;
      }
    });

    const scores = new Uint16Array(compiled.participants.length);
    compiled.participants.forEach(function eachParticipant(participant) {
      let score = 0;
      participant.teamIndices.forEach(function eachIndex(teamIndex) {
        score += teamPoints[teamIndex];
      });
      scores[participant.index] = score;
    });

    const standings = compiled.participants.map(function toStanding(participant) {
      let teamsRemaining = 0;
      let dollarsLeft = 0;
      participant.teamIndices.forEach(function eachIndex(teamIndex) {
        if (!eliminated[teamIndex]) {
          teamsRemaining += 1;
          dollarsLeft += Number(compiled.data.meta.pool.seedCosts[compiled.teams[teamIndex].seed] || 0);
        }
      });

      return {
        id: participant.id,
        name: participant.name,
        currentPoints: scores[participant.index],
        teamCount: participant.teamCount,
        teamsRemaining: teamsRemaining,
        dollarsLeft: dollarsLeft,
      };
    });

    standings.sort(function byScore(a, b) {
      if (b.currentPoints !== a.currentPoints) {
        return b.currentPoints - a.currentPoints;
      }
      return a.name.localeCompare(b.name);
    });

    return standings;
  }

  function getSlotLabel(compiled, slot) {
    if (slot.type === "team") {
      return compiled.teamNameBySlug.get(slot.team) || slot.team;
    }
    const game = compiled.gamesById.get(slot.gameId);
    return "Winner of " + game.title;
  }

  function getSelectionLabel(compiled, game, selectionValue) {
    const parsed = parseLockedSelection(selectionValue);
    if (!parsed) {
      return "";
    }
    if (parsed.kind === "team") {
      return compiled.teamNameBySlug.get(parsed.teamSlug) || parsed.teamSlug;
    }
    return getSlotLabel(compiled, getSlotByKey(game, parsed.slotKey));
  }

  function runSimulations(compiled, options) {
    const totalRuns = Math.max(1, Number(options && options.simulations) || compiled.defaultRuns);
    const seed = Number(options && options.seed) >>> 0;
    const rng = buildSeededRng(seed || Date.now());
    const lockedResults = sanitizeLockedResults(compiled, options && options.lockedResults);
    const modelKey = normalizeModelKey(compiled, options && options.modelKey);
    const firstPrize = 9600;
    const secondPrize = 3200;

    const participantCount = compiled.participants.length;
    const scoreTotals = new Float64Array(participantCount);
    const valueTotals = new Float64Array(participantCount);
    const winCounts = new Uint32Array(participantCount);
    const outrightWinCounts = new Uint32Array(participantCount);
    const tiedWinCounts = new Uint32Array(participantCount);
    const secondCounts = new Uint32Array(participantCount);
    const outrightSecondCounts = new Uint32Array(participantCount);
    const tiedSecondCounts = new Uint32Array(participantCount);
    const minScores = new Uint16Array(participantCount);
    const maxScores = new Uint16Array(participantCount);
    const scoreMatrix = new Uint16Array(totalRuns * participantCount);
    const simulationOutcomes = [];
    const championCounts = new Uint32Array(compiled.teams.length);
    const currentStandings = computeLockedScoreboard(compiled, lockedResults);

    let simulationsWithTieForFirst = 0;
    let simulationsWithTieForSecond = 0;

    for (let participantIndex = 0; participantIndex < participantCount; participantIndex += 1) {
      minScores[participantIndex] = 65535;
      maxScores[participantIndex] = 0;
    }

    const gameWinCounts = {};
    compiled.games.forEach(function initGameCount(game) {
      gameWinCounts[game.id] = {};
    });

    for (let runIndex = 0; runIndex < totalRuns; runIndex += 1) {
      const winnersByGameId = {};
      const teamPoints = new Uint16Array(compiled.teams.length);

      compiled.games.forEach(function eachGame(game) {
        const teamA = resolveSlot(game.slotA, winnersByGameId);
        const teamB = resolveSlot(game.slotB, winnersByGameId);
        if (!teamA || !teamB) {
          return;
        }

        const lockedWinner = resolveSelectionWinner(compiled, game, lockedResults[game.id], winnersByGameId);
        const outcome = simulateGameOutcome(compiled, game, teamA, teamB, rng, modelKey, lockedWinner);
        const winner = outcome.winner;

        winnersByGameId[game.id] = winner;
        gameWinCounts[game.id][winner] = (gameWinCounts[game.id][winner] || 0) + 1;
        if (game.points > 0) {
          teamPoints[compiled.teamIndexBySlug.get(winner)] += game.points;
        }
      });

      const scores = new Uint16Array(participantCount);
      let topScore = -1;
      let secondScore = -1;

      compiled.participants.forEach(function eachParticipant(participant) {
        let score = 0;
        participant.teamIndices.forEach(function eachTeamIndex(teamIndex) {
          score += teamPoints[teamIndex];
        });

        scores[participant.index] = score;
        scoreMatrix[(runIndex * participantCount) + participant.index] = score;
        scoreTotals[participant.index] += score;
        if (score < minScores[participant.index]) {
          minScores[participant.index] = score;
        }
        if (score > maxScores[participant.index]) {
          maxScores[participant.index] = score;
        }

        if (score > topScore) {
          secondScore = topScore;
          topScore = score;
        } else if (score < topScore && score > secondScore) {
          secondScore = score;
        }
      });

      const winners = [];
      const secondPlace = [];
      for (let participantIndex = 0; participantIndex < participantCount; participantIndex += 1) {
        const score = scores[participantIndex];
        if (score === topScore) {
          winners.push(participantIndex);
        } else if (secondScore >= 0 && score === secondScore) {
          secondPlace.push(participantIndex);
        }
      }

      winners.forEach(function eachWinner(index) {
        winCounts[index] += 1;
      });
      if (winners.length === 1) {
        outrightWinCounts[winners[0]] += 1;
        valueTotals[winners[0]] += firstPrize;
      } else if (winners.length > 1) {
        simulationsWithTieForFirst += 1;
        const splitFirstPrize = (firstPrize + secondPrize) / winners.length;
        winners.forEach(function eachTiedWinner(index) {
          tiedWinCounts[index] += 1;
          valueTotals[index] += splitFirstPrize;
        });
      }

      secondPlace.forEach(function eachSecond(index) {
        secondCounts[index] += 1;
      });
      if (winners.length === 1) {
        if (secondPlace.length === 1) {
          outrightSecondCounts[secondPlace[0]] += 1;
          valueTotals[secondPlace[0]] += secondPrize;
        } else if (secondPlace.length > 1) {
          simulationsWithTieForSecond += 1;
          const splitSecondPrize = secondPrize / secondPlace.length;
          secondPlace.forEach(function eachTiedSecond(index) {
            tiedSecondCounts[index] += 1;
            valueTotals[index] += splitSecondPrize;
          });
        }
      } else if (secondPlace.length > 1) {
        simulationsWithTieForSecond += 1;
        secondPlace.forEach(function eachTiedSecond(index) {
          tiedSecondCounts[index] += 1;
        });
      }

      const championSlug = winnersByGameId["championship-0"];
      if (championSlug) {
        championCounts[compiled.teamIndexBySlug.get(championSlug)] += 1;
      }

      simulationOutcomes.push({
        simulation: runIndex + 1,
        topScore: topScore,
        secondScore: secondScore,
        winners: winners.slice(),
        secondPlace: secondPlace.slice(),
      });
    }

    const participants = compiled.participants.map(function toSummary(participant) {
      const currentRow = currentStandings.find(function findStanding(row) {
        return row.id === participant.id;
      });
      return {
        id: participant.id,
        name: participant.name,
        teamCount: participant.teamCount,
        currentPoints: currentRow ? currentRow.currentPoints : 0,
        averageScore: scoreTotals[participant.index] / totalRuns,
        expectedValue: valueTotals[participant.index] / totalRuns,
        minScore: minScores[participant.index] === 65535 ? 0 : minScores[participant.index],
        maxScore: maxScores[participant.index],
        winRate: winCounts[participant.index] / totalRuns,
        outrightWinRate: outrightWinCounts[participant.index] / totalRuns,
        tiedWinRate: tiedWinCounts[participant.index] / totalRuns,
        secondRate: secondCounts[participant.index] / totalRuns,
        outrightSecondRate: outrightSecondCounts[participant.index] / totalRuns,
        tiedSecondRate: tiedSecondCounts[participant.index] / totalRuns,
        topTwoRate: (winCounts[participant.index] + secondCounts[participant.index]) / totalRuns,
      };
    });

    participants.sort(function byProjection(a, b) {
      if (b.expectedValue !== a.expectedValue) {
        return b.expectedValue - a.expectedValue;
      }
      if (b.winRate !== a.winRate) {
        return b.winRate - a.winRate;
      }
      if (b.topTwoRate !== a.topTwoRate) {
        return b.topTwoRate - a.topTwoRate;
      }
      if (b.averageScore !== a.averageScore) {
        return b.averageScore - a.averageScore;
      }
      return a.name.localeCompare(b.name);
    });

    const champions = compiled.teams.map(function toChampionSummary(team) {
      return {
        slug: team.slug,
        name: team.name,
        championRate: championCounts[team.index] / totalRuns,
      };
    }).filter(function onlyPositive(team) {
      return team.championRate > 0;
    }).sort(function byRate(a, b) {
      return b.championRate - a.championRate;
    });

    const gameProbabilities = {};
    compiled.games.forEach(function computeProb(game) {
      const counts = gameWinCounts[game.id];
      const probs = {};
      Object.keys(counts).forEach(function eachSlug(slug) {
        probs[slug] = counts[slug] / totalRuns;
      });
      gameProbabilities[game.id] = probs;
    });

    return {
      modelKey: modelKey,
      seed: seed || 0,
      simulations: totalRuns,
      lockedResults: lockedResults,
      currentStandings: currentStandings,
      participants: participants,
      champions: champions,
      scoreMatrix: scoreMatrix,
      simulationOutcomes: simulationOutcomes,
      simulationsWithTieForFirst: simulationsWithTieForFirst,
      simulationsWithTieForSecond: simulationsWithTieForSecond,
      gameProbabilities: gameProbabilities,
    };
  }

  function runOneBracket(compiled, options) {
    const seed = Number(options && options.seed) >>> 0;
    const rng = buildSeededRng(seed || Date.now());
    const lockedResults = sanitizeLockedResults(compiled, options && options.lockedResults);
    const modelKey = normalizeModelKey(compiled, options && options.modelKey);
    const participantCount = compiled.participants.length;

    const winnersByGameId = {};
    const gameScoresById = {};
    const teamPoints = new Uint16Array(compiled.teams.length);

    compiled.games.forEach(function eachGame(game) {
      const teamA = resolveSlot(game.slotA, winnersByGameId);
      const teamB = resolveSlot(game.slotB, winnersByGameId);
      if (!teamA || !teamB) {
        return;
      }
      const lockedWinner = resolveSelectionWinner(compiled, game, lockedResults[game.id], winnersByGameId);
      const outcome = simulateGameOutcome(compiled, game, teamA, teamB, rng, modelKey, lockedWinner);
      const winner = outcome.winner;
      winnersByGameId[game.id] = winner;
      if (outcome.teamAScore !== null && outcome.teamBScore !== null) {
        gameScoresById[game.id] = {
          teamAScore: outcome.teamAScore,
          teamBScore: outcome.teamBScore,
          overtimeCount: outcome.overtimeCount,
          modelKey: modelKey,
        };
      } else if (game.sourceResult && game.sourceResult.scoreA !== undefined && game.sourceResult.scoreB !== undefined) {
        gameScoresById[game.id] = {
          teamAScore: Number(game.sourceResult.scoreA),
          teamBScore: Number(game.sourceResult.scoreB),
          overtimeCount: 0,
          modelKey: "actual",
        };
      }
      if (game.points > 0) {
        teamPoints[compiled.teamIndexBySlug.get(winner)] += game.points;
      }
    });

    const scores = new Uint16Array(participantCount);
    let topScore = -1;
    let secondScore = -1;

    compiled.participants.forEach(function eachParticipant(participant) {
      let score = 0;
      participant.teamIndices.forEach(function eachTeamIndex(teamIndex) {
        score += teamPoints[teamIndex];
      });
      scores[participant.index] = score;
      if (score > topScore) {
        secondScore = topScore;
        topScore = score;
      } else if (score < topScore && score > secondScore) {
        secondScore = score;
      }
    });

    const poolWinnerIndices = [];
    const secondPlaceIndices = [];
    for (let i = 0; i < participantCount; i += 1) {
      if (scores[i] === topScore) {
        poolWinnerIndices.push(i);
      } else if (secondScore >= 0 && scores[i] === secondScore) {
        secondPlaceIndices.push(i);
      }
    }

    return {
      modelKey: modelKey,
      winnersByGameId: winnersByGameId,
      gameScoresById: gameScoresById,
      poolWinnerIndices: poolWinnerIndices,
      topScore: topScore,
      secondScore: secondScore,
      secondPlaceIndices: secondPlaceIndices,
    };
  }

  const api = {
    compileData: compileData,
    defaultLockedResults: defaultLockedResults,
    normalizeRequestedSelections: normalizeRequestedSelections,
    sanitizeLockedResults: sanitizeLockedResults,
    getGameStates: getGameStates,
    getPossibleTeamsForSlot: getPossibleTeamsForSlot,
    getSlotLabel: getSlotLabel,
    getSelectionLabel: getSelectionLabel,
    computeLockedScoreboard: computeLockedScoreboard,
    runSimulations: runSimulations,
    runOneBracket: runOneBracket,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.MarshallSimCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
