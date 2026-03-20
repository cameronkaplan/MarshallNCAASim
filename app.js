(function () {
  "use strict";

  const data = window.MARSHALL_SIM_DATA;
  const core = window.MarshallSimCore;
  const compiled = core.compileData(data);

  const STORAGE_PREFIX = "marshall-sim-2026";
  const LEGACY_LOCKED_RESULTS_KEY = STORAGE_PREFIX + "-locked-results";
  const MANUAL_OVERRIDES_KEY = STORAGE_PREFIX + "-manual-overrides";
  const LIVE_RESULTS_KEY     = STORAGE_PREFIX + "-live-results";
  const SETTINGS_KEY         = STORAGE_PREFIX + "-settings";

  const initialLiveResults = loadLiveResults();
  const initialManualOverrides = loadManualOverrides(initialLiveResults);

  const state = {
    manualOverrides: initialManualOverrides,
    liveResults: initialLiveResults,
    seed: loadSettings().seed || Math.floor(Date.now() % 1000000000),
    results: null,
    sampleWinners: null,
    activeTab: "bracket",
    dirty: false,
  };

  const numberFormat   = new Intl.NumberFormat("en-US");
  const percentFormat  = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const scoreFormat    = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const els = {
    seed:               document.querySelector("#simulation-seed"),
    simulateOnce:       document.querySelector("#simulate-once"),
    runButton:          document.querySelector("#run-simulations"),
    randomizeSeed:      document.querySelector("#randomize-seed"),
    resetButton:        document.querySelector("#reset-results"),
    resetAllButton:     document.querySelector("#reset-all"),
    exportSummaryButton:document.querySelector("#export-summary"),
    exportScoresButton: document.querySelector("#export-scores"),
    winnerBanner:       document.querySelector("#winner-banner"),
    winnerBannerText:   document.querySelector("#winner-banner-text"),
    statusBar:          document.querySelector("#status-bar"),
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
    renderFooter();
    wireControls();
    renderBracket(null, null);
    renderStatusBar("Ready. Click Simulate for one outcome, or Run 10,000 for projections.");
    // Auto sync live results, then run sims
    syncLive().then(function () {
      window.setTimeout(runSimulations, 0);
    });
    // Re-sync silently every 3 minutes
    window.setInterval(function () { syncLive(true); }, 3 * 60 * 1000);
  }

  // ─── Persistence ─────────────────────────────────────────────

  function loadStoredSelections(storageKey, label) {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return core.normalizeRequestedSelections(compiled, parsed);
      }
    } catch (e) {
      console.warn("Could not parse " + label + ".", e);
    }
    return null;
  }

  function loadLiveResults() {
    return loadStoredSelections(LIVE_RESULTS_KEY, "live results") || {};
  }

  function loadManualOverrides(initialLive) {
    const stored = loadStoredSelections(MANUAL_OVERRIDES_KEY, "manual overrides");
    if (stored) {
      return stored;
    }

    const legacy = loadStoredSelections(LEGACY_LOCKED_RESULTS_KEY, "legacy locked results");
    if (!legacy) {
      return {};
    }

    const officialResults = core.normalizeRequestedSelections(
      compiled,
      Object.assign({}, core.defaultLockedResults(compiled), initialLive)
    );
    const migrated = {};

    Object.keys(legacy).forEach(function eachGame(gameId) {
      if (legacy[gameId] !== officialResults[gameId]) {
        migrated[gameId] = legacy[gameId];
      }
    });

    const normalized = core.normalizeRequestedSelections(compiled, migrated);
    window.localStorage.setItem(MANUAL_OVERRIDES_KEY, JSON.stringify(normalized));
    window.localStorage.removeItem(LEGACY_LOCKED_RESULTS_KEY);
    return normalized;
  }

  function loadSettings() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null");
      if (parsed && typeof parsed === "object") { return parsed; }
    } catch (e) {}
    return {};
  }

  function saveManualOverrides() {
    window.localStorage.setItem(MANUAL_OVERRIDES_KEY, JSON.stringify(state.manualOverrides));
  }

  function saveLiveResults() {
    window.localStorage.setItem(LIVE_RESULTS_KEY, JSON.stringify(state.liveResults));
  }

  function saveSettings() {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ seed: state.seed }));
  }

  function getOfficialSelections() {
    return core.normalizeRequestedSelections(
      compiled,
      Object.assign({}, core.defaultLockedResults(compiled), state.liveResults)
    );
  }

  function getExplicitSelections() {
    return Object.assign({}, getOfficialSelections(), state.manualOverrides);
  }

  function selectionMapsEqual(a, b) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (var i = 0; i < keysA.length; i += 1) {
      const key = keysA[i];
      if (a[key] !== b[key]) {
        return false;
      }
    }
    return true;
  }

  function invalidateSimulationOutputs(message) {
    state.results = null;
    state.sampleWinners = null;
    state.dirty = true;
    els.winnerBanner.hidden = true;
    els.exportSummaryButton.disabled = true;
    els.exportScoresButton.disabled = true;
    renderBracket(null, null);
    renderStatsBar();
    renderOutlookTab();
    renderLeadersTab();
    renderStatusBar(message);
  }

  function commitManualOverrides(nextOverrides, message) {
    const normalized = core.normalizeRequestedSelections(compiled, nextOverrides);
    if (selectionMapsEqual(normalized, state.manualOverrides)) {
      return;
    }
    state.manualOverrides = normalized;
    saveManualOverrides();
    invalidateSimulationOutputs(message);
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
    if (tabName === "outlook") { renderOutlookTab(); }
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
      saveSettings();
      runSimulations();
    });

    els.randomizeSeed.addEventListener("click", function () {
      state.seed = Math.floor(Math.random() * 1000000000);
      els.seed.value = state.seed;
      saveSettings();
    });

    els.resetButton.addEventListener("click", function () {
      state.manualOverrides = {};
      saveManualOverrides();
      invalidateSimulationOutputs("Manual overrides cleared. Official results restored.");
    });

    els.resetAllButton.addEventListener("click", function () {
      state.liveResults = {};
      state.manualOverrides = {};
      saveLiveResults();
      saveManualOverrides();
      invalidateSimulationOutputs(
        "Local overrides and ESPN cache cleared. Snapshot results remain until the next sync."
      );
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

      const officialSelections = getOfficialSelections();
      const nextOverrides = Object.assign({}, state.manualOverrides);
      const currentManual = nextOverrides[gameId] || null;
      delete nextOverrides[gameId];
      if (currentManual !== teamSlug && officialSelections[gameId] !== teamSlug) {
        nextOverrides[gameId] = teamSlug;
      }
      commitManualOverrides(nextOverrides, "Result updated.");
    });

    // Override select (for unresolved-slot games)
    els.bracketHost.addEventListener("change", function (e) {
      const sel = e.target.closest("select[data-game-id]");
      if (!sel) { return; }
      const gameId   = sel.getAttribute("data-game-id");
      const nextValue = sel.value;
      const officialSelections = getOfficialSelections();
      const nextOverrides = Object.assign({}, state.manualOverrides);
      delete nextOverrides[gameId];
      if (nextValue && officialSelections[gameId] !== nextValue) {
        nextOverrides[gameId] = nextValue;
      }
      commitManualOverrides(nextOverrides, "Override applied.");
    });
  }

  // ─── Simulate Once ───────────────────────────────────────────

  function simulateOnce() {
    const oneResult = core.runOneBracket(compiled, {
      seed: state.seed,
      lockedResults: getExplicitSelections(),
    });
    state.sampleWinners = oneResult.winnersByGameId;

    const winnerNames = oneResult.poolWinnerIndices
      .map(function (i) { return compiled.participants[i].name; }).join(" & ");
    const isTie = oneResult.poolWinnerIndices.length > 1;
    els.winnerBannerText.textContent =
      (isTie ? "Tied: " : "Pool winner: ") +
      winnerNames + " · " + numberFormat.format(oneResult.topScore) + " pts";
    els.winnerBanner.hidden = false;

    // Switch to bracket tab so user sees the result
    switchTab("bracket");
    renderBracket(oneResult.winnersByGameId, state.results ? state.results.gameProbabilities : null);
    renderStatusBar("Simulated 1 outcome · seed " + numberFormat.format(state.seed) + ".");
  }

  // ─── Run 10,000 ──────────────────────────────────────────────

  function runSimulations() {
    els.runButton.disabled = true;
    renderStatusBar("Running 10,000 simulations…");

    window.setTimeout(function () {
      state.results = core.runSimulations(compiled, {
        simulations: 10000,
        seed: state.seed,
        lockedResults: getExplicitSelections(),
      });
      state.dirty = false;
      els.runButton.disabled = false;
      renderBracket(state.sampleWinners, state.results.gameProbabilities);
      renderStatsBar();
      renderOutlookTab();
      if (state.activeTab === "leaders") { renderLeadersTab(); }
      els.exportSummaryButton.disabled = false;
      els.exportScoresButton.disabled = false;
      switchTab("outlook");
      renderStatusBar(
        "10,000 sims complete · seed " + numberFormat.format(state.seed) +
        " · probabilities shown in bracket."
      );
    }, 10);
  }

  // ─── Bracket ─────────────────────────────────────────────────

  function renderBracket(sampleWinners, gameProbabilities) {
    const gameStates = core.getGameStates(compiled, getExplicitSelections());
    const byId = {};
    gameStates.forEach(function (g) { byId[g.id] = g; });

    function getGame(region, round, i) {
      return byId[region + "-" + round + "-" + i] || null;
    }

    function probPct(prob) {
      if (prob === undefined || prob === null) { return ""; }
      return Math.round(prob * 100) + "%";
    }

    function renderTeamSlot(gameId, slug, label, isWinner, isSimulated, prob) {
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

      const classes = ["matchup"];
      if (extraClass) { classes.push(extraClass); }
      if (state.manualOverrides[game.id]) { classes.push("has-override"); }

      const slotAHtml = renderTeamSlot(game.id, slugA, labelA, winA, isSimulated && winA, probA);
      const slotBHtml = renderTeamSlot(game.id, slugB, labelB, winB, isSimulated && winB, probB);

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
    const top = r.participants[0];
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
    const gameStates = core.getGameStates(compiled, getExplicitSelections());
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
    const standings = core.computeLockedScoreboard(compiled, getExplicitSelections());
    const topScore = standings.length ? standings[0].currentPoints : 0;
    const eliminatedSlugs = computeEliminatedSlugs();

    const projByName = {};
    if (state.results) {
      state.results.participants.forEach(function (p) {
        projByName[p.name] = p;
      });
    }

    const gamesLocked = Object.keys(core.sanitizeLockedResults(compiled, getExplicitSelections())).length;
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
          "<td>" + numberFormat.format(p.minScore) + "–" + numberFormat.format(p.maxScore) + "</td>",
          "<td>" + numberFormat.format(p.teamCount) + "</td>",
          "</tr>",
        ].join("");
      })
      .join("");
  }

  // ─── Status Bar ──────────────────────────────────────────────

  function renderStatusBar(message) {
    const dirty = state.dirty ? "<span class=\"dirty-flag\"> · Bracket changed — rerun projections.</span>" : "";
    els.statusBar.innerHTML = "<span>" + escapeHtml(message) + dirty + "</span>";
  }

  // ─── Footer ──────────────────────────────────────────────────

  function renderFooter() {
    const rules = data.meta.pool.rulesSummary || [];
    els.footerRules.innerHTML = "<ul>" + rules.map(function (r) {
      return "<li>" + escapeHtml(r) + "</li>";
    }).join("") + "</ul>";
    const generatedAt = new Date(data.meta.generatedAt).toLocaleDateString();
    els.footerMeta.innerHTML = "Data from Boxscorus · Generated " + escapeHtml(generatedAt);
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
    // Auto-populate from compiled team names
    const map = new Map();
    compiled.teams.forEach(function (team) {
      map.set(normalizeName(team.name), team.slug);
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
      "cal baptist":          "california-baptist",
      "prairie view am":      "prairie-view",
      "prairie view a m":     "prairie-view",
      "st johns":             "st-johns-ny",
      "saint marys":          "st-marys-ca",
      "miami oh":             "miami-oh",
      "miami fl":             "miami-fl",
      "miami ohio":           "miami-oh",
      "miami florida":        "miami-fl",
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

  function syncLive(silent) {
    const espnUrl =
      "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard" +
      "?seasontype=3&limit=200";

    return fetch(espnUrl)
      .then(function (res) {
        if (!res.ok) { throw new Error("ESPN API " + res.status); }
        return res.json();
      })
      .then(function (json) {
        const events = json.events || [];
        var synced = 0;

        events.forEach(function (event) {
          try {
            const competition = event.competitions && event.competitions[0];
            if (!competition) { return; }
            const completed = event.status && event.status.type && event.status.type.completed;
            if (!completed) { return; }

            const competitors = competition.competitors || [];
            if (competitors.length !== 2) { return; }

            const c0 = competitors[0];
            const c1 = competitors[1];
            const name0 = normalizeName(c0.team && (c0.team.shortDisplayName || c0.team.displayName || ""));
            const name1 = normalizeName(c1.team && (c1.team.shortDisplayName || c1.team.displayName || ""));

            const slug0 = espnNameMap.get(name0);
            const slug1 = espnNameMap.get(name1);
            if (!slug0 || !slug1) { return; }

            const gameId = slugToGameId(slug0, slug1);
            if (!gameId) { return; }

            const winner0 = Boolean(c0.winner);
            const winnerSlug = winner0 ? slug0 : slug1;

            if (state.liveResults[gameId] === winnerSlug) { return; }
            state.liveResults[gameId] = winnerSlug;
            synced += 1;
          } catch (e) {
            console.warn("Error processing ESPN event", e);
          }
        });

        if (synced > 0) {
          saveLiveResults();
          invalidateSimulationOutputs(
            synced + " official result" + (synced !== 1 ? "s" : "") + " synced from ESPN."
          );
        } else if (!silent) {
          renderStatusBar("Up to date — no new results from ESPN.");
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
    const selectedValue = state.manualOverrides[game.id] || "";
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
    const header = ["Participant","Current Points","Average Final Score","Win Rate","Outright Win Rate","Tied Win Rate","Second Rate","Top Two Rate","Min Score","Max Score","Teams"];
    const rows = results.participants.map(function (p) {
      return [p.name, p.currentPoints, p.averageScore.toFixed(3),
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
})();
