/**
 * VELOCITY 5000 TIMING SYSTEM — RACE-DAY TEST BACKEND
 * Raw Timer1–Timer5 rows are never edited by correction workflows.
 * Corrections/exclusions are represented in CorrectionLog; selected results are in Consolidated.
 *
 * TEST MODE AUTHORIZATION: mutations require actorRole === "Timer1".
 * This is intentionally simple for the internal trial and is NOT strong security.
 */
const SPREADSHEET_ID = "1gt3dk6me2lpui1lUv8aCyTMYrN9z5NyLBss3TG_KvLw";
const TIMER_SHEETS = ["Timer1", "Timer2", "Timer3", "Timer4", "Timer5"];
const CONFIG_HEADERS = ["Bib Number", "Name", "Category", "Gender"];
const TIMER_HEADERS = ["Record ID", "Event ID", "Timer Role", "Bib Number", "Distance", "Finish Timestamp", "Elapsed Time", "Entry Timestamp", "Record Status", "Upload Timestamp", "Device Session ID", "Notes"];
const CONSOLIDATED_SHEET = "Consolidated";
const CORRECTION_SHEET = "CorrectionLog";
const CONSOLIDATED_HEADERS = ["Result Key", "Event ID", "Distance", "Bib Number", "Name", "Category", "Gender", "Selected Record ID", "Selected Timer", "Finish Timestamp", "Elapsed Time", "Selection Status", "Notes", "Updated At", "Updated By"];
const CORRECTION_HEADERS = ["Log ID", "Action", "Event ID", "Distance", "Bib Number", "Record ID", "Timer Role", "Previous Value", "New Value", "Reason", "Actor", "Timestamp"];

function doGet(e) {
  const action = e && e.parameter ? String(e.parameter.action || "") : "";
  try {
    if (action === "config") return jsonOutput(getConfigData());
    if (action === "health") return jsonOutput({ success: true, application: "Velocity 5000 Timing System", version: "1.2.0", serverTime: new Date().toISOString() });
    if (action === "reviewData") return jsonOutput(getReviewData(String(e.parameter.eventId || "")));
    return jsonOutput({ success: true, application: "Velocity 5000 Timing System", message: "Backend is running.", availableActions: ["health", "config", "reviewData"] });
  } catch (err) {
    return jsonOutput({ success: false, error: err.message });
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error("Missing request body.");
    const request = JSON.parse(e.postData.contents);
    let result;
    switch (request.action) {
      case "uploadRecords": result = uploadRecords(request); break;
      case "selectResult": requireTimer1_(request); result = selectResults_({ ...request, recordIds: [request.recordId] }); break;
      case "selectResults": requireTimer1_(request); result = selectResults_(request); break;
      case "excludeRecord": requireTimer1_(request); result = excludeRecords_({ ...request, recordIds: [request.recordId] }); break;
      case "excludeRecords": requireTimer1_(request); result = excludeRecords_(request); break;
      case "restoreRecord": requireTimer1_(request); result = restoreRecords_({ ...request, recordIds: [request.recordId] }); break;
      case "restoreRecords": requireTimer1_(request); result = restoreRecords_(request); break;
      case "correctBib": requireTimer1_(request); result = correctBib_(request); break;
      case "finalizeResults": requireTimer1_(request); result = finalizeResults_(request); break;
      default: throw new Error("Unknown POST action.");
    }
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ success: false, error: err.message });
  }
}

function getSpreadsheet_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }
function jsonOutput(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }
function requireTimer1_(request) {
  if (String(request && request.actorRole || "") !== "Timer1") {
    throw new Error("Only Timer1 can change result selections in this test build.");
  }
}

/** Add missing required headers at the right. Never clear, reorder, or rename cells. */
function ensureHeaders_(sheet, requiredHeaders) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  const current = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(v => String(v || "").trim());
  const missing = requiredHeaders.filter(h => !current.includes(h));
  if (missing.length) sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  return sheet;
}
function ensureSheet_(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return ensureHeaders_(sheet, headers);
}

