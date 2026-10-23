VELOCITY 5000 — RACE-DAY TEST BUILD

This project includes a mobile-friendly, offline-first finish-line timing page, a Google Apps Script backend, Results Summary, and a validation/correction dashboard.

FILES
- index.html / app.js / style.css / style-additions.css: timing page and Results Summary.
- Code.gs: Google Apps Script API, header repair, uploads, Timer1 defaults, bib corrections, exclusions, selections, and finalization.
- review.html / review.js / review.css: simplified validation and correction workspace.
- manifest.json / service-worker.js: offline shell.
- ALL-CODE-COPY-PASTE.txt: source files concatenated with filename separators.

BEFORE TESTING
1. Back up your current VS Code project and export any local records you may need. The timing database is IndexedDB `Velocity5000Timing`, version 2; this build keeps the same name/version.
2. In Apps Script, replace Code.gs with this version and save.
3. Run `repairTimingSystemHeaders` once from the Apps Script editor. It appends missing canonical header names at the far right of each sheet; it does not clear, reorder, or rename any existing rows/cells. Review the Execution log.
4. Deploy > Manage deployments > edit the web app > New version > Deploy. Keep the deployment URL in app.js and review.js matching the deployed URL.
5. Confirm that the web app is deployed to an access setting appropriate for your internal test. `reviewData` returns runner and timing data to people able to access the endpoint.
6. Start VS Code Live Server from this folder and open index.html.

TIMER1 EDITING IN THIS TEST BUILD
- Open Results Validation & Correction from the main app. The link passes the saved timer role.
- Only a Timer1 role will show mutation controls. This is a convenience check, NOT real security. A user who can call the endpoint can spoof actorRole; use identity-based authorization before production or public hosting.
- No admin token or reason prompts are used in this test build. Actions are automatically logged to CorrectionLog.

BEHAVIOR
- Uploads are grouped by the timerRole saved on each local record. Retries with the same Record ID and matching payload are treated as already uploaded; conflicting payloads are reported.
- Results Summary refreshes from Google Sheets on opening and has a manual Refresh from Sheets button. Consolidated shows one selected result per event/distance/bib. All Timers and Timer1–Timer5 show raw observations. Refresh does not upload local pending records.
- On review-data refresh, one valid Timer1 observation is selected provisionally when it is the only active Timer1 observation for that event/distance/bib. Multiple active Timer1 observations are left unresolved for manual review. If there is no active Timer1 observation, the fastest valid backup observation is placed in Consolidated as NEEDS REVIEW (never FINAL) until a director reviews it. A human-confirmed selection and a FINAL result are not overwritten automatically.
- A later Timer1 observation can replace an automatic fastest-backup suggestion, but it never silently replaces a human-confirmed selection. Missing-Primary status remains visible until the backup candidate is reviewed/selected; results still require explicit finalization.
- The review dashboard lists one row per unique event/distance/bib, with a Review popup showing every matching observation. Bulk actions can select Timer1 defaults or exclude/restore selected bib groups. Exclusion and correction decisions are written to CorrectionLog; raw Timer1–Timer5 rows are not edited.
- Correct Bib applies a correction overlay by Record ID using CorrectionLog. It does not rewrite the raw timer-sheet bib.
- Time display uses HH:MM:SS.ss. Finish-time display is shown in the Asia/Manila timezone.
- Finalization marks selected Consolidated rows FINAL for one chosen event, but blocks while rows remain NEEDS REVIEW or have no selected result (except intentionally EXCLUDED rows). Use only after dispute handling.

SUGGESTED TEST
1. Run header repair and deploy the new Apps Script version.
2. Use a COPY of the spreadsheet for clean testing, or clear only confirmed test rows after backing up. Never clear Config.
3. Use Timer1 to record and upload one registered test bib. Refresh the review dashboard. A unique valid Timer1 record should appear in Consolidated by default.
4. Upload a matching bib observation from Timer2. Refresh. Both raw observations should appear, but the existing Timer1 selection should remain selected.
5. Enter the same bib twice on Timer1. The group should show Duplicate Candidate and should not be auto-selected if it has multiple active Timer1 candidates.
6. Open Review, choose one candidate, and confirm. Consolidated should update only that bib's selected record.
7. Exclude an observation and confirm the status/counter updates. Restore it and confirm it returns to the candidate list.
8. Use an unregistered but correctly prefixed test bib and Correct Bib to a registered bib with the same distance. After refresh, Config runner details should appear for the corrected bib.
9. Test a bulk exclusion/restore on test rows only. Verify raw timer sheet rows remain intact and CorrectionLog has action rows.
10. Test Results Summary Refresh from Sheets and compare it against Timer1–Timer5 and Consolidated.

LIMITATIONS / SAFETY
- This is an internal test build, not production-secure. Timer role can be spoofed; don't treat frontend role checks as authentication.
- Validate the flow against a spreadsheet copy first. Syntax checks do not prove Apps Script authorization, live endpoint behavior, or your account's spreadsheet permissions.
- Each browser origin has its own IndexedDB. Records entered under localhost/127.0.0.1 do not automatically transfer to a different origin/domain. Export backups before changing origins.
- Finish timestamps are operator-entered when Enter is pressed; this is not automatic RFID/chip timing.

MILLISECOND DISPLAY / RANKING UPDATE
- Results display elapsed time as HH:MM:SS.sss.
- Ranking sorts by numeric elapsed milliseconds, not the formatted display string.
- The backend review response recalculates elapsed time from the original finish timestamp and the shared active race start when available; otherwise it falls back to the stored elapsed value.
- After replacing Code.gs, deploy a NEW version of the existing Apps Script web app. Replace app.js and review.js in the website and publish them.
- Test with known start/finish timestamps before official use. Millisecond display precision does not guarantee millisecond real-world timing accuracy.
