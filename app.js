"use strict";

/* =========================================
   VELOCITY 5000 TIMING SYSTEM
   Offline-first frontend
   ========================================= */

const API_URL =
    "https://script.google.com/macros/s/AKfycbw5ndFNEjmqsRhqcdYDqBRAlzTFWUnufJ-Q6IxidBDSqu4Gt-ReD1HaaBqaMmsnSEhyBQ/exec";

const DISTANCES = ["3KM", "5KM", "10KM", "16KM"];

const DB_NAME = "Velocity5000Timing";
const DB_VERSION = 2;

const STORE_ENTRIES = "entries";
const STORE_META = "metadata";
const STORE_CONFIG = "config";

const CONFIG_CACHE_KEY = "runnerConfig";

let db;

const FIXED_EVENT_NAME = "2026 Takbo PauliNars";
const FIXED_EVENT_ID = "2026-TAKBO-PAULINARS";

let state = {
    eventName: FIXED_EVENT_NAME,
    eventId: FIXED_EVENT_ID,
    timerRole: "Timer1",
    deviceLabel: "",
    selectedDistance: "3KM",
    starts: {},
    startHistory: {},
    screen: "setup",
    entries: [],
    runners: [],
    configFetchedAt: null,
    deviceSessionId: createId()
};

let submitting = false;
let configRefreshing = false;
let selectedResultsSource = "CONSOLIDATED";
let selectedResultsCategory = "ALL";
let serverReviewData = null;
let resultsRefreshing = false;
let resultsRefreshError = "";
let startSyncInProgress = false;
let lastStartSyncAt = 0;
const START_SYNC_INTERVAL_MS = 3000;

const $ = id => document.getElementById(id);

/* =========================================
   UTILITIES
   ========================================= */

function createId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return "v5000-" + Date.now() + "-" +
        Math.random().toString(36).slice(2);
}

function nowIso() {
    return new Date().toISOString();
}

function normalizeBib(value) {
    return String(value ?? "").trim();
}

function formatClock(iso) {
    if (!iso) return "--:--:--";

    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Manila",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).format(new Date(iso));
}

function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "Pending";
    // Keep the full millisecond value for calculations/ranking; display HH:MM:SS.sss.
    const totalMs = Math.floor(ms);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const milliseconds = totalMs % 1000;
    return [String(hours).padStart(2, "0"), String(minutes).padStart(2, "0"), String(seconds).padStart(2, "0")].join(":") + "." + String(milliseconds).padStart(3, "0");
}

/*
 * Longer prefixes must be checked first.
 * 16001 must be 16KM, not 3KM.
 */
function detectDistance(bib) {
    const value = normalizeBib(bib);

    if (!/^\d+$/.test(value)) return null;

    if (value.startsWith("16")) return "16KM";
    if (value.startsWith("10")) return "10KM";
    if (value.startsWith("5")) return "5KM";
    if (value.startsWith("3")) return "3KM";

    return null;
}

function setConnectionStatus(text) {
    $("connectionStatus").textContent = text;
}

function setSyncMessage(text) {
    $("syncMessage").textContent = text;
}

/* =========================================
   INDEXEDDB
   ========================================= */

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const database = event.target.result;

            if (!database.objectStoreNames.contains(STORE_ENTRIES)) {
                const store = database.createObjectStore(STORE_ENTRIES, {
                    keyPath: "recordId"
                });

                store.createIndex("eventId", "eventId");
                store.createIndex("timerRole", "timerRole");
                store.createIndex("distance", "distance");
            }

            if (!database.objectStoreNames.contains(STORE_META)) {
                database.createObjectStore(STORE_META, {
                    keyPath: "key"
                });
            }

            if (!database.objectStoreNames.contains(STORE_CONFIG)) {
                database.createObjectStore(STORE_CONFIG, {
                    keyPath: "key"
                });
            }
        };

        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onerror = () => reject(request.error);
    });
}

function getFromStore(storeName, key) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(key);

        request.onsuccess = () => {
            resolve(request.result ? request.result.value : undefined);
        };

        request.onerror = () => reject(request.error);
    });
}

function getAllFromStore(storeName) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

function putInStore(storeName, key, value) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);

        const request = storeName === STORE_ENTRIES
            ? store.put(value)
            : store.put({ key, value });

        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

function addEntryToStore(entry) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_ENTRIES, "readwrite");
        const request = transaction.objectStore(STORE_ENTRIES).add(entry);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

async function persistState() {
    const savedState = {
        eventName: state.eventName,
        eventId: state.eventId,
        timerRole: state.timerRole,
        deviceLabel: state.deviceLabel,
        selectedDistance: state.selectedDistance,
        starts: state.starts,
        startHistory: state.startHistory || {},
        screen: state.screen,
        deviceSessionId: state.deviceSessionId
    };

    await putInStore(STORE_META, "appState", savedState);
}

async function restoreState() {
    const savedState = await getFromStore(STORE_META, "appState");

    if (savedState) {
        state = { ...state, ...savedState };
    }

    if (!state.startHistory || typeof state.startHistory !== "object") state.startHistory = {};

    if (!state.deviceSessionId) {
        state.deviceSessionId = createId();
    }

    state.entries = await getAllFromStore(STORE_ENTRIES);
    state.entries.forEach(entry => { if (entry.reviewRequired === undefined) entry.reviewRequired = false; });

    const cachedConfig = await getFromStore(
        STORE_CONFIG,
        CONFIG_CACHE_KEY
    );

    if (cachedConfig && Array.isArray(cachedConfig.runners)) {
        state.runners = cachedConfig.runners;
        state.configFetchedAt = cachedConfig.fetchedAt || null;
    }

    if (!["setup", "timing", "results"].includes(state.screen)) {
        state.screen = "setup";
    }
}

