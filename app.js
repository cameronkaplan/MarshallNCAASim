(function () {
  "use strict";

  const data = window.MARSHALL_SIM_DATA;
  const core = window.MarshallSimCore;
  const compiled = core.compileData(data);
  const runtimeOptions = readRuntimeOptions();
  const blankScenario = runtimeOptions.blankScenario;

  const STORAGE_PREFIX = "marshall-sim-2026";
  const LOCKED_RESULTS_KEY = STORAGE_PREFIX + "-locked-results";
  const MANUAL_OVERRIDES_KEY = STORAGE_PREFIX + "-manual-overrides";
  const LIVE_RESULTS_KEY   = STORAGE_PREFIX + "-live-results";
  const SETTINGS_KEY       = STORAGE_PREFIX + "-settings";
  const loadedSettings = loadSettings();

  const state = {
    lockedResults: loadLockedResults(),
    liveResults:   loadLiveResults(),
    seed: loadedSettings.seed || Math.floor(Date.now() % 1000000000),
    simulations: normalizeSimulationCount(loadedSettings.simulations),
    modelKey: normalizeModelKey(loadedSettings.modelKey || loadedSettings.model),
    results: null,
    sampleWinners: null,
    sampleGameScores: null,
    activeTab: "bracket",
    dirty: false,
  };

  const numberFormat   = new Intl.NumberFormat("en-US");
  const percentFormat  = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const scoreFormat    = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const currencyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const els = {
    seed:               document.querySelector("#simulation-seed"),
    simulationCount:    document.querySelector("#simulation-count"),
    modelSelect:        document.querySelector("#model-select"),
    simulateOnce:       document.querySelector("#simulate-once"),
    runButton:          document.querySelector("#run-simulations"),
    randomizeSeed:      document.querySelector("#randomize-seed"),
    resetButton:        document.querySelector("#reset-results"),
    exportSummaryButton:document.querySelector("#export-summary"),
    exportScoresButton: document.querySelector("#export-scores"),
    winnerBanner:       document.querySelector("#winner-banner"),
    winnerBannerText:   document.querySelector("#winner-banner-text"),
    statusBar:          document.querySelector("#status-bar"),
    scenarioIndicator:  document.querySelector("#scenario-indicator"),
    bracketHost:        document.querySelector("#bracket-host"),
    statsBar:           document.querySelector("#stats-bar"),
    leadersBody:        document.querySelector("#leaders-body"),
    leadersNote:        document.querySelector("#leaders-note"),
    leaderboardBody:    document.querySelector("#leaderboard-body"),
    footerRules:        document.querySelector("#footer-rules"),
    footerMeta:         document.querySelector("#footer-meta"),
  };

  // Bracket layout constants — must be declared before init() calls renderBracket
  const LEFT_ROUNDS = ["r64", "r32", "s16", "e8"];
  const ROUND_LABELS = { r64: "R64", r32: "R32", s16: "S16", e8: "E8" };
  const ROUND_COUNTS = { r64: 8, r32: 4, s16: 2, e8: 1 };

  // Build name→slug lookup for ESPN matching (once at startup)
  const espnNameMap = buildEspnNameMap();

  // Build reverse lookup: slug → Set<gameId> for ESPN pair matching
  const slugToGameIds = buildSlugToGameIds();

  init();

  // ─── Initialisation ──────────────────────────────────────────

  function init() {
    els.seed.value = state.seed;
    els.simulationCount.value = state.simulations;
    els.modelSelect.value = state.modelKey;
    updateRunButtonLabel();
    if (blankScenario && els.scenarioIndicator) {
      els.scenarioIndicator.hidden = false;
    }
    renderFooter();
    wireControls();
    renderBracket(null, null);
    if (blankScenario) {
      renderStatusBar("Blank scenario mode. Starting from an empty bracket.");
      window.setTimeout(runSimulations, 0);
      return;
    }
    renderStatusBar("Ready. Click Simulate for one outcome, or run projections.");
    // Auto sync live results, then run sims
    syncLive(false, true).then(function () {
      window.setTimeout(runSimulations, 0);
    });
    // Re-sync silently every 3 minutes
    window.setInterval(function () { syncLive(true); }, 3 * 60 * 1000);
  }

  // ─── Persistence ─────────────────────────────────────────────

  function loadLockedResults() {
    if (blankScenario) {
      return {};
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(LOCKED_RESULTS_KEY) || "null");
      if (parsed && typeof parsed === "object") {
        return core.normalizeRequestedSelections(compiled, parsed);
      }
    } catch (e) { console.warn("Could not parse locked results.", e); }

    try {
      const parsedManual = JSON.parse(window.localStorage.getItem(MANUAL_OVERRIDES_KEY) || "null");
      if (parsedManual && typeof parsedManual === "object") {
        const fallback = core.normalizeRequestedSelections(
          compiled,
          Object.assign({}, loadLiveResults(), parsedManual)
        );
        window.localStorage.setItem(LOCKED_RESULTS_KEY, JSON.stringify(fallback));
        return fallback;
      }
    } catch (e2) {
      console.warn("Could not parse manual overrides fallback.", e2);
    }

    return core.normalizeRequestedSelections(compiled, core.defaultLockedResults(compiled));
  }

  function loadLiveResults() {
    if (blankScenario) {
      return {};
    }
    try {
      const raw = window.localStorage.getItem(LIVE_RESULTS_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") { return parsed; }
      }
    } catch (e) {}
    // Key never written: seed with snapshot games from the data as baseline
    return core.defaultLockedResults(compiled);
  }

  function loadSettings() {
    if (blankScenario) {
      return {};
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null");
      if (parsed && typeof parsed === "object") { return parsed; }
    } catch (e) {}
    return {};
  }

  function saveLockedResults() {
    if (blankScenario) { return; }
    window.localStorage.setItem(LOCKED_RESULTS_KEY, JSON.stringify(state.lockedResults));
  }

  function saveLiveResults() {
    if (blankScenario) { return; }
    window.localStorage.setItem(LIVE_RESULTS_KEY, JSON.stringify(state.liveResults));
  }

  function saveSettings() {
    if (blankScenario) { return; }
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      seed: state.seed,
      simulations: state.simulations,
      modelKey: state.modelKey,
    }));
  }

  function getBaselineLockedResults() {
    if (blankScenario) {
      return {};
    }
    return core.normalizeRequestedSelections(
      compiled,
      Object.assign({}, core.defaultLockedResults(compiled), state.liveResults)
    );
  }

  function getAvailableModels() {
    const configured = (data.meta && data.meta.simulation && data.meta.simulation.models) || {};
    const keys = Object.keys(configured);
    if (keys.length) {
      return keys;
    }
    return ["boxscorus"];
  }

  function normalizeModelKey(value) {
    const availableModels = getAvailableModels();
    const candidate = String(value || (data.meta && data.meta.simulation && data.meta.simulation.defaultModel) || "boxscorus");
    return availableModels.indexOf(candidate) >= 0 ? candidate : availableModels[0];
  }

  function getModelMeta(modelKey) {
    const models = (data.meta && data.meta.simulation && data.meta.simulation.models) || {};
    return models[normalizeModelKey(modelKey)] || {};
  }

  function getModelLabel(modelKey) {
    return getModelMeta(modelKey).label || normalizeModelKey(modelKey);
  }

  function clearSimulationOutputs(markDirty) {
    state.results = null;
    state.sampleWinners = null;
    state.sampleGameScores = null;
    if (markDirty) {
      state.dirty = true;
    }
    els.exportSummaryButton.disabled = true;
    els.exportScoresButton.disabled = true;
    els.winnerBanner.hidden = true;
    renderBracket(null, null, null);
    renderStatsBar();
    renderOutlookTab();
  }

  // ─── Tabs ────────────────────────────────────────────────────

  function switchTab(tabName) {
    state.activeTab = tabName;
    Array.prototype.forEach.call(document.querySelectorAll(".tab-btn"), function (btn) {
      btn.classList.toggle("tab-btn--active", btn.dataset.tab === tabName);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tab-panel"), function (panel) {
      panel.classList.toggle("tab-panel--active", panel.id === "tab-" + tabName);
    });
    if (tabName === "leaders") { renderLeadersTab(); }
    if (tabName === "outlook" && state.results) { renderOutlookTab(); }
  }

  // ─── Controls ────────────────────────────────────────────────

  function wireControls() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab-btn"), function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.dataset.tab); });
    });

    els.simulateOnce.addEventListener("click", function () {
      // Use whatever seed is in the input (allows repeatability), then advance
      state.seed = Number(els.seed.value) || Math.floor(Date.now() % 1000000000);
      simulateOnce();
      // Queue next random seed so spamming the button gives new results
      const nextSeed = Math.floor(Math.random() * 1000000000);
      state.seed = nextSeed;
      els.seed.value = nextSeed;
      saveSettings();
    });

    els.runButton.addEventListener("click", function () {
      state.seed = Number(els.seed.value) || Math.floor(Date.now() % 1000000000);
      state.simulations = readSimulationCountInput();
      els.simulationCount.value = state.simulations;
      saveSettings();
      updateRunButtonLabel();
      runSimulations();
    });

    els.randomizeSeed.addEventListener("click", function () {
      state.seed = Math.floor(Math.random() * 1000000000);
      els.seed.value = state.seed;
      saveSettings();
    });

    els.simulationCount.addEventListener("change", function () {
      state.simulations = readSimulationCountInput();
      els.simulationCount.value = state.simulations;
      saveSettings();
      updateRunButtonLabel();
    });

    els.modelSelect.addEventListener("change", function () {
      state.modelKey = normalizeModelKey(els.modelSelect.value);
      els.modelSelect.value = state.modelKey;
      saveSettings();
      clearSimulationOutputs(true);
      if (state.activeTab === "leaders") { renderLeadersTab(); }
      renderStatusBar(getModelLabel(state.modelKey) + " selected. Rerun simulations to refresh projections.");
    });

    els.resetButton.addEventListener("click", function () {
      state.lockedResults = getBaselineLockedResults();
      saveLockedResults();
      clearSimulationOutputs(true);
      if (state.activeTab === "leaders") { renderLeadersTab(); }
      renderStatusBar(blankScenario
        ? "Blank scenario reset to an empty bracket."
        : "Manual locks cleared. All completed game results restored.");
    });

    els.exportSummaryButton.addEventListener("click", function () {
      if (state.results) { downloadTextFile("marshall-sim-summary.csv", buildSummaryCsv(state.results)); }
    });
    els.exportScoresButton.addEventListener("click", function () {
      if (state.results) { downloadTextFile("marshall-sim-simulation-scores.csv", buildSimulationScoresCsv(state.results)); }
    });

    // Click-to-lock delegation: clicking a team slot directly locks it
    els.bracketHost.addEventListener("click", function (e) {
      const slot = e.target.closest(".team-slot[data-team-slug]");
      if (!slot) { return; }
      const gameId  = slot.getAttribute("data-game-id");
      const teamSlug = slot.getAttribute("data-team-slug");
      if (!gameId || !teamSlug) { return; }

      const nextLocked = Object.assign({}, state.lockedResults);
      // Toggle: clicking locked winner removes it
      if (nextLocked[gameId] === teamSlug) {
        delete nextLocked[gameId];
      } else {
        nextLocked[gameId] = teamSlug;
      }
      state.lockedResults = core.normalizeRequestedSelections(compiled, nextLocked);
      saveLockedResults();
      clearSimulationOutputs(true);
      if (state.activeTab === "leaders") { renderLeadersTab(); }
      renderStatusBar("Result updated. Rerun simulations to refresh projections.");
    });

    // Override select (for unresolved-slot games)
    els.bracketHost.addEventListener("change", function (e) {
      const sel = e.target.closest("select[data-game-id]");
      if (!sel) { return; }
      const gameId   = sel.getAttribute("data-game-id");
      const nextValue = sel.value;
      const nextLocked = Object.assign({}, state.lockedResults);
      delete nextLocked[gameId];
      if (nextValue) { nextLocked[gameId] = nextValue; }
      state.lockedResults = core.normalizeRequestedSelections(compiled, nextLocked);
      saveLockedResults();
      clearSimulationOutputs(true);
      if (state.activeTab === "leaders") { renderLeadersTab(); }
      renderStatusBar("Override applied. Rerun simulations to refresh projections.");
    });
  }

  // ─── Simulate Once ───────────────────────────────────────────

  function simulateOnce() {
    saveLockedResults();
    const oneResult = core.runOneBracket(compiled, {
      seed: state.seed,
      lockedResults: state.lockedResults,
      modelKey: state.modelKey,
    });
    state.sampleWinners = oneResult.winnersByGameId;
    state.sampleGameScores = oneResult.gameScoresById || null;

    const winnerNames = oneResult.poolWinnerIndices
      .map(function (i) { return compiled.participants[i].name; }).join(" & ");
    const isTie = oneResult.poolWinnerIndices.length > 1;
    els.winnerBannerText.textContent =
      (isTie ? "Tied: " : "Pool winner: ") +
      winnerNames + " · " + numberFormat.format(oneResult.topScore) + " pts · " + getModelLabel(state.modelKey);
    els.winnerBanner.hidden = false;

    // Switch to bracket tab so user sees the result
    switchTab("bracket");
    renderBracket(oneResult.winnersByGameId, state.results ? state.results.gameProbabilities : null, state.sampleGameScores);
    renderStatusBar(
      "Simulated 1 outcome with " + getModelLabel(state.modelKey) +
      " · seed " + numberFormat.format(state.seed) + "."
    );
  }

  // ─── Run Simulations ─────────────────────────────────────────

  function runSimulations() {
    saveLockedResults();
    els.runButton.disabled = true;
    renderStatusBar(
      "Running " + numberFormat.format(state.simulations) +
      " simulations with " + getModelLabel(state.modelKey) + "…"
    );

    window.setTimeout(function () {
      state.results = core.runSimulations(compiled, {
        simulations: state.simulations,
        seed: state.seed,
        lockedResults: state.lockedResults,
        modelKey: state.modelKey,
      });
      state.dirty = false;
      els.runButton.disabled = false;
      renderBracket(state.sampleWinners, state.results.gameProbabilities, state.sampleGameScores);
      renderStatsBar();
      renderOutlookTab();
      if (state.activeTab === "leaders") { renderLeadersTab(); }
      els.exportSummaryButton.disabled = false;
      els.exportScoresButton.disabled = false;
      switchTab("outlook");
      renderStatusBar(
        numberFormat.format(state.simulations) + " sims complete · seed " + numberFormat.format(state.seed) +
        " · " + getModelLabel(state.modelKey) + " probabilities shown in bracket."
      );
    }, 10);
  }

  // ─── Bracket ─────────────────────────────────────────────────

  function renderBracket(sampleWinners, gameProbabilities, sampleGameScores) {
    const gameStates = core.getGameStates(compiled, state.lockedResults);
    const byId = {};
    gameStates.forEach(function (g) { byId[g.id] = g; });

    function getGame(region, round, i) {
      return byId[region + "-" + round + "-" + i] || null;
    }

    function probPct(prob) {
      if (prob === undefined || prob === null) { return ""; }
      return Math.round(prob * 100) + "%";
    }

    function renderTeamSlot(gameId, slug, label, isWinner, isSimulated, prob, score) {
      if (!slug) {
        return [
          "<div class=\"team-slot muted-slot\">",
          "<span class=\"name\">" + escapeHtml(label || "TBD") + "</span>",
          "</div>",
        ].join("");
      }
      const team = compiled.teams[compiled.teamIndexBySlug.get(slug)];
      const seed = team ? team.seed : "";
      const name = compiled.teamNameBySlug.get(slug) || slug;
      const classes = ["team-slot"];
      if (isWinner && isSimulated) { classes.push("simulated"); }
      else if (isWinner) { classes.push("winner"); }
      const probHtml = (prob !== null && prob !== undefined)
        ? "<span class=\"win-prob\">" + escapeHtml(probPct(prob)) + "</span>"
        : "";
      const scoreHtml = (score !== null && score !== undefined)
        ? "<span class=\"score\">" + escapeHtml(String(score)) + "</span>"
        : "";
      const lockHtml = (isWinner && !isSimulated)
        ? "<svg class=\"lock-icon\" viewBox=\"0 0 8 10\" fill=\"currentColor\" aria-hidden=\"true\">" +
          "<rect x=\"1\" y=\"4.5\" width=\"6\" height=\"5\" rx=\"1\"/>" +
          "<path d=\"M2.2 4.5V3.2a1.8 1.8 0 013.6 0v1.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\"/>" +
          "</svg>"
        : "";
      return [
        "<div class=\"" + classes.join(" ") + "\"",
        " data-team-slug=\"" + escapeHtml(slug) + "\"",
        " data-game-id=\"" + escapeHtml(gameId) + "\">",
        "<span class=\"seed\">" + escapeHtml(String(seed)) + "</span>",
        "<span class=\"name\">" + escapeHtml(name) + "</span>",
        scoreHtml,
        lockHtml,
        probHtml,
        "</div>",
      ].join("");
    }

    function renderMatchup(game, extraClass) {
      if (!game) {
        return "<div class=\"matchup" + (extraClass ? " " + extraClass : "") + "\"></div>";
      }

      const lockedWinner = game.lockedWinner;
      const simWinner    = sampleWinners ? sampleWinners[game.id] : null;
      const displayWinner = simWinner || lockedWinner;
      const isSimulated  = Boolean(simWinner && !lockedWinner);

      const probs = (gameProbabilities && gameProbabilities[game.id]) || null;

      // Use sampleWinners to resolve slots not yet determined by locked results
      function resolveSlug(lockedSlug, slot) {
        if (lockedSlug) { return lockedSlug; }
        if (sampleWinners && slot && slot.type === "game") {
          return sampleWinners[slot.gameId] || null;
        }
        return null;
      }
      const slugA = resolveSlug(game.teamA, game.slotA);
      const slugB = resolveSlug(game.teamB, game.slotB);
      const labelA = slugA ? null : core.getSlotLabel(compiled, game.slotA);
      const labelB = slugB ? null : core.getSlotLabel(compiled, game.slotB);

      const winA = Boolean(displayWinner && slugA && displayWinner === slugA);
      const winB = Boolean(displayWinner && slugB && displayWinner === slugB);

      const probA = (probs && slugA) ? probs[slugA] : null;
      const probB = (probs && slugB) ? probs[slugB] : null;
      const gameScores = sampleGameScores && sampleGameScores[game.id]
        ? sampleGameScores[game.id]
        : (
          game.sourceResult &&
          game.sourceResult.scoreA !== undefined &&
          game.sourceResult.scoreB !== undefined
        ) ? {
          teamAScore: game.sourceResult.scoreA,
          teamBScore: game.sourceResult.scoreB,
        } : null;

      const classes = ["matchup"];
      if (extraClass) { classes.push(extraClass); }
      if (game.requestedSelection) { classes.push("has-override"); }

      const slotAHtml = renderTeamSlot(
        game.id,
        slugA,
        labelA,
        winA,
        isSimulated && winA,
        probA,
        gameScores ? gameScores.teamAScore : null
      );
      const slotBHtml = renderTeamSlot(
        game.id,
        slugB,
        labelB,
        winB,
        isSimulated && winB,
        probB,
        gameScores ? gameScores.teamBScore : null
      );

      // For games with unresolved slots: show compact override select
      let selectHtml = "";
      if (!slugA || !slugB) {
        selectHtml = [
          "<div class=\"matchup-select-wrap\">",
          "<select data-game-id=\"" + escapeHtml(game.id) + "\">",
          buildGameOptionMarkup(game),
          "</select>",
          "</div>",
        ].join("");
      }

      return [
        "<div class=\"" + classes.join(" ") + "\" data-game-id=\"" + escapeHtml(game.id) + "\">",
        slotAHtml,
        slotBHtml,
        selectHtml,
        "</div>",
      ].join("");
    }

    function renderRegionCols(region, rounds) {
      return rounds.map(function (round) {
        const count = ROUND_COUNTS[round];
        const matchups = [];
        for (let i = 0; i < count; i += 1) {
          matchups.push(renderMatchup(getGame(region, round, i), null));
        }
        return "<div class=\"bracket-col col-" + round + "\">" + matchups.join("") + "</div>";
      }).join("");
    }

    function renderRegion(region, rounds, mirrored) {
      return [
        "<div class=\"bracket-region" + (mirrored ? " bracket-region--mirrored" : "") + "\" data-region=\"" + region + "\">",
        renderRegionCols(region, rounds),
        "</div>",
      ].join("");
    }

    // Left half: South (top) + East (bottom), R64→E8 left→right
    const leftHtml = [
      "<div class=\"bracket-half bracket-half--left\">",
      renderRegion("south", LEFT_ROUNDS, false),
      renderRegion("east", LEFT_ROUNDS, false),
      "</div>",
    ].join("");

    // Center
    const ff0   = byId["final-four-0"];
    const ff1   = byId["final-four-1"];
    const champ = byId["championship-0"];

    const centerHtml = [
      "<div class=\"bracket-center\">",
      "<div class=\"bracket-ff\">", renderMatchup(ff0, "matchup--ff"), "</div>",
      "<div class=\"bracket-championship\">", renderMatchup(champ, "matchup--championship"), "</div>",
      "<div class=\"bracket-ff\">", renderMatchup(ff1, "matchup--ff"), "</div>",
      "</div>",
    ].join("");

    // Right half: West (top) + Midwest (bottom), visually E8→R64 (mirrored via row-reverse)
    const rightHtml = [
      "<div class=\"bracket-half bracket-half--right\">",
      renderRegion("west",    LEFT_ROUNDS, true),
      renderRegion("midwest", LEFT_ROUNDS, true),
      "</div>",
    ].join("");

    els.bracketHost.innerHTML = leftHtml + centerHtml + rightHtml;
  }

  // ─── Stats Bar ───────────────────────────────────────────────

  function renderStatsBar() {
    if (!state.results) {
      els.statsBar.innerHTML = "";
      return;
    }
    const r = state.results;
    const top = r.participants.slice().sort(function (a, b) { return b.winRate - a.winRate; })[0];
    const second = r.participants.slice().sort(function (a, b) { return b.secondRate - a.secondRate; })[0];
    const tieRate = r.simulationsWithTieForFirst / r.simulations;

    els.statsBar.innerHTML = [
      statItem("Most likely to win", escapeHtml(top.name) + " " + percentFormat.format(top.winRate)),
      "<div class=\"stats-divider\"></div>",
      statItem("2nd most likely", escapeHtml(second.name) + " " + percentFormat.format(second.secondRate)),
      "<div class=\"stats-divider\"></div>",
      statItem("Tie for 1st", percentFormat.format(tieRate)),
    ].join("");
  }

  function statItem(label, value) {
    return [
      "<div class=\"stat-item\">",
      "<span class=\"stat-label\">" + escapeHtml(label) + ":</span>",
      "<span class=\"stat-value\">" + value + "</span>",
      "</div>",
    ].join("");
  }

  // ─── Team Disclosure Helpers ──────────────────────────────────

  function computeEliminatedSlugs() {
    const gameStates = core.getGameStates(compiled, state.lockedResults);
    const eliminated = new Set();
    gameStates.forEach(function (game) {
      if (game.lockedWinner && game.teamA && game.teamB) {
        const loser = game.lockedWinner === game.teamA ? game.teamB : game.teamA;
        eliminated.add(loser);
      }
    });
    return eliminated;
  }

  function renderTeamDisclosure(participantName, eliminatedSlugs) {
    var participant = null;
    for (var i = 0; i < compiled.participants.length; i += 1) {
      if (compiled.participants[i].name === participantName) {
        participant = compiled.participants[i];
        break;
      }
    }
    if (!participant) { return escapeHtml(participantName); }
    const tags = participant.teams.map(function (slug) {
      const team = compiled.teams[compiled.teamIndexBySlug.get(slug)];
      const name = compiled.teamNameBySlug.get(slug) || slug;
      const seed = team ? team.seed : "";
      const isOut = eliminatedSlugs.has(slug);
      return [
        "<span class=\"team-tag" + (isOut ? " team-tag--out" : "") + "\">",
        seed ? "<span class=\"team-seed\">" + escapeHtml(String(seed)) + "</span>" : "",
        escapeHtml(name),
        "</span>",
      ].join("");
    }).join("");
    return [
      "<details class=\"participant-details\">",
      "<summary>" + escapeHtml(participantName) + "</summary>",
      "<div class=\"teams-disclosure\">" + tags + "</div>",
      "</details>",
    ].join("");
  }

  // ─── Leaders Tab ─────────────────────────────────────────────

  function renderLeadersTab() {
    const standings = core.computeLockedScoreboard(compiled, state.lockedResults);
    const topScore = standings.length ? standings[0].currentPoints : 0;
    const eliminatedSlugs = computeEliminatedSlugs();

    const projByName = {};
    if (state.results) {
      state.results.participants.forEach(function (p) {
        projByName[p.name] = p;
      });
    }

    const gamesLocked = Object.keys(core.sanitizeLockedResults(compiled, state.lockedResults)).length;
    els.leadersNote.textContent = gamesLocked + " game" + (gamesLocked !== 1 ? "s" : "") + " locked";

    els.leadersBody.innerHTML = standings
      .map(function (row, index) {
        const gap = topScore - row.currentPoints;
        const proj = projByName[row.name];
        const winPct = proj ? percentFormat.format(proj.winRate) : "—";
        const isLeader = index === 0 || row.currentPoints === topScore;
        return [
          "<tr" + (isLeader ? " class=\"leader-row\"" : "") + ">",
          "<td>" + (index + 1) + "</td>",
          "<td>" + renderTeamDisclosure(row.name, eliminatedSlugs) + "</td>",
          "<td>" + numberFormat.format(row.currentPoints) + "</td>",
          "<td>" + numberFormat.format(row.teamsRemaining) + "</td>",
          "<td>$" + numberFormat.format(row.dollarsLeft) + "</td>",
          "<td>" + (gap > 0 ? "–" + gap : "—") + "</td>",
          "<td>" + winPct + "</td>",
          "</tr>",
        ].join("");
      })
      .join("");
  }

  // ─── Outlook Tab (Monte Carlo projections) ───────────────────

  function renderOutlookTab() {
    if (!state.results) {
      els.leaderboardBody.innerHTML = "";
      return;
    }
    const eliminatedSlugs = computeEliminatedSlugs();
    els.leaderboardBody.innerHTML = state.results.participants
      .map(function (p, index) {
        return [
          "<tr>",
          "<td>" + (index + 1) + "</td>",
          "<td>" + renderTeamDisclosure(p.name, eliminatedSlugs) + "</td>",
          "<td>" + numberFormat.format(p.currentPoints) + "</td>",
          "<td>" + scoreFormat.format(p.averageScore) + "</td>",
          "<td>" + percentFormat.format(p.winRate) + "</td>",
          "<td>" + percentFormat.format(p.secondRate) + "</td>",
          "<td>" + percentFormat.format(p.topTwoRate) + "</td>",
          "<td>" + currencyFormat.format(p.expectedValue || 0) + "</td>",
          "<td>" + numberFormat.format(p.minScore) + "–" + numberFormat.format(p.maxScore) + "</td>",
          "<td>" + numberFormat.format(p.teamCount) + "</td>",
          "</tr>",
        ].join("");
      })
      .join("");
  }

  // ─── Status Bar ──────────────────────────────────────────────

  function renderStatusBar(message) {
    const dirty = state.dirty ? "<span class=\"dirty-flag\"> · Projections stale — rerun.</span>" : "";
    els.statusBar.innerHTML = "<span>" + escapeHtml(message) + dirty + "</span>";
  }

  // ─── Footer ──────────────────────────────────────────────────

  function renderFooter() {
    const rules = data.meta.pool.rulesSummary || [];
    els.footerRules.innerHTML = "<ul>" + rules.map(function (r) {
      return "<li>" + escapeHtml(r) + "</li>";
    }).join("") + "</ul>";
    const generatedAt = new Date(data.meta.generatedAt).toLocaleDateString();
    const footerBits = ["Data from Boxscorus"];
    if (data.meta.kenpomSource) {
      footerBits.push("KenPom snapshot");
    }
    footerBits.push("Generated " + generatedAt);
    els.footerMeta.innerHTML = escapeHtml(footerBits.join(" · "));
  }

  // ─── ESPN Live Sync ───────────────────────────────────────────

  function normalizeName(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/\(.*?\)/g, "")       // remove (FL), (OH), etc.
      .replace(/[^a-z0-9\s]/g, " ") // strip punctuation
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildEspnNameMap() {
    const map = new Map();
    const ambiguousKeys = new Set();

    compiled.teams.forEach(function (team) {
      const key = normalizeName(team.name);
      if (!key) { return; }
      if (!map.has(key)) {
        map.set(key, team.slug);
        return;
      }
      if (map.get(key) !== team.slug) {
        ambiguousKeys.add(key);
      }
    });

    ambiguousKeys.forEach(function eachAmbiguousKey(key) {
      map.delete(key);
    });

    // Manual aliases for ESPN display name variants
    const aliases = {
      "iowa state":           "iowa-st",
      "kennesaw state":       "kennesaw-st",
      "michigan state":       "michigan-st",
      "nc state":             "north-carolina-st",
      "north carolina state": "north-carolina-st",
      "north dakota state":   "north-dakota-st",
      "ohio state":           "ohio-st",
      "tennessee state":      "tennessee-st",
      "utah state":           "utah-st",
      "wright state":         "wright-st",
      "south florida":        "south-fla",
      "usf":                  "south-fla",
      "liu":                  "long-island",
      "long island":          "long-island",
      "queens":               "queens-nc",
      "northern iowa":        "uni",
      "unc":                  "north-carolina",
      "uconn":                "uconn",
      "connecticut":          "uconn",
      "central florida":      "ucf",
      "virginia commonwealth":"vcu",
      "brigham young":        "byu",
      "byu cougars":          "byu",
      "cal baptist":          "california-baptist",
      "california baptist lancers":"california-baptist",
      "prairie view am":      "prairie-view",
      "prairie view a m":     "prairie-view",
      "st johns":             "st-johns-ny",
      "saint marys":          "st-marys-ca",
      "hawai i":              "hawaii",
      "hawai i rainbow warriors":"hawaii",
      "n dakota st":          "north-dakota-st",
      "north dakota state bison":"north-dakota-st",
      "mia":                  "miami-fl",
      "m oh":                 "miami-oh",
      "miami oh":             "miami-oh",
      "miami fl":             "miami-fl",
      "miami ohio":           "miami-oh",
      "miami florida":        "miami-fl",
      "miami hurricanes":     "miami-fl",
      "miami redhawks":       "miami-oh",
    };

    Object.keys(aliases).forEach(function (key) {
      map.set(key, aliases[key]);
    });

    return map;
  }

  function buildSlugToGameIds() {
    const map = new Map();
    compiled.games.forEach(function (game) {
      game.possibleWinnerSlugs.forEach(function (slug) {
        if (!map.has(slug)) { map.set(slug, new Set()); }
        map.get(slug).add(game.id);
      });
    });
    return map;
  }

  function slugToGameId(slugA, slugB) {
    // Find the most specific game (fewest possible winners) where both slugs
    // are possible winners. Using minimum size avoids matching to Championship
    // when the teams actually played in an earlier round.
    const setA = slugToGameIds.get(slugA);
    const setB = slugToGameIds.get(slugB);
    if (!setA || !setB) { return null; }
    var result = null;
    var minSize = Infinity;
    setA.forEach(function (gameId) {
      if (setB.has(gameId)) {
        const game = compiled.gamesById.get(gameId);
        const size = game ? game.possibleWinnerSlugs.length : Infinity;
        if (size < minSize) {
          minSize = size;
          result = gameId;
        }
      }
    });
    return result;
  }

  function resolveEspnTeamSlug(team) {
    if (!team) { return null; }
    const candidates = [
      normalizeName(team.abbreviation || ""),
      normalizeName(team.shortDisplayName || ""),
      normalizeName(team.displayName || ""),
      normalizeName(team.name || ""),
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (!candidate) { continue; }
      const slug = espnNameMap.get(candidate);
      if (slug) {
        return slug;
      }
    }
    return null;
  }

  function buildEspnScoreboardUrls(fullSync) {
    const baseUrl =
      "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard" +
      "?seasontype=3&groups=50&limit=500&dates=";
    const urls = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setFullYear(Number(data.meta && data.meta.season) || today.getFullYear(), 2, 17);
    startDate.setHours(0, 0, 0, 0);
    var lookbackDays = 3;

    if (fullSync) {
      lookbackDays = Math.max(1, Math.floor((today - startDate) / 86400000) + 1);
    }

    for (var dayOffset = 0; dayOffset < lookbackDays; dayOffset += 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - dayOffset);
      urls.push(baseUrl + formatEspnDate(date));
    }

    return urls;
  }

  function formatEspnDate(date) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + month + day;
  }

  function syncLive(silent, fullSync) {
    if (blankScenario) {
      return Promise.resolve();
    }
    const espnUrls = buildEspnScoreboardUrls(Boolean(fullSync));

    return Promise.allSettled(espnUrls.map(function (espnUrl) {
      return fetch(espnUrl)
        .then(function (res) {
          if (!res.ok) { throw new Error("ESPN API " + res.status); }
          return res.json();
        });
    }))
      .then(function (results) {
        const payloads = [];
        let firstError = null;
        results.forEach(function eachResult(result) {
          if (result.status === "fulfilled") {
            payloads.push(result.value);
          } else if (!firstError) {
            firstError = result.reason;
          }
        });

        if (!payloads.length) {
          throw firstError || new Error("ESPN API unavailable");
        }

        const eventsById = {};
        payloads.forEach(function eachPayload(json) {
          (json.events || []).forEach(function eachEvent(event) {
            if (event && event.id) {
              eventsById[event.id] = event;
            }
          });
        });

        const events = Object.keys(eventsById).map(function eachId(eventId) {
          return eventsById[eventId];
        });
        const previousLiveResults = Object.assign({}, state.liveResults);
        const nextLiveResults = Object.assign({}, core.defaultLockedResults(compiled));
        const changedGameIds = new Set();
        var matched = 0;

        events.forEach(function (event) {
          try {
            const competition = event.competitions && event.competitions[0];
            if (!competition) { return; }
            const completed = event.status && event.status.type && event.status.type.completed;
            if (!completed) { return; }
            const noteHeadline = competition.notes &&
              competition.notes[0] &&
              competition.notes[0].headline;
            if (noteHeadline && noteHeadline.indexOf("NCAA Men's Basketball Championship") === -1) {
              return;
            }

            const competitors = competition.competitors || [];
            if (competitors.length !== 2) { return; }

            const c0 = competitors[0];
            const c1 = competitors[1];
            const slug0 = resolveEspnTeamSlug(c0.team);
            const slug1 = resolveEspnTeamSlug(c1.team);
            if (!slug0 || !slug1) { return; }

            const gameId = slugToGameId(slug0, slug1);
            if (!gameId) { return; }

            const winner0 = Boolean(c0.winner);
            const winnerSlug = winner0 ? slug0 : slug1;
            nextLiveResults[gameId] = winnerSlug;
            matched += 1;
          } catch (e) {
            console.warn("Error processing ESPN event", e);
          }
        });

        Object.keys(previousLiveResults).forEach(function eachGameId(gameId) {
          if ((previousLiveResults[gameId] || null) !== (nextLiveResults[gameId] || null)) {
            changedGameIds.add(gameId);
          }
        });
        Object.keys(nextLiveResults).forEach(function eachGameId(gameId) {
          if ((previousLiveResults[gameId] || null) !== (nextLiveResults[gameId] || null)) {
            changedGameIds.add(gameId);
          }
        });

        const nextLockedRaw = Object.assign({}, state.lockedResults);
        changedGameIds.forEach(function eachChangedGame(gameId) {
          const previousWinnerSlug = previousLiveResults[gameId] || null;
          const nextWinnerSlug = nextLiveResults[gameId] || null;
          const currentLockedWinner = nextLockedRaw[gameId] || null;

          if (!currentLockedWinner) {
            if (nextWinnerSlug) {
              nextLockedRaw[gameId] = nextWinnerSlug;
            }
            return;
          }

          if (currentLockedWinner !== previousWinnerSlug) {
            return;
          }

          if (nextWinnerSlug) {
            nextLockedRaw[gameId] = nextWinnerSlug;
          } else {
            delete nextLockedRaw[gameId];
          }
        });

        const normalizedLockedResults = core.normalizeRequestedSelections(compiled, nextLockedRaw);
        const liveChanged = JSON.stringify(previousLiveResults) !== JSON.stringify(nextLiveResults);
        const lockedChanged = JSON.stringify(state.lockedResults) !== JSON.stringify(normalizedLockedResults);

        if (liveChanged) {
          state.liveResults = nextLiveResults;
          saveLiveResults();
        }
        if (lockedChanged) {
          state.lockedResults = normalizedLockedResults;
          saveLockedResults();
          clearSimulationOutputs(true);
          if (state.activeTab === "leaders") { renderLeadersTab(); }
        }

        if (liveChanged || lockedChanged) {
          if (!silent || lockedChanged) {
            const synced = changedGameIds.size;
            if (lockedChanged) {
              renderStatusBar(synced + " official result" + (synced !== 1 ? "s" : "") + " synced from ESPN.");
            } else {
              renderStatusBar(synced + " official result" + (synced !== 1 ? "s" : "") + " refreshed from ESPN.");
            }
          }
        } else if (!silent) {
          renderStatusBar(matched > 0
            ? "Up to date — no new results from ESPN."
            : "ESPN sync returned no completed tournament games.");
        }
      })
      .catch(function (err) {
        console.warn("ESPN sync failed:", err);
        if (!silent) {
          renderStatusBar("ESPN sync unavailable (" + err.message + ").");
        }
      });
  }

  // ─── Game Override Options ────────────────────────────────────

  function buildGameOptionMarkup(game) {
    const selectedValue = game.requestedSelection || "";
    const chunks = ["<option value=\"\"" + selectedAttr(selectedValue === "") + ">Auto simulate</option>"];

    if (game.slotA && game.slotA.type === "game" && !game.teamA) {
      chunks.push("<option value=\"slot:A\"" + selectedAttr(selectedValue === "slot:A") + ">" +
        escapeHtml(core.getSelectionLabel(compiled, game, "slot:A")) + "</option>");
    }
    if (game.slotB && game.slotB.type === "game" && !game.teamB) {
      chunks.push("<option value=\"slot:B\"" + selectedAttr(selectedValue === "slot:B") + ">" +
        escapeHtml(core.getSelectionLabel(compiled, game, "slot:B")) + "</option>");
    }
    if (game.slotA) { chunks.push(buildTeamOptgroup("Side A", core.getPossibleTeamsForSlot(compiled, game.slotA), selectedValue)); }
    if (game.slotB) { chunks.push(buildTeamOptgroup("Side B", core.getPossibleTeamsForSlot(compiled, game.slotB), selectedValue)); }

    return chunks.join("");
  }

  function buildTeamOptgroup(label, teamSlugs, selectedValue) {
    if (!teamSlugs || !teamSlugs.length) { return ""; }
    return [
      "<optgroup label=\"" + escapeHtml(label) + "\">",
      teamSlugs.map(function (slug) {
        return "<option value=\"" + escapeHtml(slug) + "\"" + selectedAttr(selectedValue === slug) + ">" +
          escapeHtml(compiled.teamNameBySlug.get(slug) || slug) + "</option>";
      }).join(""),
      "</optgroup>",
    ].join("");
  }

  function selectedAttr(isSelected) { return isSelected ? " selected" : ""; }

  // ─── CSV Export ───────────────────────────────────────────────

  function buildSummaryCsv(results) {
    const header = ["Participant","Current Points","Average Final Score","Expected Value","Win Rate","Outright Win Rate","Tied Win Rate","Second Rate","Top Two Rate","Min Score","Max Score","Teams"];
    const rows = results.participants.map(function (p) {
      return [p.name, p.currentPoints, p.averageScore.toFixed(3),
        p.expectedValue.toFixed(2),
        p.winRate.toFixed(6), p.outrightWinRate.toFixed(6), p.tiedWinRate.toFixed(6),
        p.secondRate.toFixed(6), p.topTwoRate.toFixed(6), p.minScore, p.maxScore, p.teamCount];
    });
    return [header].concat(rows).map(toCsvRow).join("\n");
  }

  function buildSimulationScoresCsv(results) {
    const pNames = compiled.participants.map(function (p) { return p.name; });
    const header = ["Simulation","Top Score","Winners","Second Score","Second Place"].concat(pNames);
    const rows = results.simulationOutcomes.map(function (outcome, rowIndex) {
      const row = [outcome.simulation, outcome.topScore, formatParticipantList(outcome.winners),
        outcome.secondScore >= 0 ? outcome.secondScore : "", formatParticipantList(outcome.secondPlace)];
      for (var i = 0; i < compiled.participants.length; i += 1) {
        row.push(results.scoreMatrix[(rowIndex * compiled.participants.length) + i]);
      }
      return row;
    });
    return [header].concat(rows).map(toCsvRow).join("\n");
  }

  function toCsvRow(values) {
    return values.map(function (v) {
      const s = String(v == null ? "" : v);
      return "\"" + s.replace(/"/g, "\"\"") + "\"";
    }).join(",");
  }

  function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }

  // ─── Utilities ───────────────────────────────────────────────

  function formatParticipantList(indices) {
    if (!indices || !indices.length) { return "None"; }
    return indices.map(function (i) { return compiled.participants[i].name; }).join(", ");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeSimulationCount(value) {
    const fallback = Math.max(1, Math.floor(compiled.defaultRuns || 10000));
    const count = Number(value);
    if (!Number.isFinite(count)) {
      return fallback;
    }
    return Math.max(1, Math.floor(count));
  }

  function readSimulationCountInput() {
    return normalizeSimulationCount(els.simulationCount.value);
  }

  function updateRunButtonLabel() {
    els.runButton.textContent = "Run " + numberFormat.format(state.simulations);
  }

  function readRuntimeOptions() {
    try {
      const params = new window.URLSearchParams(window.location.search || "");
      return {
        blankScenario: params.get("scenario") === "blank",
      };
    } catch (e) {
      return {
        blankScenario: false,
      };
    }
  }
})();
