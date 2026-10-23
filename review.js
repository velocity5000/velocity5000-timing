"use strict";

const API_URL = "https://script.google.com/macros/s/AKfycbw5ndFNEjmqsRhqcdYDqBRAlzTFWUnufJ-Q6IxidBDSqu4Gt-ReD1HaaBqaMmsnSEhyBQ/exec";
const $ = id => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const actorRole = params.get("role") || localStorage.getItem("v5000TimerRole") || "READ_ONLY";
const canEdit = actorRole === "Timer1";
let reviewData = { records: [], consolidated: [], eventIds: [], distances: [], categories: [], genders: [] };
let groupsByKey = new Map();
let selectedGroups = new Set();
let activeDialogKey = null;
let pendingCandidateId = "";
let loading = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
function keyFor(eventId, distance, bib) { return [eventId || "", distance || "", bib || ""].join("\u001f"); }
function setMessage(message, error = false) {
  $("statusMessage").textContent = message;
  $("statusMessage").style.color = error ? "#fca5a5" : "";
}
function formatElapsed(value) {
  if (value === null || value === undefined || value === "") return "—";
  const raw = String(value).trim();
  const match = raw.match(/^(?:(\d+):)?([0-5]?\d):([0-5]?\d)(?:\.(\d+))?$/);
  if (!match) return raw;
  const hours = Number(match[1] || 0), minutes = Number(match[2] || 0), seconds = Number(match[3] || 0);
  // Preserve supplied milliseconds; legacy centisecond values are padded, not invented.
  const fraction = (match[4] || "0").padEnd(3, "0").slice(0, 3);
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + fraction;
}
function formatFinishClock(value) {
  if (!value || isNaN(Date.parse(value))) return "—";
  const date = new Date(value);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", fractionalSecondDigits: 3
    }).formatToParts(date);
    const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${p.hour || "00"}:${p.minute || "00"}:${p.second || "00"}.${p.fractionalSecond || "000"}`;
  } catch (_) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date) + "." + String(date.getMilliseconds()).padStart(3, "0");
  }
}
function actorPayload(payload) { return { ...payload, actorRole: actorRole, actor: actorRole }; }
async function getReviewData() {
  if (loading) return;
  loading = true;
  const button = $("refreshButton");
  button.disabled = true;
  button.textContent = "Refreshing…";
  setMessage("Fetching latest timer sheets…");
  try {
    // Fetch all events; event/category/distance filters are applied locally so they remain stable.
    const url = API_URL + "?action=reviewData&_=" + Date.now();
    const response = await fetch(url, { method: "GET", cache: "no-store", redirect: "follow" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    if (!data || data.success !== true || !Array.isArray(data.records) || !Array.isArray(data.consolidated)) {
      throw new Error((data && data.error) || "Unexpected review-data response.");
    }
    reviewData = data;
    try { localStorage.setItem("v5000LastReviewSnapshot", JSON.stringify(data)); } catch (_) { }
    $("connectionStatus").textContent = "CONNECTED";
    populateFilters();
    renderAll();
    const refreshed = new Date(data.fetchedAt || Date.now()).toLocaleString();
    setMessage("Loaded " + data.records.length + " observations · Refreshed " + refreshed + ".");
  } catch (error) {
    console.error(error);
    $("connectionStatus").textContent = navigator.onLine ? "SYNC ISSUE" : "OFFLINE";
    setMessage("Could not refresh from Sheets: " + error.message, true);
  } finally {
    loading = false;
    button.disabled = false;
    button.textContent = "↻ Refresh from Sheets";
  }
}
function populateFilters() {
  fillSelect("eventFilter", "All events", [...new Set((reviewData.eventIds || []).filter(Boolean))].sort());
  const categories = new Set([...(reviewData.categories || []), ...(reviewData.records || []).map(r => r.category || "")].map(v => String(v || "").trim()).filter(Boolean));
  fillSelect("categoryFilter", "All categories", [...categories].sort((a,b) => a.localeCompare(b)));
  const genders = new Set([...(reviewData.genders || []), ...(reviewData.records || []).map(r => r.gender || "")].map(v => String(v || "").trim()).filter(Boolean));
  fillSelect("genderFilter", "All genders", [...genders].sort((a,b) => a.localeCompare(b)));
}
function fillSelect(id, allLabel, values) {
  const select = $(id), previous = select.value || "ALL";
  select.innerHTML = "";
  const all = document.createElement("option"); all.value = id === "eventFilter" ? "" : "ALL"; all.textContent = allLabel; select.appendChild(all);
  values.forEach(value => { const option = document.createElement("option"); option.value = value; option.textContent = value; select.appendChild(option); });
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}
function buildGroups() {
  const groups = new Map();
  (reviewData.records || []).forEach(record => {
    const key = keyFor(record.eventId, record.distance, record.bibNumber);
    if (!groups.has(key)) groups.set(key, { key, eventId: record.eventId, distance: record.distance, bibNumber: record.bibNumber, records: [] });
    groups.get(key).records.push(record);
  });
  const consolidated = new Map();
  (reviewData.consolidated || []).forEach(item => consolidated.set(keyFor(item.eventId, item.distance, item.bibNumber), item));
  groups.forEach(group => {
    group.records.sort((a,b) => {
      const rank = (a.timerRole === "Timer1" ? 0 : 1) - (b.timerRole === "Timer1" ? 0 : 1);
      if (rank) return rank;
      const at = Number.isFinite(a.elapsedMs) ? a.elapsedMs : Infinity;
      const bt = Number.isFinite(b.elapsedMs) ? b.elapsedMs : Infinity;
      return at - bt;
    });
    group.activeRecords = group.records.filter(r => !r.excluded);
    group.selected = consolidated.get(group.key) || null;
    group.selectedRecord = group.selected && group.selected.selectedRecordId
      ? group.records.find(r => r.recordId === group.selected.selectedRecordId) || null : null;
    group.status = getGroupStatus(group);
  });
  return groups;
}
function getGroupStatus(group) {
  if (!group.activeRecords.length) return "EXCLUDED";
  if (group.activeRecords.some(r => (r.issues || []).includes("INVALID_BIB") || (r.issues || []).includes("INVALID_BIB_FORMAT"))) return "INVALID BIB";
  if (group.activeRecords.some(r => (r.issues || []).includes("DISTANCE_MISMATCH") || (r.issues || []).includes("INVALID_OR_MISSING_ELAPSED_TIME") || (r.issues || []).includes("INVALID_FINISH_TIMESTAMP"))) return "NEEDS REVIEW";
  if (group.selected && group.selected.selectionStatus === "FINAL") return "FINAL";
  const selectedId = group.selected && String(group.selected.selectedRecordId || "");
  const selectedBy = group.selected && String(group.selected.updatedBy || "");
  const humanConfirmed = Boolean(selectedId) && !/^AUTO:/i.test(selectedBy);
  if (humanConfirmed && group.selected.selectedTimer !== "Timer1") return "SELECTED BACKUP";
  if (humanConfirmed) return "SELECTED";
  if (group.activeRecords.some(r => (r.issues || []).includes("POSSIBLE_PREMATURE_ENTRY"))) return "POSSIBLE PREMATURE ENTRY";
  if (group.activeRecords.some(r => (r.issues || []).includes("DUPLICATE_CANDIDATE"))) return "DUPLICATE CANDIDATE";
  if (!group.activeRecords.some(r => r.timerRole === "Timer1")) return "MISSING PRIMARY";
  if (group.selected && group.selected.selectedRecordId) return "SELECTED";
  return "NEEDS REVIEW";
}
function statusPill(status) {
  let cls = "";
  if (status === "VALID" || status === "SELECTED") cls = "valid";
  else if (status === "FINAL") cls = "valid";
  else if (status === "EXCLUDED") cls = "excluded";
  else if (status === "PROVISIONAL") cls = "provisional";
  return '<span class="issue-pill ' + cls + '">' + escapeHtml(status) + '</span>';
}
function groupMatches(group) {
  const event = $("eventFilter").value;
  const distance = $("distanceFilter").value;
  const status = $("statusFilter").value;
  const category = $("categoryFilter").value;
  const gender = $("genderFilter").value;
  if (event && group.eventId !== event) return false;
  if (distance !== "ALL" && group.distance !== distance) return false;
  if (category !== "ALL" && !group.records.some(r => r.category === category)) return false;
  if (gender !== "ALL" && !group.records.some(r => String(r.gender || "").toLowerCase() === gender.toLowerCase())) return false;
  const issueRecords = group.activeRecords.filter(r => (r.issues || []).length);
  if (status === "ISSUES" && !issueRecords.length && !["DUPLICATE CANDIDATE", "MISSING PRIMARY", "INVALID BIB", "NEEDS REVIEW"].includes(group.status)) return false;
  if (status === "DUPLICATE_CANDIDATE" && group.status !== "DUPLICATE CANDIDATE") return false;
  if (status === "MISSING_PRIMARY" && group.status !== "MISSING PRIMARY") return false;
  if (status === "INVALID_BIB" && group.status !== "INVALID BIB") return false;
  if (status === "EXCLUDED" && group.status !== "EXCLUDED") return false;
  if (status === "VALID" && !["SELECTED", "SELECTED BACKUP", "FINAL"].includes(group.status)) return false;
  return true;
}
function renderStats() {
  const groups = [...groupsByKey.values()];
  const stats = [
    ["Raw observations", reviewData.records.length],
    ["Unique bib results", groups.length],
    ["Needs review", groups.filter(g => ["DUPLICATE CANDIDATE", "MISSING PRIMARY", "INVALID BIB", "NEEDS REVIEW"].includes(g.status)).length],
    ["Duplicate bibs", groups.filter(g => g.status === "DUPLICATE CANDIDATE").length],
    ["Invalid bibs", groups.filter(g => g.status === "INVALID BIB").length],
    ["Excluded bibs", groups.filter(g => g.status === "EXCLUDED").length]
  ];
  $("stats").innerHTML = stats.map(([label,value]) => '<div class="stat-card"><span>' + escapeHtml(label) + '</span><strong>' + value + '</strong></div>').join("");
}
function selectedGroupKeys() {
  return [...document.querySelectorAll(".group-checkbox:checked")].map(el => el.dataset.key);
}
function updateSelectionCount() {
  const count = selectedGroupKeys().length;
  $("selectionCount").textContent = count + " selected";
  const boxes = [...document.querySelectorAll(".group-checkbox")];
  $("selectAllVisible").checked = boxes.length > 0 && boxes.every(b => b.checked);
  $("selectAllVisible").indeterminate = boxes.some(b => b.checked) && !boxes.every(b => b.checked);
}
function renderGroups() {
  const body = $("groupsBody");
  const visible = [...groupsByKey.values()].filter(groupMatches).sort((a,b) => String(a.distance).localeCompare(String(b.distance)) || String(a.bibNumber).localeCompare(String(b.bibNumber), undefined, {numeric:true}) || String(a.eventId).localeCompare(String(b.eventId)));
  if (!visible.length) {
    body.innerHTML = '<tr><td colspan="12" class="empty-state">No results match these filters.</td></tr>';
    updateSelectionCount();
    return;
  }
  body.innerHTML = visible.map(group => {
    const runnerRec = group.activeRecords.find(r => r.registered) || group.records.find(r => r.registered) || group.records[0] || {};
    const selected = group.selectedRecord;
    const selectedTime = selected ? formatElapsed(selected.elapsedTime) : "—";
    const selectedTimer = selected ? selected.timerRole : (group.selected && group.selected.selectionStatus === "EXCLUDED" ? "Excluded" : "Not selected");
    const activeCount = group.activeRecords.length;
    const hasInvalid = group.activeRecords.some(r => (r.issues || []).includes("INVALID_BIB"));
    const correctButton = canEdit && hasInvalid ? '<button class="review-action-button" data-action="correct-group" data-key="' + escapeHtml(group.key) + '">Correct bib</button>' : "";
    const reviewButton = '<button class="review-action-button primary" data-action="review" data-key="' + escapeHtml(group.key) + '">Review</button>';
    const checked = selectedGroups.has(group.key) ? " checked" : "";
    const rowClass = group.status === "EXCLUDED" ? "row-excluded" : "";
    return '<tr class="' + rowClass + '">' +
      '<td><input type="checkbox" class="group-checkbox" data-key="' + escapeHtml(group.key) + '" aria-label="Select bib ' + escapeHtml(group.bibNumber) + '"' + checked + (canEdit ? "" : " disabled") + '></td>' +
      '<td>' + statusPill(group.status) + '</td>' +
      '<td>' + escapeHtml(group.eventId || "—") + '</td>' +
      '<td>' + escapeHtml(group.distance || "—") + '</td>' +
      '<td><strong>' + escapeHtml(group.bibNumber || "—") + '</strong></td>' +
      '<td>' + escapeHtml(runnerRec.runnerName || "Unknown / unregistered") + (group.records.some(r => r.bibCorrected) ? '<div class="small muted">Corrected</div>' : "") + '</td>' +
      '<td>' + escapeHtml(runnerRec.category || "Unclassified") + '</td>' +
      '<td>' + escapeHtml(runnerRec.gender || "Unknown") + '</td>' +
      '<td>' + escapeHtml(selectedTime) + '</td>' +
      '<td>' + escapeHtml(selectedTimer) + '</td>' +
      '<td>' + activeCount + ' active / ' + group.records.length + ' total</td>' +
      '<td class="group-action-cell">' + reviewButton + correctButton + '</td>' +
      '</tr>';
  }).join("");
  updateSelectionCount();
}
function renderConsolidated() {
  const body = $("consolidatedBody");
  const event = $("eventFilter").value;
  const distance = $("distanceFilter").value;
  const category = $("categoryFilter").value;
  const gender = $("genderFilter").value;
  const groups = [...groupsByKey.values()].filter(group => {
    if (event && group.eventId !== event) return false;
    if (distance !== "ALL" && group.distance !== distance) return false;
    if (category !== "ALL" && !group.records.some(r => r.category === category)) return false;
    if (gender !== "ALL" && !group.records.some(r => String(r.gender || "").toLowerCase() === gender.toLowerCase())) return false;
    return group.selected && group.selected.selectedRecordId;
  }).sort((a,b) => String(a.distance).localeCompare(String(b.distance)) || String(a.bibNumber).localeCompare(String(b.bibNumber), undefined, {numeric:true}));
  if (!groups.length) { body.innerHTML = '<tr><td colspan="10" class="empty-state">No selected consolidated results match these filters.</td></tr>'; return; }
  body.innerHTML = groups.map(group => {
    const item = group.selected;
    return '<tr><td>' + statusPill(item.selectionStatus || "PROVISIONAL") + '</td><td>' + escapeHtml(item.eventId) + '</td><td>' + escapeHtml(item.distance) + '</td><td>' + escapeHtml(item.bibNumber) + '</td><td>' + escapeHtml(item.name) + '</td><td>' + escapeHtml(item.category) + '</td><td>' + escapeHtml(item.gender) + '</td><td>' + escapeHtml(item.selectedTimer) + '</td><td>' + escapeHtml(formatElapsed(item.elapsedTime)) + '</td><td>' + escapeHtml(formatFinishClock(item.finishTimestamp)) + '</td></tr>';
  }).join("");
}
function renderAll() {
  groupsByKey = buildGroups();
  // Discard checkbox selections for groups no longer present.
  selectedGroups = new Set([...selectedGroups].filter(key => groupsByKey.has(key)));
  renderStats(); renderGroups(); renderConsolidated();
  ["bulkTimer1Button", "bulkExcludeButton", "bulkRestoreButton", "finalizeButton"].forEach(id => { $(id).classList.toggle("hidden", !canEdit); });
  $("selectAllVisible").disabled = !canEdit;
  $("roleMessage").textContent = canEdit ? "Timer1 controls enabled for this internal test." : "Read-only view. Open this page from a Timer1 device to manage results.";
}
function isSelectable(record) {
  const issues = record.issues || [];
  return !record.excluded && record.elapsedMs !== null && record.elapsedMs >= 0 &&
    !issues.includes("INVALID_BIB") && !issues.includes("INVALID_BIB_FORMAT") &&
    !issues.includes("DISTANCE_MISMATCH") && !issues.includes("INVALID_FINISH_TIMESTAMP") &&
    !issues.includes("INVALID_OR_MISSING_ELAPSED_TIME");
}
function openGroupDialog(key) {
  const group = groupsByKey.get(key);
  if (!group) return;
  activeDialogKey = key;
  pendingCandidateId = "";
  $("dialogTitle").textContent = "Bib " + group.bibNumber + " · " + group.distance;
  $("dialogSubtitle").textContent = (group.eventId || "No event ID") + " · " + group.records.length + " observation(s)";
  $("confirmCandidateButton").disabled = true;
  $("candidateSelectionMessage").textContent = canEdit ? "Choose a candidate, then confirm the selection." : "Read-only comparison.";
  const selectedId = group.selected && group.selected.selectedRecordId || "";
  $("candidateList").innerHTML = group.records.map(record => {
    const selected = selectedId && selectedId === record.recordId;
    const canPick = canEdit && isSelectable(record);
    const selectBtn = canPick
      ? '<button class="review-action-button primary" data-action="pick-candidate" data-id="' + escapeHtml(record.recordId) + '">' + (selected ? "Currently selected" : "Select") + '</button>'
      : '<button class="review-action-button" disabled>' + (record.excluded ? "Excluded" : "Not selectable") + '</button>';
    const toggleBtn = canEdit
      ? (record.excluded
          ? '<button class="review-action-button" data-action="restore-one" data-id="' + escapeHtml(record.recordId) + '">Restore</button>'
          : '<button class="review-action-button danger" data-action="exclude-one" data-id="' + escapeHtml(record.recordId) + '">Exclude</button>')
      : "";
    const correctBtn = canEdit && (record.issues || []).includes("INVALID_BIB") && !record.excluded
      ? '<button class="review-action-button" data-action="correct-one" data-id="' + escapeHtml(record.recordId) + '">Correct bib</button>' : "";
    const raw = record.bibCorrected ? ' · Raw bib ' + escapeHtml(record.rawBibNumber) + ' corrected' : "";
    return '<article class="candidate-card ' + (selected ? "candidate-active" : "") + (record.excluded ? " candidate-excluded" : "") + '" data-candidate="' + escapeHtml(record.recordId) + '">' +
      '<div><div class="candidate-title">' + escapeHtml(record.timerRole) + ' · ' + escapeHtml(formatElapsed(record.elapsedTime)) + (selected ? ' <span class="issue-pill valid">CURRENT</span>' : "") + '</div>' +
      '<div class="candidate-details">Status: ' + escapeHtml(record.status || "VALID") + '<br>Finish: ' + escapeHtml(formatFinishClock(record.finishTimestamp)) + raw + '</div></div>' +
      '<div class="candidate-actions">' + selectBtn + toggleBtn + correctBtn + '</div></article>';
  }).join("");
  const dialog = $("candidateDialog");
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "open");
}
function closeDialog() {
  const dialog = $("candidateDialog");
  if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open");
  activeDialogKey = null; pendingCandidateId = "";
}
async function postAction(payload) {
  if (!canEdit) throw new Error("Only Timer1 can change results in this test build.");
  const response = await fetch(API_URL, {
    method: "POST", redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(actorPayload(payload))
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const result = await response.json();
  if (!result || result.success !== true) throw new Error((result && result.error) || "Action failed.");
  return result;
}
async function runAction(payload, successMessage) {
  try {
    setMessage("Saving…");
    const result = await postAction(payload);
    if (payload.action === "excludeRecord" || payload.action === "excludeRecords") {
      // Exclusions become visible immediately after the backend confirms and data refreshes.
      selectedGroups.clear();
    }
    if (successMessage) setMessage(successMessage);
    await getReviewData();
    if (result.message) setMessage(result.message);
    return result;
  } catch (error) {
    setMessage("Could not save: " + error.message, true);
    alert("Could not save: " + error.message);
    return null;
  }
}
async function confirmCandidateSelection() {
  if (!pendingCandidateId || !activeDialogKey) return;
  const group = groupsByKey.get(activeDialogKey);
  const candidate = group && group.records.find(r => r.recordId === pendingCandidateId);
  if (!candidate) return;
  if (!confirm("Use " + candidate.timerRole + " time " + formatElapsed(candidate.elapsedTime) + " for bib " + candidate.bibNumber + "?")) return;
  const result = await runAction({ action: "selectResult", recordId: candidate.recordId, eventId: candidate.eventId }, "Selection saved.");
  if (result) closeDialog();
}
async function toggleObservation(action, recordId) {
  const record = reviewData.records.find(r => r.recordId === recordId);
  if (!record) return;
  const label = action === "excludeRecord" ? "exclude this observation" : "restore this observation";
  if (!confirm("Confirm: " + label + " for bib " + record.bibNumber + " (" + record.timerRole + ")?")) return;
  const result = await runAction({ action, recordId: recordId, eventId: record.eventId }, "Updated.");
  if (result && activeDialogKey) openGroupDialog(activeDialogKey);
}
async function correctBibForRecords(recordIds, currentBib) {
  if (!canEdit || !recordIds.length) return;
  const newBib = prompt("Enter the correct registered bib number:", currentBib || "");
  if (newBib === null) return;
  const cleanBib = newBib.trim();
  if (!/^\d+$/.test(cleanBib)) { alert("Enter a numeric bib number."); return; }
  if (!confirm("Correct " + recordIds.length + " observation(s) to bib " + cleanBib + "?")) return;
  const result = await runAction({ action: "correctBib", recordIds: recordIds, newBibNumber: cleanBib }, "Bib correction saved.");
  if (result && activeDialogKey) closeDialog();
}
async function correctGroupBib(key) {
  const group = groupsByKey.get(key);
  if (!group) return;
  const targets = group.activeRecords.filter(r => (r.issues || []).includes("INVALID_BIB") || (r.issues || []).includes("INVALID_BIB_FORMAT"));
  if (!targets.length) { alert("This bib group has no active invalid-bib observations."); return; }
  await correctBibForRecords(targets.map(r => r.recordId), group.bibNumber);
}
async function handleGroupAction(action, key) {
  if (action === "review") { openGroupDialog(key); return; }
  if (action === "correct-group") { await correctGroupBib(key); return; }
}
async function bulkExcludeRestore(action) {
  const keys = selectedGroupKeys();
  if (!keys.length) { alert("Select one or more bib rows first."); return; }
  const records = keys.flatMap(key => (groupsByKey.get(key)?.records || []));
  const ids = [...new Set(records.filter(r => action === "excludeRecords" ? !r.excluded : r.excluded).map(r => r.recordId))];
  if (!ids.length) { alert(action === "excludeRecords" ? "The selected rows have no active observations." : "The selected rows have no excluded observations."); return; }
  const verb = action === "excludeRecords" ? "exclude all active observations for" : "restore excluded observations for";
  if (!confirm("Confirm: " + verb + " " + keys.length + " selected bib result(s)?")) return;
  await runAction({ action, recordIds: ids }, "Updated " + ids.length + " observation(s).");
}
async function bulkTimer1Defaults() {
  const keys = selectedGroupKeys();
  if (!keys.length) { alert("Select one or more bib rows first."); return; }
  const selectedIds = [], skipped = [];
  keys.forEach(key => {
    const group = groupsByKey.get(key);
    if (!group) { skipped.push(key); return; }

    const activeTimer1 = group.activeRecords.filter(r => r.timerRole === "Timer1");
    let candidate = null;

    if (activeTimer1.length === 1 && isSelectable(activeTimer1[0])) {
      candidate = activeTimer1[0];
    } else if (activeTimer1.length === 0) {
      const backups = group.activeRecords
        .filter(isSelectable)
        .filter(r => r.timerRole !== "Timer1")
        .sort((a, b) => a.elapsedMs - b.elapsedMs ||
          String(a.timerRole).localeCompare(String(b.timerRole)));
      candidate = backups[0] || null;
    }

    if (candidate) selectedIds.push(candidate.recordId);
    else skipped.push(group.bibNumber || key);
  });

  if (!selectedIds.length) {
    alert("No selected bibs have an unambiguous valid default. Bibs with duplicate Timer1 observations or invalid times need individual review.");
    return;
  }

  if (!confirm("Apply defaults to " + selectedIds.length + " selected bib(s)? Timer1 is preferred when one valid observation exists. If Timer1 has no observation, the fastest valid backup is suggested. Review and finalize remain required.")) return;

  const result = await runAction(
    { action: "selectResults", recordIds: selectedIds, applyDefaults: true },
    "Defaults applied to selected bibs."
  );
  if (result && skipped.length) {
    alert("Updated " + selectedIds.length + " result(s). These bibs need individual review: " + skipped.join(", "));
  }
  selectedGroups.clear();
  renderGroups();
}
async function finalizeEvent() {
  const eventId = $("eventFilter").value;
  if (!eventId) { alert("Select one event before finalizing."); return; }
  const warnings = [...groupsByKey.values()].filter(g => g.eventId === eventId && (["DUPLICATE CANDIDATE", "POSSIBLE PREMATURE ENTRY", "MISSING PRIMARY", "NEEDS REVIEW", "SELECTED BACKUP"].includes(g.status) || (g.selected && g.selected.selectedTimer && g.selected.selectedTimer !== "Timer1"))).length;
  const warningText = warnings ? "\n\nThere are " + warnings + " review/backup warning(s). Finalization will acknowledge these warnings; verify all selected times and exclusions first." : "";
  if (!confirm("Finalize the currently selected Consolidated results for " + eventId + "?\n\nResults will be marked FINAL." + warningText)) return;
  await runAction({ action: "finalizeResults", eventId: eventId, acknowledgeWarnings: true }, "Event finalized.");
}

$("refreshButton").addEventListener("click", getReviewData);
["eventFilter", "distanceFilter", "statusFilter", "categoryFilter", "genderFilter"].forEach(id => $(id).addEventListener("change", () => { renderAll(); }));
$("selectAllVisible").addEventListener("change", event => {
  const visible = [...groupsByKey.values()].filter(groupMatches);
  visible.forEach(group => event.target.checked ? selectedGroups.add(group.key) : selectedGroups.delete(group.key));
  renderGroups();
});
$("groupsBody").addEventListener("change", event => {
  const checkbox = event.target.closest(".group-checkbox");
  if (!checkbox) return;
  if (checkbox.checked) selectedGroups.add(checkbox.dataset.key); else selectedGroups.delete(checkbox.dataset.key);
  updateSelectionCount();
});
$("groupsBody").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (button) handleGroupAction(button.dataset.action, button.dataset.key);
});
$("bulkExcludeButton").addEventListener("click", () => bulkExcludeRestore("excludeRecords"));
$("bulkRestoreButton").addEventListener("click", () => bulkExcludeRestore("restoreRecords"));
$("bulkTimer1Button").addEventListener("click", bulkTimer1Defaults);
$("finalizeButton").addEventListener("click", finalizeEvent);
$("candidateList").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action, recordId = button.dataset.id;
  if (action === "pick-candidate") {
    pendingCandidateId = recordId;
    document.querySelectorAll(".candidate-card").forEach(card => card.classList.toggle("candidate-active", card.dataset.candidate === recordId));
    $("candidateSelectionMessage").textContent = "Candidate selected. Confirm to save it to Consolidated.";
    $("confirmCandidateButton").disabled = false;
    document.querySelectorAll('[data-action="pick-candidate"]').forEach(b => { b.textContent = b.dataset.id === recordId ? "Selected" : "Select"; });
  } else if (action === "exclude-one") {
    await toggleObservation("excludeRecord", recordId);
  } else if (action === "restore-one") {
    await toggleObservation("restoreRecord", recordId);
  } else if (action === "correct-one") {
    const group = groupsByKey.get(activeDialogKey);
    const target = reviewData.records.find(r => r.recordId === recordId);
    await correctBibForRecords([recordId], target ? target.bibNumber : (group ? group.bibNumber : ""));
  }
});
$("confirmCandidateButton").addEventListener("click", confirmCandidateSelection);
$("closeDialogButton").addEventListener("click", closeDialog);
$("candidateDialog").addEventListener("click", event => {
  if (event.target === $("candidateDialog")) closeDialog();
});

function restoreReviewSnapshot() {
  try {
    const raw = localStorage.getItem("v5000LastReviewSnapshot");
    if (!raw) {
      setMessage("No saved results snapshot yet. Click Refresh from Sheets to load current data.");
      return false;
    }
    const cached = JSON.parse(raw);
    if (!cached || cached.success !== true || !Array.isArray(cached.records) || !Array.isArray(cached.consolidated)) return false;
    reviewData = cached;
    $("connectionStatus").textContent = "SAVED SNAPSHOT";
    populateFilters();
    renderAll();
    setMessage("Showing saved snapshot from " + new Date(cached.fetchedAt || Date.now()).toLocaleString() + ". Click Refresh from Sheets for current data.");
    return true;
  } catch (error) {
    setMessage("Could not restore saved snapshot. Click Refresh from Sheets.", true);
    return false;
  }
}
if (!canEdit) {
  $("roleMessage").textContent = "Read-only view. Open this page from a Timer1 device to manage results.";
}
restoreReviewSnapshot();