/* =========================================
   GOOGLE SHEETS CONFIG
   ========================================= */

async function refreshConfig() {
    if (configRefreshing || !navigator.onLine) return;

    configRefreshing = true;
    $("configStatus").textContent = "Refreshing…";

    try {
        const response = await fetch(API_URL + "?action=config", {
            method: "GET",
            cache: "no-store",
            redirect: "follow"
        });

        if (!response.ok) {
            throw new Error("Config request failed: HTTP " + response.status);
        }

        const data = await response.json();

        if (!data.success || !Array.isArray(data.runners)) {
            throw new Error(data.error || "Invalid Config response.");
        }

        const seen = new Set();

        for (const runner of data.runners) {
            const bib = normalizeBib(runner.bibNumber);

            if (!bib || seen.has(bib)) {
                throw new Error("Config contains a blank or duplicate bib: " + bib);
            }

            seen.add(bib);

            // Recalculate locally instead of blindly trusting the server value.
            runner.bibNumber = bib;
            runner.distance = detectDistance(bib);
        }

        await putInStore(STORE_CONFIG, CONFIG_CACHE_KEY, {
            runners: data.runners,
            fetchedAt: data.fetchedAt || nowIso()
        });

        state.runners = data.runners;
        state.configFetchedAt = data.fetchedAt || nowIso();

        $("configStatus").textContent =
            state.runners.length + " runners";

        setConnectionStatus("CONNECTED");
        renderBibLookup();

        setSyncMessage(
            "Config synchronized: " + state.runners.length +
            " runners. Finish records are still saved locally before upload."
        );

    } catch (error) {
        console.error("Config refresh failed:", error);

        $("configStatus").textContent = state.runners.length
            ? state.runners.length + " cached"
            : "Unavailable";

        setConnectionStatus(navigator.onLine ? "SYNC ISSUE" : "OFFLINE");

        setSyncMessage(
            state.runners.length
                ? "Using cached Config. New records can still be saved locally."
                : "Config is not available yet. Records can be saved locally, but registration cannot be verified."
        );

    } finally {
        configRefreshing = false;
    }
}

function findRunner(bib) {
    return state.runners.find(
        runner => normalizeBib(runner.bibNumber) === normalizeBib(bib)
    ) || null;
}

function updateReviewDashboardLink() {
    const link = $("reviewDashboardLink");
    const role = String(state.timerRole || "Timer1");
    try { localStorage.setItem("v5000TimerRole", role); } catch (_) { }
    if (link) link.href = "./review.html?role=" + encodeURIComponent(role);
}

/* =========================================
   SCREEN NAVIGATION
   ========================================= */

function showScreen(screen) {
    state.screen = screen;

    $("setupScreen").classList.toggle("hidden", screen !== "setup");
    $("timingScreen").classList.toggle("hidden", screen !== "timing");
    $("resultsScreen").classList.toggle("hidden", screen !== "results");

    if (screen === "timing") {
        renderStarts();
        if (navigator.onLine) refreshSharedStarts({ quiet: true });
        renderRecentEntries();
        updateCounters();
        renderBibLookup();
        focusBibInput();
    }

    if (screen === "results") {
        // Results use the last fetched snapshot. Fetch only when the user clicks Refresh.
        renderResults();
    }

    persistState().catch(console.error);
}

function focusBibInput() {
    if (window.matchMedia("(pointer: fine)").matches) {
        $("bibInput").focus({ preventScroll: true });
    }
}

/* =========================================
   RACE START TIMES
   ========================================= */

function renderStarts() {
    const grid = $("startGrid");
    grid.innerHTML = "";

    DISTANCES.forEach(distance => {
        const startedAt = state.starts[distance];

        const card = document.createElement("div");
        card.className = "start-card" + (startedAt ? " started" : "");

        const title = document.createElement("div");
        title.className = "start-distance";
        title.textContent = distance;

        const time = document.createElement("div");
        time.className = "start-time";
        time.textContent = startedAt
            ? "Started " + formatClock(startedAt)
            : "Not started";

        const button = document.createElement("button");
        button.type = "button";
        button.className = "start-button" + (startedAt ? " started" : "");
        button.textContent = startedAt ? "START RECORDED" : "START " + distance;
        button.disabled = Boolean(startedAt) || state.timerRole !== "Timer1";
        if (state.timerRole !== "Timer1") button.title = "Only Timer1 can control official race starts.";
        button.addEventListener("click", () => startDistance(distance));

        card.append(title, time, button);

        if (startedAt) {
            const actions = document.createElement("div");
            actions.className = "start-edit-actions";

            const editButton = document.createElement("button");
            editButton.type = "button";
            editButton.className = "button button-secondary start-edit-button";
            editButton.textContent = "Edit Start Time";
            editButton.disabled = state.timerRole !== "Timer1";
            editButton.addEventListener("click", () => editStartTime(distance));

            const undoButton = document.createElement("button");
            undoButton.type = "button";
            undoButton.className = "button button-secondary start-edit-button";
            undoButton.textContent = "Undo Start";
            undoButton.disabled = state.timerRole !== "Timer1";
            undoButton.addEventListener("click", () => undoStart(distance));

            actions.append(editButton, undoButton);
            card.appendChild(actions);
        }

        grid.appendChild(card);
    });
}

function getEntriesForDistance(distance) {
    return state.entries.filter(entry => entry.distance === distance);
}