/** Run manually once from the Apps Script editor; safe to rerun. */
function repairTimingSystemHeaders() {
  const ss = getSpreadsheet_();
  const required = {
    "Config": CONFIG_HEADERS,
    "Timer1": TIMER_HEADERS,
    "Timer2": TIMER_HEADERS,
    "Timer3": TIMER_HEADERS,
    "Timer4": TIMER_HEADERS,
    "Timer5": TIMER_HEADERS,
    "Consolidated": CONSOLIDATED_HEADERS,
    "CorrectionLog": CORRECTION_HEADERS
  };
  const report = [];
  Object.keys(required).forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, required[name].length).setValues([required[name]]);
      report.push(name + ": created sheet and headers");
      return;
    }
    const before = sheet.getLastColumn();
    const oldHeaders = before ? sheet.getRange(1, 1, 1, before).getDisplayValues()[0].map(v => String(v || "").trim()) : [];
    const missing = required[name].filter(h => !oldHeaders.includes(h));
    ensureHeaders_(sheet, required[name]);
    report.push(name + (missing.length ? ": appended " + missing.join(", ") : ": headers OK"));
  });
  Logger.log(report.join("\n"));
  return report;
}

function headerMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (!lastCol) throw new Error("Sheet " + sheet.getName() + " has no headers.");
  const headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(v => String(v || "").trim());
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i; });
  return { headers: headers, map: map };
}
function rowsAsObjects_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const hm = headerMap_(sheet);
  return sheet.getRange(2, 1, lastRow - 1, hm.headers.length).getDisplayValues().map((row, idx) => {
    const obj = { _row: idx + 2, _sheet: sheet.getName() };
    hm.headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    return obj;
  }).filter(obj => Object.keys(obj).some(k => !k.startsWith("_") && String(obj[k] || "").trim() !== ""));
}
function writeObjectRow_(sheet, object, rowNumber) {
  const hm = headerMap_(sheet);
  const values = hm.headers.map(h => Object.prototype.hasOwnProperty.call(object, h) ? object[h] : "");
  if (rowNumber) sheet.getRange(rowNumber, 1, 1, hm.headers.length).setValues([values]);
  else sheet.getRange(sheet.getLastRow() + 1, 1, 1, hm.headers.length).setValues([values]);
}
function getConfigData() {
  const sheet = getSpreadsheet_().getSheetByName("Config");
  if (!sheet) throw new Error("Config sheet not found.");
  const values = sheet.getDataRange().getDisplayValues();
  if (!values.length) throw new Error("Config sheet is empty.");
  const headers = values[0].map(v => String(v || "").trim());
  const indexes = {};
  headers.forEach((h, i) => indexes[h] = i);
  CONFIG_HEADERS.forEach(h => { if (indexes[h] === undefined) throw new Error("Missing Config column: " + h); });
  const seen = new Set();
  const runners = [];
  values.slice(1).forEach(row => {
    const bib = String(row[indexes["Bib Number"]] || "").trim();
    if (!bib) return;
    if (seen.has(bib)) throw new Error("Duplicate bib number in Config: " + bib);
    seen.add(bib);
    runners.push({ bibNumber: bib, name: String(row[indexes.Name] || "").trim(), category: String(row[indexes.Category] || "").trim(), gender: String(row[indexes.Gender] || "").trim(), distance: detectDistance_(bib) });
  });
  return { success: true, count: runners.length, fetchedAt: new Date().toISOString(), runners: runners };
}
function detectDistance_(bib) {
  const value = String(bib || "").trim();
  if (!/^\d+$/.test(value)) return null;
  if (value.startsWith("16")) return "16KM";
  if (value.startsWith("10")) return "10KM";
  if (value.startsWith("5")) return "5KM";
  if (value.startsWith("3")) return "3KM";
  return null;
}
function uploadRecords(request) {
  if (!Array.isArray(request.records)) throw new Error("records must be an array.");
  if (request.records.length > 200) throw new Error("Upload batches cannot exceed 200 records.");
  const role = String(request.timerRole || "").trim();
  if (!TIMER_SHEETS.includes(role)) throw new Error("Invalid timer role.");
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sheet = getSpreadsheet_().getSheetByName(role);
    if (!sheet) throw new Error("Missing timer sheet: " + role);
    ensureHeaders_(sheet, TIMER_HEADERS);
    const hm = headerMap_(sheet);
    const existingRows = rowsAsObjects_(sheet);
    const existing = new Map();
    existingRows.forEach(r => { const id = String(r["Record ID"] || "").trim(); if (id) existing.set(id, r); });
    const accepted = [], duplicates = [], conflicts = [], seenRequest = new Set();
    request.records.forEach(record => {
      validateRecord_(record, role);
      const id = String(record.recordId).trim();
      if (seenRequest.has(id)) { duplicates.push(id); return; }
      seenRequest.add(id);
      if (existing.has(id)) {
        const old = existing.get(id);
        const samePayload = String(old["Event ID"] || "").trim() === String(record.eventId || "").trim() && String(old["Bib Number"] || "").trim() === String(record.bibNumber).trim() && String(old.Distance || "").trim() === String(record.distance).trim() && String(old["Finish Timestamp"] || "").trim() === String(record.finishTimestamp).trim();
        if (samePayload) duplicates.push(id); else conflicts.push(id);
        return;
      }
      accepted.push(record);
    });
    if (accepted.length) {
      const uploadedAt = new Date();
      const newRows = accepted.map(record => {
        const o = { "Record ID": String(record.recordId), "Event ID": String(record.eventId || ""), "Timer Role": role, "Bib Number": String(record.bibNumber), "Distance": String(record.distance), "Finish Timestamp": String(record.finishTimestamp), "Elapsed Time": String(record.elapsedTime || ""), "Entry Timestamp": String(record.entryTimestamp || ""), "Record Status": "normal", "Upload Timestamp": uploadedAt, "Device Session ID": String(record.deviceSessionId || ""), "Notes": String(record.notes || "") };
        return hm.headers.map(h => o[h] === undefined ? "" : o[h]);
      });
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, hm.headers.length).setValues(newRows);
    }
    return { success: conflicts.length === 0, accepted: accepted.map(r => r.recordId), duplicates: duplicates, conflicts: conflicts, serverTime: new Date().toISOString() };
  } finally { lock.releaseLock(); }
}
function validateRecord_(record, role) {
  if (!record || typeof record !== "object") throw new Error("Invalid record.");
  if (!record.recordId) throw new Error("Record ID is required.");
  if (record.timerRole && record.timerRole !== role) throw new Error("Record timer role does not match upload.");
  if (!/^\d+$/.test(String(record.bibNumber || ""))) throw new Error("Invalid bib number.");
  const d = detectDistance_(record.bibNumber);
  if (!d) throw new Error("Cannot determine distance for bib " + record.bibNumber);
  if (record.distance !== d) throw new Error("Distance mismatch for bib " + record.bibNumber);
  if (!record.finishTimestamp || isNaN(Date.parse(record.finishTimestamp))) throw new Error("Invalid finish timestamp.");
}
function parseElapsedMs_(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{1,3}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const frac = Number((m[4] || "0").padEnd(3, "0"));
  return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) + frac;
}