function parseManilaLocalDateTime(value) {
    // datetime-local values are interpreted in the device's local timezone.
    // Race devices should be configured to Asia/Manila.
    const parsed = new Date(value);
    if (!value || Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

async function editStartTime(distance) {
    const current = state.starts[distance];
    if (!current) return;

    const currentLocal = (() => {
        const date = new Date(current);
        const pad = n => String(n).padStart(2, "0");
        return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" +
            pad(date.getDate()) + "T" + pad(date.getHours()) + ":" +
            pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    })();

    const entered = prompt(
        "Edit " + distance + " start time. Enter date/time as YYYY-MM-DDTHH:mm:ss.\n" +
        "Use the timing device's local time (set to Philippines time).\nCurrent: " + currentLocal,
        currentLocal
    );
    if (entered === null) return;

    const correctedIso = parseManilaLocalDateTime(entered.trim());
    if (!correctedIso) {
        alert("Invalid date/time. Use YYYY-MM-DDTHH:mm:ss.");
        return;
    }

    const affected = getEntriesForDistance(distance);
    const invalid = affected.filter(entry =>
        new Date(entry.finishTimestamp).getTime() < new Date(correctedIso).getTime()
    );
    if (invalid.length) {
        const proceed = confirm(
            "Warning: " + invalid.length + " finish record(s) would be earlier than this start time. " +
            "They will be marked for review and show Pending elapsed time. Continue?"
        );
        if (!proceed) return;
    }

    const confirmEdit = confirm(
        "Change the " + distance + " start time to " + entered.trim() + "?\n" +
        affected.length + " local finish record(s) will be recalculated. Original finish timestamps will not change."
    );
    if (!confirmEdit) return;

    if (!state.startHistory[distance]) state.startHistory[distance] = [];
    state.startHistory[distance].push({
        action: "EDIT",
        previousStart: current,
        newStart: correctedIso,
        changedAt: nowIso(),
        recordsAffected: affected.length
    });

    try { await saveSharedStart(distance, correctedIso, "SET"); }
    catch (error) { alert("Official start time was not changed: " + error.message); return; }

    state.starts[distance] = correctedIso;

    for (const entry of affected) {
        const elapsed = new Date(entry.finishTimestamp).getTime() - new Date(correctedIso).getTime();
        entry.startTimestamp = correctedIso;
        entry.elapsedMs = elapsed >= 0 ? elapsed : null;
        entry.elapsedTime = elapsed >= 0 ? formatElapsed(elapsed) : "";
        entry.reviewRequired = true;
        entry.notes = [entry.notes, "Start time edited; review required."].filter(Boolean).join(" ");
        await saveUpdatedEntry(entry);
    }

    await persistState();
    renderStarts();
    renderRecentEntries();
    updateCounters();
    if (state.screen === "results") renderResults();
    showMessage(distance + " start time updated. Affected results are marked for review.", "success");
}

async function undoStart(distance) {
    const current = state.starts[distance];
    if (!current) return;

    const affected = getEntriesForDistance(distance);
    const warning = affected.length
        ? "\n\n" + affected.length + " finish record(s) exist for this distance. Their finish timestamps will be kept, but elapsed time will become Pending until a start time is set again."
        : "";

    if (!confirm("Undo the " + distance + " start time? This only affects " + distance + "." + warning)) {
        return;
    }

    if (!state.startHistory[distance]) state.startHistory[distance] = [];
    state.startHistory[distance].push({
        action: "UNDO",
        previousStart: current,
        newStart: null,
        changedAt: nowIso(),
        recordsAffected: affected.length
    });

    try { await saveSharedStart(distance, "", "UNDO"); }
    catch (error) { alert("Official start time was not undone: " + error.message); return; }

    delete state.starts[distance];

    for (const entry of affected) {
        entry.startTimestamp = null;
        entry.elapsedMs = null;
        entry.elapsedTime = "";
        entry.reviewRequired = true;
        entry.notes = [entry.notes, "Start time undone; elapsed time pending; review required."].filter(Boolean).join(" ");
        await saveUpdatedEntry(entry);
    }

    await persistState();
    renderStarts();
    renderRecentEntries();
    updateCounters();
    showMessage(distance + " start undone. Finish records were preserved.", "success");
}

async function refreshSharedStarts({ quiet = true } = {}) {
    if (startSyncInProgress || !navigator.onLine || !state.eventId) return;
    startSyncInProgress = true;
    try {
        const response = await fetch(API_URL + "?action=raceStarts&eventId=" + encodeURIComponent(state.eventId) + "&t=" + Date.now(), { cache: "no-store", redirect: "follow" });
        if (!response.ok) throw new Error("Start-time request failed: HTTP " + response.status);
        const data = await response.json();
        if (!data.success || !data.starts) throw new Error(data.error || "Invalid shared start-time response.");
        const nextStarts = {};
        for (const distance of DISTANCES) {
            const value = data.starts[distance];
            if (value && !Number.isNaN(Date.parse(value))) nextStarts[distance] = new Date(value).toISOString();
        }
        const changed = JSON.stringify(state.starts || {}) !== JSON.stringify(nextStarts);
        state.starts = nextStarts;
        lastStartSyncAt = Date.now();
        await persistState();
        if (state.screen === "timing") renderStarts();
        if (changed && !quiet) showMessage("Official race start times synchronized.", "success");
    } catch (error) {
        console.warn("Shared start-time refresh failed; using cached start times.", error);
        if (!quiet && state.timerRole === "Timer1") showMessage("Could not sync start times. Cached times remain on this device.", "error");
    } finally {
        startSyncInProgress = false;
    }
}

async function saveSharedStart(distance, startTimestamp, startAction) {
    if (state.timerRole !== "Timer1") throw new Error("Only Timer1 can change official race start times.");
    if (!navigator.onLine) throw new Error("Connect to the internet before changing an official start time. No shared change was made.");
    const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "saveRaceStart", actorRole: state.timerRole, timerRole: state.timerRole, eventId: state.eventId, distance, startTimestamp: startTimestamp || "", startAction })
    });
    if (!response.ok) throw new Error("Could not save official start time: HTTP " + response.status);
    const data = await response.json();
    if (!data.success) throw new Error(data.error || "Could not save official start time.");
    return data;
}

async function startDistance(distance) {
    if (state.starts[distance]) return;

    if (state.timerRole !== "Timer1") {
        showMessage("Only Timer1 can start the official race clock.", "error");
        return;
    }
    const timestamp = nowIso();

    try {
        await saveSharedStart(distance, timestamp, "SET");
        state.starts[distance] = timestamp;
        await persistState();
        renderStarts();
        showMessage(distance + " start saved at " + formatClock(timestamp), "success");
    } catch (error) {
        // Keep the official start unset locally unless the backend confirms it was saved.
        delete state.starts[distance];
        console.error("Official race start save failed:", error);
        showMessage("START NOT SAVED: " + (error && error.message ? error.message : String(error)) + ". Check Apps Script deployment and connection.", "error");
    }
}

/* =========================================
   BIB LOOKUP
   ========================================= */

function renderBibLookup() {
    const bib = normalizeBib($("bibInput").value);
    const distanceElement = $("detectedDistance");
    const runnerElement = $("detectedRunner");
    const statusElement = $("registrationStatus");

    if (!bib) {
        distanceElement.textContent = "—";
        runnerElement.textContent = "Enter a bib number";
        statusElement.textContent = state.runners.length
            ? "Ready"
            : "Config unavailable";
        return;
    }

    const distance = detectDistance(bib);
    const runner = findRunner(bib);

    distanceElement.textContent = distance || "Unknown";
    runnerElement.textContent = runner
        ? runner.name || runner.bibNumber
        : "Not found in Config";

    if (runner) {
        statusElement.textContent = "REGISTERED";
    } else if (distance) {
        statusElement.textContent = "UNREGISTERED / REVIEW";
    } else {
        statusElement.textContent = "UNKNOWN BIB FORMAT";
    }
}

/* =========================================
   BIB ENTRY AND LOCAL SAVING
   ========================================= */

function showMessage(message, type = "") {
    const element = $("entryMessage");
    element.textContent = message;
    element.className = "entry-message" + (type ? " " + type : "");
}

function appendBibDigit(digit) {
    const input = $("bibInput");

    if (input.value.length >= 12) {
        showMessage("Maximum bib length reached.", "error");
        return;
    }

    input.value += digit;
    renderBibLookup();
    showMessage("Ready to record.");
}

function backspaceBib() {
    $("bibInput").value = $("bibInput").value.slice(0, -1);
    renderBibLookup();
}

async function submitBib() {
    if (submitting) return;

    const bib = normalizeBib($("bibInput").value);

    if (!bib) {
        showMessage("Enter a bib number first.", "error");
        return;
    }

    const distance = detectDistance(bib);

    if (!distance) {
        showMessage(
            "Cannot determine distance from this bib. Record not saved.",
            "error"
        );
        return;
    }

    const runner = findRunner(bib);
    const finishTimestamp = nowIso();
    const startTimestamp = state.starts[distance] || null;

    const elapsedMs = startTimestamp
        ? new Date(finishTimestamp).getTime() -
        new Date(startTimestamp).getTime()
        : null;

    if (elapsedMs !== null && elapsedMs < 0) {
        showMessage(
            "Finish time is earlier than the saved start time. Check device clock.",
            "error"
        );
        return;
    }

    const entry = {
        recordId: createId(),
        eventId: state.eventId,
        eventName: state.eventName,
        timerRole: state.timerRole,
        deviceSessionId: state.deviceSessionId,
        deviceLabel: state.deviceLabel,

        bibNumber: bib,
        distance,

        runnerName: runner ? runner.name : "",
        category: runner ? runner.category : "",
        gender: runner ? runner.gender : "",
        registrationStatus: runner ? "registered" : "unregistered-review",

        finishTimestamp,
        startTimestamp,
        elapsedMs,
        elapsedTime: elapsedMs === null ? "" : formatElapsed(elapsedMs),

        entryTimestamp: finishTimestamp,
        recordStatus: "normal",
        reviewRequired: false,
        syncStatus: "pending",
        notes: runner ? "" : "Bib not found in cached Config; review required."
    };

    submitting = true;

    const enterButton = document.querySelector('[data-key="enter"]');
    enterButton.disabled = true;

    try {
        // Local write completes before we report success.
        await addEntryToStore(entry);

        state.entries.push(entry);

        $("bibInput").value = "";
        renderBibLookup();
        renderRecentEntries();
        updateCounters();

        showMessage(
            "SAVED LOCALLY · Bib " + bib + " · " + distance +
            (entry.elapsedTime ? " · " + entry.elapsedTime : " · Start not recorded"),
            "success"
        );

        await persistState();

    } catch (error) {
        console.error(error);
        showMessage(
            "SAVE FAILED. Do not assume this record was stored. Try again.",
            "error"
        );

    } finally {
        submitting = false;
        enterButton.disabled = false;
        focusBibInput();
    }
}

/* =========================================
   COUNTERS AND RECENT ENTRIES
   ========================================= */

function updateCounters() {
    $("savedCount").textContent = String(state.entries.length);

    $("pendingCount").textContent = String(
        state.entries.filter(entry => entry.syncStatus !== "synced").length
    );

    $("configStatus").textContent = state.runners.length
        ? state.runners.length + " runners"
        : "Unavailable";
}