/** Format elapsed duration as HH:MM:SS.ss (hundredths, not milliseconds). */
function formatElapsedText_(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  const totalCentiseconds = Math.floor(elapsedMs / 10);
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const hundredths = totalCentiseconds % 100;
  return [String(hours).padStart(2, "0"), String(minutes).padStart(2, "0"), String(seconds).padStart(2, "0")].join(":") + "." + String(hundredths).padStart(2, "0");
}
function validDefaultCandidate_(record) {
  return Boolean(record && !record.excluded && record.registered &&
    Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0 &&
    record.distance && detectDistance_(record.bibNumber) === record.distance &&
    record.finishTimestamp && !isNaN(Date.parse(record.finishTimestamp)) &&
    record.recordId);
}
function resultKey_(eventId, distance, bib) { return [eventId || "", distance || "", bib || ""].join("|"); }

function getLatestExclusions_() {
  const sheet = ensureSheet_(CORRECTION_SHEET, CORRECTION_HEADERS);
  const logs = rowsAsObjects_(sheet);
  const excluded = new Set();
  logs.forEach(r => {
    const id = String(r["Record ID"] || "").trim();
    if (!id) return;
    if (String(r.Action || "") === "EXCLUDE_RECORD") excluded.add(id);
    if (String(r.Action || "") === "RESTORE_RECORD") excluded.delete(id);
  });
  return excluded;
}
function getLatestBibCorrections_() {
  const sheet = ensureSheet_(CORRECTION_SHEET, CORRECTION_HEADERS);
  const logs = rowsAsObjects_(sheet);
  const corrections = new Map();
  logs.forEach(r => {
    if (String(r.Action || "") !== "CORRECT_BIB") return;
    const id = String(r["Record ID"] || "").trim();
    const newBib = String(r["New Value"] || "").trim();
    if (id && newBib) corrections.set(id, newBib);
  });
  return corrections;
}