function renderRecentEntries() {
    const container = $("recentEntries");
    container.innerHTML = "";

    const recent = [...state.entries]
        .sort((a, b) => b.entryTimestamp.localeCompare(a.entryTimestamp))
        .slice(0, 10);

    if (!recent.length) {
        container.innerHTML =
            '<div class="empty-state">No finishers recorded yet.</div>';
        return;
    }

    recent.forEach(entry => {
        const row = document.createElement("div");
        row.className = "recent-row";

        const main = document.createElement("div");

        const title = document.createElement("div");
        title.className = "recent-main";
        title.textContent = "Bib " + entry.bibNumber +
            (entry.registrationStatus === "registered" ? "" : " ⚠");

        const detail = document.createElement("div");
        detail.className = "recent-detail";
        detail.textContent =
            entry.distance + " · " + entry.timerRole +
            " · " + formatClock(entry.finishTimestamp) +
            " · " + (entry.syncStatus === "synced" ? "Uploaded" : "Pending upload");

        main.append(title, detail);

        const time = document.createElement("div");
        time.className = "recent-time";
        time.textContent = entry.elapsedTime || "Pending";

        row.append(main, time);
        container.appendChild(row);
    });
}

/* =========================================
   GOOGLE SHEETS UPLOAD
   ========================================= */

/*
 * This sends text/plain to avoid a JSON content-type preflight.
 * The Apps Script deployment must be accessible to the browser.
 */
async function postToAppsScript(payload) {
    const response = await fetch(API_URL, {
        method: "POST",
        redirect: "follow",
        headers: {
            "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error("Upload HTTP error: " + response.status);
    }

    const result = await response.json();

    if (!result || typeof result.success !== "boolean") {
        throw new Error("Unexpected upload response.");
    }

    return result;
}

async function saveUpdatedEntry(entry) {
    await putInStore(STORE_ENTRIES, entry.recordId, entry);

    const index = state.entries.findIndex(
        item => item.recordId === entry.recordId
    );

    if (index >= 0) {
        state.entries[index] = entry;
    }
}

async function submitPendingRecords() {
    if (submitting) return;
    const pending = state.entries.filter(entry => entry.syncStatus !== "synced");
    if (!pending.length) { alert("There are no pending records to upload."); return; }
    if (!navigator.onLine) { alert("You are offline. Records remain saved locally."); return; }

    submitting = true;
    $("submitButton").disabled = true;
    setConnectionStatus("UPLOADING");
    setSyncMessage("Uploading pending records by their saved timer role. Keep the app open.");

    let confirmedCount = 0;
    const failures = [];
    try {
        const groups = new Map();
        for (const entry of pending) {
            const role = String(entry.timerRole || "").trim();
            if (!/^Timer[1-5]$/.test(role)) {
                failures.push("Bib " + entry.bibNumber + ": invalid saved timer role.");
                continue;
            }
            if (!groups.has(role)) groups.set(role, []);
            groups.get(role).push(entry);
        }

        for (const [role, entries] of groups.entries()) {
            for (let offset = 0; offset < entries.length; offset += 100) {
                const batch = entries.slice(offset, offset + 100);
                const payload = {
                    action: "uploadRecords",
                    timerRole: role,
                    records: batch.map(entry => ({
                        recordId: entry.recordId,
                        eventId: entry.eventId || state.eventId,
                        timerRole: entry.timerRole,
                        bibNumber: String(entry.bibNumber),
                        distance: entry.distance,
                        finishTimestamp: entry.finishTimestamp,
                        elapsedTime: entry.elapsedTime || "",
                        entryTimestamp: entry.entryTimestamp || "",
                        deviceSessionId: entry.deviceSessionId || state.deviceSessionId,
                        notes: entry.notes || ""
                    }))
                };
                let result;
                try {
                    result = await postToAppsScript(payload);
                } catch (error) {
                    failures.push(role + ": " + error.message);
                    continue;
                }
                const accepted = new Set(result.accepted || []);
                const duplicates = new Set(result.duplicates || []);
                const conflicts = new Set(result.conflicts || []);
                for (const entry of batch) {
                    const id = String(entry.recordId);
                    if (conflicts.has(id)) {
                        failures.push(role + ": record ID conflict for " + id);
                        continue;
                    }
                    if (accepted.has(id) || duplicates.has(id)) {
                        entry.syncStatus = "synced";
                        entry.syncedAt = nowIso();
                        await saveUpdatedEntry(entry);
                        confirmedCount++;
                    } else {
                        failures.push(role + ": server did not confirm record " + id);
                    }
                }
                if (result.success !== true && !(result.conflicts || []).length) {
                    failures.push(role + ": " + (result.error || result.message || "server reported incomplete success."));
                }
            }
        }

        renderRecentEntries();
        updateCounters();
        if (failures.length) {
            setConnectionStatus("SYNC ISSUE");
            setSyncMessage(confirmedCount + " confirmed; " + failures.length + " issue(s). Unconfirmed records remain queued.");
            alert("Upload partially completed.\n\nConfirmed: " + confirmedCount + "\nIssues: " + failures.length + "\n\n" + failures.slice(0, 8).join("\n") + (failures.length > 8 ? "\nMore issues omitted." : "") + "\n\nUnconfirmed records remain saved locally.");
        } else {
            setConnectionStatus("CONNECTED");
            setSyncMessage("Upload confirmed for " + confirmedCount + " record(s).");
            alert("Upload complete. Confirmed records: " + confirmedCount);
        }
    } catch (error) {
        console.error("Upload failed:", error);
        setConnectionStatus(navigator.onLine ? "SYNC ISSUE" : "OFFLINE");
        setSyncMessage("Upload interrupted. Unconfirmed records remain queued. " + error.message);
        alert("Upload interrupted.\n\n" + error.message + "\n\nUnconfirmed records remain saved locally.");
    } finally {
        submitting = false;
        $("submitButton").disabled = false;
        renderRecentEntries();
        updateCounters();
    }
}

function getAvailableCategories() {
    const values = new Set();
    state.runners.forEach(runner => {
        const value = String(runner.category || "").trim();
        if (value) values.add(value);
    });
    if (serverReviewData && Array.isArray(serverReviewData.categories)) {
        serverReviewData.categories.forEach(value => {
            value = String(value || "").trim();
            if (value) values.add(value);
        });
    }
    state.entries.forEach(entry => {
        const runner = findRunner(entry.bibNumber);
        const value = String((runner && runner.category) || entry.category || "").trim();
        if (value) values.add(value);
    });
    return [...values].sort((a, b) => a.localeCompare(b));
}

function populateCategories() {
    const container = $("resultsCategoryTabs");
    if (!container) return;
    const categories = getAvailableCategories();
    const allowed = ["ALL", ...categories];
    if (!allowed.includes(selectedResultsCategory)) selectedResultsCategory = "ALL";

    container.innerHTML = "";
    const items = [{ value: "ALL", label: "All Categories" }, ...categories.map(c => ({ value: c, label: c }))];
    items.forEach(item => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "filter-tab" + (selectedResultsCategory === item.value ? " active" : "");
        button.dataset.category = item.value;
        button.setAttribute("aria-pressed", selectedResultsCategory === item.value ? "true" : "false");
        button.textContent = item.label;
        container.appendChild(button);
    });
}

function renderSourceTabs() {
    const container = $("resultsSourceTabs");
    if (!container) return;
    container.querySelectorAll("[data-source]").forEach(button => {
        const active = button.dataset.source === selectedResultsSource;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
    });
}

function parseElapsedForResults(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!match) return null;
    const fraction = Number((match[4] || "0").padEnd(3, "0"));
    return ((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000) + fraction;
}

function restoreResultsSnapshot() {
    if (serverReviewData) return;
    try {
        const raw = localStorage.getItem("v5000LastReviewSnapshot");
        if (!raw) return;
        const cached = JSON.parse(raw);
        if (cached && cached.success === true && Array.isArray(cached.records) && Array.isArray(cached.consolidated)) {
            serverReviewData = cached;
            populateCategories();
            renderSourceTabs();
            const refreshed = $("resultsLastRefreshed");
            if (refreshed) refreshed.textContent = "Last refreshed: " + new Date(cached.fetchedAt || Date.now()).toLocaleString() + " · saved snapshot";
        }
    } catch (error) { console.warn("Could not restore cached results snapshot", error); }
}

async function refreshResultsFromSheets(options = {}) {
    if (resultsRefreshing) return;
    if (!navigator.onLine) {
        resultsRefreshError = "Offline. Showing the last fetched server data or local records.";
        renderResults();
        return;
    }

    resultsRefreshing = true;
    resultsRefreshError = "";
    const button = $("refreshResultsButton");
    const refreshed = $("resultsLastRefreshed");
    if (button) {
        button.disabled = true;
        button.textContent = "Refreshing…";
    }
    if (refreshed) refreshed.textContent = "Fetching latest Google Sheets data…";

    try {
        const eventId = String(state.eventId || "").trim();
        const url = API_URL + "?action=reviewData" +
            (eventId ? "&eventId=" + encodeURIComponent(eventId) : "") +
            "&_=" + Date.now();
        const response = await fetch(url, {
            method: "GET",
            cache: "no-store",
            redirect: "follow"
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        if (!data || data.success !== true || !Array.isArray(data.records) || !Array.isArray(data.consolidated)) {
            throw new Error((data && data.error) || "Unexpected review-data response.");
        }
        serverReviewData = data;
        try { localStorage.setItem("v5000LastReviewSnapshot", JSON.stringify(data)); } catch (_) { }
        resultsRefreshError = "";
        populateCategories();
        renderSourceTabs();
        const stamp = new Date(data.fetchedAt || Date.now());
        if (refreshed) refreshed.textContent = "Last refreshed: " + stamp.toLocaleString();
        if (button) button.textContent = "↻ Refresh from Sheets";
        setConnectionStatus("CONNECTED");
        renderResults();
    } catch (error) {
        console.error("Results refresh failed:", error);
        resultsRefreshError = "Could not refresh from Google Sheets: " + error.message;
        if (refreshed) refreshed.textContent = "Refresh failed · previous data retained";
        if (button) button.textContent = "↻ Retry refresh";
        setConnectionStatus(navigator.onLine ? "SYNC ISSUE" : "OFFLINE");
        renderResults();
        if (!options.quiet) alert(resultsRefreshError + "\n\nExisting local records were not deleted.");
    } finally {
        resultsRefreshing = false;
        if (button) button.disabled = false;
    }
}

function renderResults() {
    restoreResultsSnapshot();
    const distance = $("resultsDistance").value;
    const category = selectedResultsCategory;
    const gender = $("resultsGender").value;
    const source = selectedResultsSource;
    let results = [];
    let usingServer = Boolean(serverReviewData);

    if (source === "CONSOLIDATED") {
        if (serverReviewData) {
            results = serverReviewData.consolidated.map(item => ({
                recordId: item.selectedRecordId || "",
                eventId: item.eventId || "",
                bibNumber: String(item.bibNumber || ""),
                runnerName: item.name || "Unregistered",
                category: item.category || "Unclassified",
                gender: item.gender || "Unknown",
                distance: item.distance || "",
                timerRole: item.selectedTimer || "—",
                elapsedTime: item.elapsedTime || "Pending",
                elapsedMs: parseElapsedForResults(item.elapsedTime),
                recordStatus: item.selectionStatus || "PROVISIONAL",
                reviewRequired: item.selectionStatus !== "FINAL",
                notes: item.notes || ""
            }));
        }
    } else if (serverReviewData) {
        results = serverReviewData.records
            .filter(entry => source === "ALL" || entry.timerRole === source)
            .map(entry => ({
                ...entry,
                runnerName: entry.runnerName || "Unregistered",
                elapsedMs: entry.elapsedMs === null || entry.elapsedMs === undefined
                    ? parseElapsedForResults(entry.elapsedTime)
                    : Number(entry.elapsedMs),
                recordStatus: entry.status || entry.recordStatus || "",
                reviewRequired: Boolean(entry.issues && entry.issues.length)
            }));
    } else {
        // Offline/initial fallback: show this device's local observations only.
        results = state.entries.filter(entry => source === "ALL" || entry.timerRole === source);
        usingServer = false;
    }

    results = results.filter(entry => {
        if (entry.distance !== distance) return false;
        if (entry.elapsedMs === null || !Number.isFinite(entry.elapsedMs) || entry.elapsedMs < 0) return false;
        if (source === "CONSOLIDATED" && !entry.recordId) return false;
        const runner = findRunner(entry.bibNumber);
        const actualCategory = String((runner && runner.category) || entry.category || "").trim();
        const actualGender = String((runner && runner.gender) || entry.gender || "").trim();
        if (category !== "ALL" && actualCategory !== category) return false;
        if (gender !== "ALL" && actualGender.toLowerCase() !== gender.toLowerCase()) return false;
        if (!usingServer && entry.recordStatus && entry.recordStatus !== "normal") return false;
        return true;
    });

    results.sort((a, b) => a.elapsedMs - b.elapsedMs || String(a.bibNumber).localeCompare(String(b.bibNumber), undefined, { numeric: true }));
    const wrap = $("resultsTableWrap");
    wrap.innerHTML = "";

    if (!results.length) {
        const message = source === "CONSOLIDATED"
            ? (serverReviewData ? "No consolidated results have been selected for this distance yet. Open Validation & Correction to select a candidate." : "Consolidated results have not been fetched yet. Click Refresh from Sheets.")
            : (usingServer ? "No server records match these filters." : "No local records match these filters. Refresh from Sheets to fetch observations from all timer devices.");
        wrap.innerHTML = '<div class="empty-state">' + message + '</div>';
    } else {
        const table = document.createElement("table");
        table.className = "results-table";
        const thead = document.createElement("thead");
        thead.innerHTML = "<tr><th>Rank</th><th>Bib</th><th>Name</th><th>Category</th><th>Gender</th><th>Time</th><th>Timer / Status</th></tr>";
        const tbody = document.createElement("tbody");
        results.forEach((entry, index) => {
            const row = document.createElement("tr");
            const runner = findRunner(entry.bibNumber);
            const timerLabel = source === "CONSOLIDATED"
                ? (entry.timerRole + " · " + (entry.recordStatus || "PROVISIONAL"))
                : (entry.timerRole + (entry.reviewRequired ? " · REVIEW" : (entry.recordStatus ? " · " + entry.recordStatus : "")));
            const values = [
                String(index + 1), entry.bibNumber,
                entry.runnerName || (runner && runner.name) || "Unregistered",
                entry.category || (runner && runner.category) || "Unclassified",
                entry.gender || (runner && runner.gender) || "Unknown",
                (Number.isFinite(entry.elapsedMs) && entry.elapsedMs >= 0 ? formatElapsed(entry.elapsedMs) : (entry.elapsedTime || "Pending")), timerLabel
            ];
            values.forEach((value, col) => {
                const cell = document.createElement("td");
                cell.textContent = value;
                if (col === 0) cell.className = "rank-number";
                row.appendChild(cell);
            });
            tbody.appendChild(row);
        });
        table.append(thead, tbody);
        wrap.appendChild(table);
    }

    const sourceLabel = source === "CONSOLIDATED" ? "consolidated selected result(s)" :
        (source === "ALL" ? "raw observation(s) across all timer sheets" : "raw observation(s) from " + source);
    let message = results.length + " " + sourceLabel + ". " +
        (source === "CONSOLIDATED" ? "Only race-director-selected results are shown." : "Multiple observations for the same bib are expected when timers are compared.");
    if (!usingServer) message += " Local-only fallback; click Refresh from Sheets to fetch other devices' uploaded records.";
    if (resultsRefreshError) message += " " + resultsRefreshError;
    if (results.some(entry => entry.reviewRequired)) message += " Some observations are flagged for review.";
    $("resultsMessage").textContent = message;
}

function exportCsv() {
    const columns = [
        "recordId",
        "eventId",
        "timerRole",
        "deviceSessionId",
        "bibNumber",
        "distance",
        "runnerName",
        "category",
        "gender",
        "registrationStatus",
        "finishTimestamp",
        "startTimestamp",
        "elapsedTime",
        "entryTimestamp",
        "recordStatus",
        "reviewRequired",
        "syncStatus",
        "notes"
    ];

    const escapeCsv = value =>
        '"' + String(value ?? "").replace(/"/g, '""') + '"';

    const lines = [
        columns.join(","),
        ...state.entries.map(entry =>
            columns.map(column => escapeCsv(entry[column])).join(",")
        )
    ];

    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
        type: "text/csv;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download =
        "velocity5000-" + state.timerRole + "-backup.csv";

    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =========================================
   SETUP AND EVENTS
   ========================================= */

async function continueToTiming() {
    // This first release is dedicated to one shared event across all devices.
    // Timer assignment remains device-specific.
    state.eventName = FIXED_EVENT_NAME;
    state.eventId = FIXED_EVENT_ID;
    state.timerRole = $("timerRole").value;
    state.deviceLabel = $("deviceLabel").value.trim();
    updateReviewDashboardLink();

    $("timingEventLabel").textContent = state.eventName.toUpperCase();
    $("timingRoleLabel").textContent = state.timerRole;
    $("deviceLabelDisplay").textContent =
        state.deviceLabel || "Timing device";

    await persistState();
    showScreen("timing");

    // Refresh Config in the background; do not block timing.
    refreshConfig();
}

function bindEvents() {
    $("continueButton").addEventListener("click", () => {
        continueToTiming().catch(error => {
            console.error(error);
            alert("Could not save setup: " + error.message);
        });
    });

    $("changeSetupButton").addEventListener("click", () => {
        $("eventPreset").value = FIXED_EVENT_ID;
        $("timerRole").value = state.timerRole;
        $("deviceLabel").value = state.deviceLabel;
        showScreen("setup");
    });

    $("keypad").addEventListener("click", event => {
        const button = event.target.closest("button[data-key]");
        if (!button) return;

        const key = button.dataset.key;

        if (key === "backspace") {
            backspaceBib();
        } else if (key === "enter") {
            submitBib();
        } else if (/^\d$/.test(key)) {
            appendBibDigit(key);
        }
    });

    // Keep native mobile keyboard out of the way.
    // Physical keyboard input is handled explicitly on desktop.
    $("bibInput").setAttribute("inputmode", "none");

    $("bibInput").addEventListener("input", () => {
        renderBibLookup();
    });

    // Laptop keyboard support.
    document.addEventListener("keydown", event => {
        if (state.screen !== "timing") return;
        if (event.ctrlKey || event.altKey || event.metaKey) return;

        const active = document.activeElement;
        const isBibField = active === $("bibInput");

        if (active && active.matches("input, textarea, select") && !isBibField) {
            return;
        }

        if (/^\d$/.test(event.key)) {
            event.preventDefault();
            appendBibDigit(event.key);
        } else if (event.key === "Backspace") {
            event.preventDefault();
            backspaceBib();
        } else if (event.key === "Enter") {
            event.preventDefault();
            submitBib();
        }
    });

    $("resultsButton").addEventListener("click", () => {
        populateCategories();
        renderSourceTabs();
        showScreen("results");
    });

    $("refreshResultsButton").addEventListener("click", () => {
        refreshResultsFromSheets({ quiet: false });
    });

    $("backToTimingButton").addEventListener("click", () => {
        showScreen("timing");
    });

    $("backToTimingButtonBottom").addEventListener("click", () => {
        showScreen("timing");
    });

    ["resultsDistance", "resultsGender"].forEach(id => {
        $(id).addEventListener("change", renderResults);
    });

    $("resultsSourceTabs").addEventListener("click", event => {
        const button = event.target.closest("button[data-source]");
        if (!button) return;
        selectedResultsSource = button.dataset.source;
        renderSourceTabs();
        renderResults();
    });

    $("resultsCategoryTabs").addEventListener("click", event => {
        const button = event.target.closest("button[data-category]");
        if (!button) return;
        selectedResultsCategory = button.dataset.category;
        populateCategories();
        renderResults();
    });

    $("exportButton").addEventListener("click", exportCsv);
    $("submitButton").addEventListener("click", submitPendingRecords);

    window.addEventListener("online", () => {
        setConnectionStatus("CONNECTED");
        refreshConfig();
        refreshSharedStarts({ quiet: true });

        // Do not silently upload without the operator initiating Submit Data.
        setSyncMessage("Connection restored. Review pending records and select Submit Data.");
    });

    window.addEventListener("offline", () => {
        setConnectionStatus("OFFLINE");
        setSyncMessage("Offline. New records will continue to be saved locally.");
    });

    // Periodically refresh Config when online.
    window.setInterval(() => {
        if (navigator.onLine) {
            refreshConfig();
            if (state.screen === "timing") refreshSharedStarts({ quiet: true });
        }
    }, START_SYNC_INTERVAL_MS);
}

/* =========================================
   INITIALIZATION
   ========================================= */

async function initialize() {
    try {
        await openDatabase();
        await restoreState();
        if (new URLSearchParams(window.location.search).get("screen") === "timing") {
            state.screen = "timing";
        }
        // Pin this build to the agreed event. Keep timer role/device label local.
        // Existing queued records retain their original event IDs; new records use this event.
        state.eventName = FIXED_EVENT_NAME;
        state.eventId = FIXED_EVENT_ID;
        updateReviewDashboardLink();

        bindEvents();

        $("eventPreset").value = FIXED_EVENT_ID;
        $("timerRole").value = state.timerRole;
        $("deviceLabel").value = state.deviceLabel;

        if (state.screen === "timing" || state.screen === "results") {
            $("timingEventLabel").textContent = state.eventName.toUpperCase();
            $("timingRoleLabel").textContent = state.timerRole;
            $("deviceLabelDisplay").textContent =
                state.deviceLabel || "Timing device";

            showScreen(state.screen);
        } else {
            showScreen("setup");
        }

        updateCounters();
        renderRecentEntries();
        renderBibLookup();

        if (state.runners.length) {
            $("configStatus").textContent =
                state.runners.length + " cached";
        }

        if (navigator.onLine) {
            refreshConfig();
        } else {
            setConnectionStatus("OFFLINE");

            setSyncMessage(
                state.runners.length
                    ? "Offline. Using cached Config; records are saved locally."
                    : "Offline with no cached Config. Records can be saved locally, but registrations cannot be verified."
            );
        }

        if (navigator.onLine) refreshSharedStarts({ quiet: true });

        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().catch(() => { });
        }

    } catch (error) {
        console.error(error);

        document.body.innerHTML = `
      <main style="padding:24px;font-family:Arial,sans-serif">
        <h1>Unable to initialize timing storage</h1>
        <p>Do not use this session for race timing until local storage works.</p>
        <pre style="white-space:pre-wrap"></pre>
      </main>
    `;

        document.querySelector("pre").textContent = String(error);
    }
}

initialize();

/* Service worker registration */
if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js")
            .catch(error => console.error("Service worker registration failed:", error));
    });
}