function getReviewData(eventIdFilter) {
  const ss = getSpreadsheet_();
  const config = getConfigData();
  const runnerMap = new Map(config.runners.map(r => [String(r.bibNumber), r]));
  const exclusions = getLatestExclusions_();
  const corrections = getLatestBibCorrections_();
  const all = [];
  TIMER_SHEETS.forEach(role => {
    const sheet = ss.getSheetByName(role);
    if (!sheet) throw new Error("Missing timer sheet: " + role);
    ensureHeaders_(sheet, TIMER_HEADERS);
    rowsAsObjects_(sheet).forEach(row => {
      const eventId = String(row["Event ID"] || "").trim();
      if (eventIdFilter && eventId !== eventIdFilter) return;
      const recordId = String(row["Record ID"] || "").trim();
      const rawBib = String(row["Bib Number"] || "").trim();
      const bib = corrections.get(recordId) || rawBib;
      const distance = String(row.Distance || detectDistance_(rawBib) || "").trim();
      const runner = runnerMap.get(bib) || null;
      const rawElapsed = String(row["Elapsed Time"] || "").trim();
      const elapsedMs = parseElapsedMs_(rawElapsed);
      const elapsed = elapsedMs === null ? rawElapsed : formatElapsedText_(elapsedMs);
      all.push({ recordId: recordId, eventId: eventId, timerRole: String(row["Timer Role"] || role), rawBibNumber: rawBib, bibNumber: bib, bibCorrected: bib !== rawBib, distance: distance, finishTimestamp: String(row["Finish Timestamp"] || ""), elapsedTime: elapsed, elapsedMs: elapsedMs, entryTimestamp: String(row["Entry Timestamp"] || ""), recordStatus: String(row["Record Status"] || "normal"), notes: String(row.Notes || ""), runnerName: runner ? runner.name : "", category: runner ? runner.category : "", gender: runner ? runner.gender : "", registered: Boolean(runner), excluded: exclusions.has(recordId), sheetName: role });
    });
  });

  const groups = new Map();
  all.forEach(r => {
    const key = resultKey_(r.eventId, r.distance, r.bibNumber);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  all.forEach(r => {
    const issues = [];
    if (!r.registered) issues.push("INVALID_BIB");
    if (!r.bibNumber || !/^\d+$/.test(r.bibNumber)) issues.push("INVALID_BIB_FORMAT");
    if (!r.distance || detectDistance_(r.bibNumber) !== r.distance) issues.push("DISTANCE_MISMATCH");
    if (!r.finishTimestamp || isNaN(Date.parse(r.finishTimestamp))) issues.push("INVALID_FINISH_TIMESTAMP");
    if (r.elapsedMs === null || r.elapsedMs < 0) issues.push("INVALID_OR_MISSING_ELAPSED_TIME");
    const group = (groups.get(resultKey_(r.eventId, r.distance, r.bibNumber)) || []).filter(x => !x.excluded);
    if (!r.excluded && group.filter(x => x.timerRole === r.timerRole).length > 1) issues.push("DUPLICATE_CANDIDATE");
    if (!r.excluded && !group.some(x => x.timerRole === "Timer1") && group.some(x => x.timerRole !== "Timer1")) issues.push("MISSING_PRIMARY");
    if (r.excluded) issues.push("EXCLUDED");
    r.issues = [...new Set(issues)];
    r.status = r.excluded ? "EXCLUDED" : (r.issues.length ? r.issues.join(", ") : "VALID");
  });

  syncTimer1Defaults_(all);
  const consolidatedSheet = ensureSheet_(CONSOLIDATED_SHEET, CONSOLIDATED_HEADERS);
  const consolidated = rowsAsObjects_(consolidatedSheet)
    .filter(r => !eventIdFilter || String(r["Event ID"] || "") === eventIdFilter)
    .map(r => {
      const rawElapsed = String(r["Elapsed Time"] || "").trim();
      const elapsedMs = parseElapsedMs_(rawElapsed);
      return { resultKey: r["Result Key"], eventId: r["Event ID"], distance: r.Distance, bibNumber: r["Bib Number"], name: r.Name, category: r.Category, gender: r.Gender, selectedRecordId: r["Selected Record ID"], selectedTimer: r["Selected Timer"], finishTimestamp: r["Finish Timestamp"], elapsedTime: elapsedMs === null ? rawElapsed : formatElapsedText_(elapsedMs), selectionStatus: r["Selection Status"], notes: r.Notes, updatedAt: r["Updated At"], updatedBy: r["Updated By"] };
    });
  const distances = [...new Set(all.map(r => r.distance).filter(Boolean))].sort();
  const eventIds = [...new Set(all.map(r => r.eventId).filter(Boolean))].sort();
  return { success: true, fetchedAt: new Date().toISOString(), count: all.length, distances: distances, eventIds: eventIds, records: all, consolidated: consolidated, categories: [...new Set(config.runners.map(r => r.category).filter(Boolean))].sort(), genders: [...new Set(config.runners.map(r => r.gender).filter(Boolean))].sort() };
}

/**
 * Default selection rules on refresh:
 * - If exactly one active Timer1 observation exists and is valid, select it provisionally.
 * - If Timer1 has multiple observations for the bib, leave the selection unresolved for manual review.
 * - If there is no active Timer1 observation, select the fastest valid backup observation as a suggestion,
 *   but mark it NEEDS REVIEW (never FINAL).
 * - Never overwrite a FINAL row or a human-confirmed selection.
 */
function syncTimer1Defaults_(records) {
  const sheet = ensureSheet_(CONSOLIDATED_SHEET, CONSOLIDATED_HEADERS);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const rows = rowsAsObjects_(sheet);
    const byKey = new Map();
    rows.forEach(row => {
      const key = String(row["Result Key"] || "");
      if (key && !byKey.has(key)) byKey.set(key, row);
    });

    const groups = new Map();
    records.forEach(record => {
      const key = resultKey_(record.eventId, record.distance, record.bibNumber);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    });

    const isAutoSource = value => /^(AUTO:|Timer1 default$|Fastest backup default$)/i.test(String(value || "").trim());

    groups.forEach((group, key) => {
      const existing = byKey.get(key) || null;
      const existingStatus = String(existing && existing["Selection Status"] || "").trim().toUpperCase();
      const selectedId = String(existing && existing["Selected Record ID"] || "").trim();
      const updatedBy = String(existing && existing["Updated By"] || "").trim();

      // Never rewrite finalized results. Preserve explicit group exclusions until the director restores/selects.
      if (existingStatus === "FINAL") return;
      if (existingStatus === "EXCLUDED" && !selectedId) return;

      // Do not overwrite a human-confirmed result. Automatically generated suggestions can be recomputed.
      if (selectedId && !isAutoSource(updatedBy)) return;

      const active = group.filter(record => !record.excluded);
      if (!active.length) return;

      const timer1Observations = active.filter(record => record.timerRole === "Timer1");
      let candidate = null;
      let selectionStatus = "NEEDS REVIEW";
      let updatedByValue = "AUTO: REVIEW REQUIRED";
      let notes = "Review required before finalization.";

      if (timer1Observations.length === 1) {
        const timer1Candidate = timer1Observations[0];
        if (validDefaultCandidate_(timer1Candidate)) {
          candidate = timer1Candidate;
          selectionStatus = "PROVISIONAL";
          updatedByValue = "AUTO: TIMER1 DEFAULT";
          notes = "Timer1 default; provisional pending review/finalization.";
        } else {
          notes = "Timer1 observation is invalid or incomplete; review required.";
        }
      } else if (timer1Observations.length > 1) {
        notes = "Multiple Timer1 observations for this bib; choose the correct observation manually.";
      } else {
        // Timer1 has no active observation: choose the fastest valid backup only as a reviewable suggestion.
        const backups = active.filter(record => record.timerRole !== "Timer1" && validDefaultCandidate_(record));
        backups.sort((a, b) => {
          if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
          const aFinish = Date.parse(a.finishTimestamp) || 0;
          const bFinish = Date.parse(b.finishTimestamp) || 0;
          if (aFinish !== bFinish) return aFinish - bFinish;
          return String(a.timerRole).localeCompare(String(b.timerRole));
        });
        if (backups.length) {
          candidate = backups[0];
          selectionStatus = "NEEDS REVIEW";
          updatedByValue = "AUTO: FASTEST BACKUP";
          notes = "Fastest valid backup suggested because Timer1 has no active observation. Review before finalization.";
        } else {
          notes = "No valid observation available for automatic selection.";
        }
      }

      // A previously auto-selected result must be cleared if Timer1 duplicates make the choice ambiguous.
      const dataRecord = candidate || group.find(record => !record.excluded) || group[0];
      const object = {
        "Result Key": key,
        "Event ID": dataRecord ? dataRecord.eventId : "",
        "Distance": dataRecord ? dataRecord.distance : "",
        "Bib Number": dataRecord ? dataRecord.bibNumber : "",
        "Name": candidate ? candidate.runnerName : (dataRecord ? dataRecord.runnerName : ""),
        "Category": candidate ? candidate.category : (dataRecord ? dataRecord.category : ""),
        "Gender": candidate ? candidate.gender : (dataRecord ? dataRecord.gender : ""),
        "Selected Record ID": candidate ? candidate.recordId : "",
        "Selected Timer": candidate ? candidate.timerRole : "",
        "Finish Timestamp": candidate ? candidate.finishTimestamp : "",
        "Elapsed Time": candidate ? formatElapsedText_(candidate.elapsedMs) : "",
        "Selection Status": selectionStatus,
        "Notes": notes,
        "Updated At": new Date(),
        "Updated By": updatedByValue
      };

      if (existing) {
        writeObjectRow_(sheet, object, existing._row);
        byKey.set(key, { ...object, _row: existing._row });
      } else {
        writeObjectRow_(sheet, object);
        byKey.set(key, { ...object, _row: sheet.getLastRow() });
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function appendCorrectionLog_(action, record, oldValue, newValue, reason, actor) {
  const sheet = ensureSheet_(CORRECTION_SHEET, CORRECTION_HEADERS);
  const logId = Utilities.getUuid();
  const timestamp = new Date();
  const key = resultKey_(record.eventId || "", record.distance || "", record.bibNumber || "");
  const values = {
    "Log ID": logId, "Correction ID": logId, "Action": action, "Event ID": record.eventId || "",
    "Distance": record.distance || "", "Bib Number": record.bibNumber || "", "Record ID": record.recordId || "",
    "Timer Role": record.timerRole || "", "Previous Value": oldValue == null ? "" : String(oldValue),
    "Original Value": oldValue == null ? "" : String(oldValue), "New Value": newValue == null ? "" : String(newValue),
    "Reason": reason || "", "Actor": actor || "Timer1", "Timestamp": timestamp, "Correction Timestamp": timestamp,
    "Consolidated ID": key, "Field Changed": action, "Device Session ID": record.deviceSessionId || ""
  };
  writeObjectRow_(sheet, values);
}

function selectResults_(request) {
  const ids = [...new Set((request.recordIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("Select at least one result.");
  if (ids.length > 200) throw new Error("Select up to 200 results at a time.");
  const data = getReviewData(String(request.eventId || ""));
  const records = ids.map(id => data.records.find(r => r.recordId === id)).filter(Boolean);
  if (records.length !== ids.length) throw new Error("One or more records could not be found. Refresh and try again.");
  records.forEach(record => {
    if (record.excluded) throw new Error("An excluded record cannot be selected. Restore it first.");
    if (record.elapsedMs === null || record.elapsedMs < 0 || record.issues.includes("INVALID_BIB") || record.issues.includes("DISTANCE_MISMATCH") || record.issues.includes("INVALID_FINISH_TIMESTAMP")) {
      throw new Error("Correct the invalid bib, distance, or time before selecting this result.");
    }
  });
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sheet = ensureSheet_(CONSOLIDATED_SHEET, CONSOLIDATED_HEADERS);
    const rows = rowsAsObjects_(sheet);
    records.forEach(record => {
      const key = resultKey_(record.eventId, record.distance, record.bibNumber);
      const existing = rows.find(r => String(r["Result Key"] || "") === key);
      const obj = { "Result Key": key, "Event ID": record.eventId, "Distance": record.distance, "Bib Number": record.bibNumber, "Name": record.runnerName, "Category": record.category, "Gender": record.gender, "Selected Record ID": record.recordId, "Selected Timer": record.timerRole, "Finish Timestamp": record.finishTimestamp, "Elapsed Time": record.elapsedTime, "Selection Status": "PROVISIONAL", "Notes": "", "Updated At": new Date(), "Updated By": "Timer1" };
      if (existing) writeObjectRow_(sheet, obj, existing._row); else writeObjectRow_(sheet, obj);
      appendCorrectionLog_("SELECT_RESULT", record, existing ? existing["Selected Record ID"] : "", record.recordId, "", "Timer1");
    });
    return { success: true, message: "Selected " + records.length + " result(s).", count: records.length };
  } finally { lock.releaseLock(); }
}

function excludeRecords_(request) {
  const ids = [...new Set((request.recordIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("Select at least one observation to exclude.");
  if (ids.length > 500) throw new Error("Exclude up to 500 observations at a time.");
  const data = getReviewData(String(request.eventId || ""));
  const records = ids.map(id => data.records.find(r => r.recordId === id)).filter(Boolean);
  const recordMap = new Map(records.map(r => [r.recordId, r]));
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    records.forEach(record => { if (!record.excluded) appendCorrectionLog_("EXCLUDE_RECORD", record, "included", "excluded", "", "Timer1"); });
    const sheet = ensureSheet_(CONSOLIDATED_SHEET, CONSOLIDATED_HEADERS);
    const rows = rowsAsObjects_(sheet);
    let changed = 0;
    rows.forEach(row => {
      const selectedId = String(row["Selected Record ID"] || "");
      if (selectedId && recordMap.has(selectedId)) {
        const obj = { "Result Key": row["Result Key"], "Event ID": row["Event ID"], "Distance": row.Distance, "Bib Number": row["Bib Number"], "Name": row.Name, "Category": row.Category, "Gender": row.Gender, "Selected Record ID": "", "Selected Timer": "", "Finish Timestamp": "", "Elapsed Time": "", "Selection Status": "EXCLUDED", "Notes": "", "Updated At": new Date(), "Updated By": "Timer1" };
        writeObjectRow_(sheet, obj, row._row);
        changed++;
      }
    });
    return { success: true, message: "Excluded " + records.filter(r => !r.excluded).length + " observation(s). " + changed + " consolidated selection(s) cleared.", count: records.filter(r => !r.excluded).length };
  } finally { lock.releaseLock(); }
}

function restoreRecords_(request) {
  const ids = [...new Set((request.recordIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("Select at least one excluded observation to restore.");
  const data = getReviewData(String(request.eventId || ""));
  const records = ids.map(id => data.records.find(r => r.recordId === id)).filter(Boolean);
  records.forEach(record => { if (record.excluded) appendCorrectionLog_("RESTORE_RECORD", record, "excluded", "included", "", "Timer1"); });
  return { success: true, message: "Restored " + records.filter(r => r.excluded).length + " observation(s) to review.", count: records.filter(r => r.excluded).length };
}

function correctBib_(request) {
  const ids = [...new Set((request.recordIds || [request.recordId]).map(String).filter(Boolean))];
  const newBib = String(request.newBibNumber || "").trim();
  if (!ids.length || !/^\d+$/.test(newBib)) throw new Error("Enter a valid numeric registered bib.");
  const data = getReviewData(String(request.eventId || ""));
  const targets = ids.map(id => data.records.find(r => r.recordId === id));
  if (targets.some(r => !r)) throw new Error("One or more observations were not found. Refresh and try again.");
  const runner = getConfigData().runners.find(r => String(r.bibNumber) === newBib);
  if (!runner) throw new Error("Bib " + newBib + " is not in Config.");
  targets.forEach(r => {
    if (detectDistance_(newBib) !== r.distance) throw new Error("Bib " + newBib + " belongs to " + detectDistance_(newBib) + ", not " + r.distance + ".");
  });
  const sheet = ensureSheet_(CONSOLIDATED_SHEET, CONSOLIDATED_HEADERS);
  const consolidated = rowsAsObjects_(sheet);
  const selectedTarget = consolidated.find(row => ids.includes(String(row["Selected Record ID"] || "")));
  if (selectedTarget) {
    const destinationKey = resultKey_(selectedTarget["Event ID"], selectedTarget.Distance, newBib);
    const collision = consolidated.find(row => String(row["Result Key"] || "") === destinationKey && row._row !== selectedTarget._row && String(row["Selected Record ID"] || "").trim());
    if (collision) throw new Error("This bib already has a selected consolidated result. Resolve that result first.");
  }
  targets.forEach(record => appendCorrectionLog_("CORRECT_BIB", record, record.bibNumber, newBib, "", "Timer1"));
  // If a corrected observation was already selected, move/update only that consolidated row.
  if (selectedTarget) {
    const chosenRecord = targets.find(r => r.recordId === String(selectedTarget["Selected Record ID"] || ""));
    const correctedRow = { "Result Key": resultKey_(chosenRecord.eventId, chosenRecord.distance, newBib), "Event ID": chosenRecord.eventId, "Distance": chosenRecord.distance, "Bib Number": newBib, "Name": runner.name, "Category": runner.category, "Gender": runner.gender, "Selected Record ID": chosenRecord.recordId, "Selected Timer": chosenRecord.timerRole, "Finish Timestamp": chosenRecord.finishTimestamp, "Elapsed Time": chosenRecord.elapsedTime, "Selection Status": "PROVISIONAL", "Notes": "", "Updated At": new Date(), "Updated By": "Timer1" };
    writeObjectRow_(sheet, correctedRow, selectedTarget._row);
  }
  return { success: true, message: "Corrected " + targets.length + " observation(s) to bib " + newBib + ".", count: targets.length, bibNumber: newBib };
}

function finalizeResults_(request) {
  const eventId = String(request.eventId || "").trim();
  if (!eventId) throw new Error("Select one event before finalizing.");
  const sheet = ensureSheet_(CONSOLIDATED_SHEET, CONSOLIDATED_HEADERS);
  const hm = headerMap_(sheet);
  const rows = rowsAsObjects_(sheet).filter(r => String(r["Event ID"] || "") === eventId && String(r["Selected Record ID"] || "").trim());
  if (!rows.length) throw new Error("No selected consolidated results exist for this event.");
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    rows.forEach(row => {
      const statusCol = hm.map["Selection Status"] + 1;
      const notesCol = hm.map.Notes + 1;
      const updatedCol = hm.map["Updated At"] + 1;
      const actorCol = hm.map["Updated By"] + 1;
      sheet.getRange(row._row, statusCol).setValue("FINAL");
      sheet.getRange(row._row, notesCol).setValue("");
      sheet.getRange(row._row, updatedCol).setValue(new Date());
      sheet.getRange(row._row, actorCol).setValue("Timer1");
      appendCorrectionLog_("FINALIZE_EVENT", { eventId: eventId, distance: row.Distance, bibNumber: row["Bib Number"], recordId: row["Selected Record ID"], timerRole: row["Selected Timer"] }, row["Selection Status"], "FINAL", "", "Timer1");
    });
    return { success: true, message: "Finalized " + rows.length + " consolidated result(s) for " + eventId + ".", count: rows.length };
  } finally { lock.releaseLock(); }
}
