/**
 * Auto Multi-Cam Edit - Multicam Editor (Cut Engine)
 * Applies razor cuts via QE DOM and enables/disables TrackItems
 * to simulate camera switching on a flat multi-track timeline.
 *
 * Strategy: Each camera is on its own video track (V1, V2, V3...).
 * The plugin razors all video tracks at cut points, then enables only
 * the track segments for the active camera at each interval.
 *
 * Architecture: Incremental batch execution.
 * Instead of one monolithic call, the work is broken into:
 *   1. duplicateSequence()    — Layer 7: Clone sequence for safety
 *   2. prepareTimeline()      — Parse, validate, build timecodes & intervals
 *   3. razorBatch()           — Razor N cuts at a time across all video tracks
 *   4. enableDisableTrack()   — Enable/disable clips on one track at a time
 *   5. rippleDeleteSilence()  — Layer 6: Remove silence gaps via ripple extract
 * Main.js orchestrates these calls with progress feedback between each.
 */

// ============================================================
// SHARED STATE (persists between incremental calls)
// ============================================================

$._autocam_._prepared = null;

// ============================================================
// UNDO GROUP HELPERS
// ============================================================

/**
 * Begin an undo group so all subsequent changes can be undone with a single Ctrl+Z.
 */
$._autocam_.beginUndoGroup = function () {
    try {
        app.beginUndoGroup('Auto Multi-Cam Edit');
        $.writeln('[AutoCam] Undo group started');
        return JSON.stringify({ success: true });
    } catch (e) {
        $.writeln('[AutoCam] beginUndoGroup ERROR: ' + e.message);
        return JSON.stringify({ error: e.message });
    }
};

/**
 * End the current undo group.
 */
$._autocam_.endUndoGroup = function () {
    try {
        app.endUndoGroup();
        $.writeln('[AutoCam] Undo group ended');
        return JSON.stringify({ success: true });
    } catch (e) {
        $.writeln('[AutoCam] endUndoGroup ERROR: ' + e.message);
        return JSON.stringify({ error: e.message });
    }
};

// ============================================================
// LAYER 7: SEQUENCE PROTECTION (DUPLICATE BEFORE EDITING)
// ============================================================

/**
 * Duplicate the active sequence as a safety backup.
 * Creates a clone named "[OriginalName]_AUTO_EDIT" and opens it.
 *
 * @returns {string} JSON result with {success, sequenceName} or {error}
 */
$._autocam_.duplicateSequence = function () {
    try {
        $.writeln('[AutoCam] === DUPLICATE SEQUENCE (Layer 7) ===');

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ error: 'No active sequence to duplicate.' });
        }

        var originalName = seq.name;
        $.writeln('[AutoCam] Original sequence: ' + originalName);

        // Clone the sequence using Premiere Pro API
        var cloneResult = seq.clone();
        $.writeln('[AutoCam] Clone result: ' + cloneResult);

        if (!cloneResult) {
            return JSON.stringify({ error: 'Sequence.clone() returned false. Clone may not be supported in this Premiere version.' });
        }

        // After clone, the new sequence appears in the project panel
        // with " Clone" or " Copy" appended. We need to find and rename it.
        // Search project items for the clone
        $.sleep(500); // Give Premiere a moment to register the clone

        var rootItem = app.project.rootItem;
        var cloneItem = null;
        var searchSuffix = originalName + ' Clone';
        var searchSuffix2 = originalName + ' Copy';
        var autoEditName = originalName + '_AUTO_EDIT';

        for (var i = rootItem.children.numItems - 1; i >= 0; i--) {
            var item = rootItem.children[i];
            if (item.name === searchSuffix || item.name === searchSuffix2) {
                cloneItem = item;
                break;
            }
        }

        // Also search in bins (one level deep)
        if (!cloneItem) {
            for (var b = 0; b < rootItem.children.numItems; b++) {
                var bin = rootItem.children[b];
                if (bin.type === ProjectItemType.BIN && bin.children) {
                    for (var bc = bin.children.numItems - 1; bc >= 0; bc--) {
                        var binChild = bin.children[bc];
                        if (binChild.name === searchSuffix || binChild.name === searchSuffix2) {
                            cloneItem = binChild;
                            break;
                        }
                    }
                    if (cloneItem) break;
                }
            }
        }

        // Rename the clone
        if (cloneItem) {
            cloneItem.name = autoEditName;
            $.writeln('[AutoCam] Renamed clone to: ' + autoEditName);
        } else {
            $.writeln('[AutoCam] WARNING: Could not find clone to rename. Searching for any new sequence...');
            // Fallback: look for newest sequence that isn't the original
            for (var f = rootItem.children.numItems - 1; f >= 0; f--) {
                var fItem = rootItem.children[f];
                if (fItem.type === ProjectItemType.FILE && fItem.name !== originalName) {
                    // Check if it's a sequence by trying to open it
                    try {
                        if (fItem.name.indexOf(originalName) >= 0) {
                            fItem.name = autoEditName;
                            cloneItem = fItem;
                            break;
                        }
                    } catch (e) {
                        // Not a sequence, skip
                    }
                }
            }
        }

        // Open the clone as the active sequence
        // Use app.project.openSequence() if the cloneItem has sequence ID
        // Fallback: the clone may already be active after clone()
        $.sleep(300);

        // Verify: check if active sequence changed
        var currentSeq = app.project.activeSequence;
        if (currentSeq && currentSeq.name === autoEditName) {
            $.writeln('[AutoCam] Clone is now active: ' + autoEditName);
        } else if (currentSeq && currentSeq.name === originalName && cloneItem) {
            // Need to explicitly open the cloned sequence
            // Try to find and open it
            $.writeln('[AutoCam] Clone not auto-opened. Attempting to open...');
            try {
                // projectItem.openInTimeline() method (available in newer Premiere versions)
                // If not available, try app.project.openSequence
                if (typeof cloneItem.openInTimeline === 'function') {
                    cloneItem.openInTimeline();
                    $.sleep(300);
                }
            } catch (e) {
                $.writeln('[AutoCam] openInTimeline failed: ' + e.message);
            }
        }

        // Final check
        var finalSeq = app.project.activeSequence;
        var finalName = finalSeq ? finalSeq.name : 'unknown';

        return JSON.stringify({
            success: true,
            sequenceName: finalName,
            originalName: originalName,
            cloneFound: cloneItem !== null
        });

    } catch (e) {
        $.writeln('[AutoCam] duplicateSequence ERROR: ' + e.message + ' (line ' + (e.line || '?') + ')');
        return JSON.stringify({
            error: 'duplicateSequence failed: ' + e.message,
            line: e.line || 'unknown'
        });
    }
};

// ============================================================
// INTERVAL HELPERS
// ============================================================

/**
 * Build time intervals from a sorted array of cut decisions.
 * Each interval represents a period where one camera is active.
 *
 * @param {Array} cuts - Sorted array of {timeSeconds, cameraIndex}
 * @param {number} seqEndSeconds - End time of the sequence
 * @returns {Array} Array of {start, end, cameraIndex}
 */
$._autocam_.buildIntervals = function (cuts, seqEndSeconds) {
    var intervals = [];
    if (!cuts || cuts.length === 0) return intervals;

    for (var i = 0; i < cuts.length; i++) {
        var startTime = cuts[i].timeSeconds;
        var endTime = (i + 1 < cuts.length) ? cuts[i + 1].timeSeconds : seqEndSeconds;
        intervals.push({
            start: startTime,
            end: endTime,
            cameraIndex: cuts[i].cameraIndex
        });
    }
    return intervals;
};

/**
 * Find which camera is active at a given time point.
 *
 * @param {Array} intervals - Array of {start, end, cameraIndex}
 * @param {number} time - Time in seconds to look up
 * @returns {number} Camera index, or -1 if not found
 */
$._autocam_.getActiveCameraAt = function (intervals, time) {
    for (var i = 0; i < intervals.length; i++) {
        if (time >= intervals[i].start && time < intervals[i].end) {
            return intervals[i].cameraIndex;
        }
    }
    // If time is beyond all intervals, use last camera
    if (intervals.length > 0) {
        return intervals[intervals.length - 1].cameraIndex;
    }
    return 0; // default to first track
};

// ============================================================
// STEP 1: PREPARE TIMELINE
// ============================================================

/**
 * Prepare the timeline for cut application.
 * Parses cut decisions, builds timecodes and intervals, enables QE DOM.
 * Stores everything in $._autocam_._prepared for subsequent batch calls.
 *
 * @param {string} cutJsonString - JSON string with {cuts, frameRate}
 * @returns {string} JSON result with {success, totalTimecodes, totalIntervals, videoTrackCount}
 */
$._autocam_.prepareTimeline = function (cutJsonString) {
    try {
        $.writeln('[AutoCam] === PREPARE TIMELINE ===');

        // Parse input
        var data = JSON.parse(cutJsonString);
        var cuts = data.cuts;
        var fps = data.frameRate || 29.97;

        if (!cuts || cuts.length === 0) {
            return JSON.stringify({ error: 'No cut decisions provided.' });
        }

        $.writeln('[AutoCam] Parsed ' + cuts.length + ' cuts, fps=' + fps);

        // Get active sequence
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ error: 'No active sequence. Open a sequence first.' });
        }

        var videoTrackCount = seq.videoTracks.numTracks;
        var seqDuration = $._autocam_.getSequenceDuration(seq);

        $.writeln('[AutoCam] Sequence: ' + seq.name + ', ' + videoTrackCount + ' video tracks, ' + seqDuration + 's duration');

        // Sort cuts by time
        cuts.sort(function (a, b) {
            return a.timeSeconds - b.timeSeconds;
        });

        // Build timecodes — SKIP time 0 (razoring at clip start does nothing)
        var timecodes = [];
        for (var i = 0; i < cuts.length; i++) {
            if (cuts[i].timeSeconds > 0.001) { // Skip the initial cut at time 0
                var tc = $._autocam_.secondsToTimecode(cuts[i].timeSeconds, fps);
                timecodes.push(tc);
                $.writeln('[AutoCam]   TC[' + (timecodes.length - 1) + ']: ' + tc + ' (' + cuts[i].timeSeconds.toFixed(3) + 's) -> Cam ' + cuts[i].cameraIndex);
            }
        }

        // Build intervals for enable/disable phase
        var intervals = $._autocam_.buildIntervals(cuts, seqDuration);
        $.writeln('[AutoCam] Built ' + intervals.length + ' intervals');

        // Enable QE DOM
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) {
            return JSON.stringify({ error: 'QE DOM: Could not get active sequence.' });
        }

        $.writeln('[AutoCam] QE DOM enabled successfully');

        // Store prepared data for batch calls
        $._autocam_._prepared = {
            cuts: cuts,
            fps: fps,
            timecodes: timecodes,
            intervals: intervals,
            videoTrackCount: videoTrackCount,
            seqDuration: seqDuration,
            razorSuccess: 0,
            razorFailed: 0,
            enabledTotal: 0,
            disabledTotal: 0
        };

        return JSON.stringify({
            success: true,
            totalTimecodes: timecodes.length,
            totalIntervals: intervals.length,
            videoTrackCount: videoTrackCount,
            sequenceName: seq.name,
            durationSeconds: seqDuration
        });

    } catch (e) {
        $.writeln('[AutoCam] prepareTimeline ERROR: ' + e.message + ' (line ' + (e.line || '?') + ')');
        return JSON.stringify({
            error: 'prepareTimeline failed: ' + e.message,
            line: e.line || 'unknown'
        });
    }
};

// ============================================================
// STEP 2: RAZOR BATCH
// ============================================================

/**
 * Apply razor cuts for a batch of timecodes across all video tracks.
 * Call this repeatedly with incrementing startIndex until all timecodes are processed.
 *
 * @param {number} startIndex - Starting index in the stored timecodes array
 * @param {number} batchSize - How many timecodes to process in this batch
 * @returns {string} JSON result with {success, failed, processed, total}
 */
$._autocam_.razorBatch = function (startIndex, batchSize) {
    try {
        if (!$._autocam_._prepared) {
            return JSON.stringify({ error: 'Not prepared. Call prepareTimeline() first.' });
        }

        var prep = $._autocam_._prepared;
        var timecodes = prep.timecodes;
        var vtc = prep.videoTrackCount;
        var endIndex = Math.min(startIndex + batchSize, timecodes.length);

        // Re-acquire QE sequence handle each batch for safety
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) {
            return JSON.stringify({ error: 'QE DOM: Lost active sequence.' });
        }

        var batchSuccess = 0;
        var batchFailed = 0;
        var errors = [];

        $.writeln('[AutoCam] Razor batch: indices ' + startIndex + ' to ' + (endIndex - 1) + ' across ' + vtc + ' tracks');

        for (var i = startIndex; i < endIndex; i++) {
            var tc = timecodes[i];

            for (var t = 0; t < vtc; t++) {
                try {
                    var qeTrack = qeSeq.getVideoTrackAt(t);
                    if (qeTrack) {
                        qeTrack.razor(tc);
                        batchSuccess++;
                    }
                } catch (e) {
                    batchFailed++;
                    if (errors.length < 5) {
                        errors.push('V' + (t + 1) + ' @ ' + tc + ': ' + e.message);
                    }
                }
            }

            // Brief pause between cuts for Premiere stability
            $.sleep(80);
        }

        // Update running totals
        prep.razorSuccess += batchSuccess;
        prep.razorFailed += batchFailed;

        $.writeln('[AutoCam] Razor batch done: +' + batchSuccess + ' success, +' + batchFailed + ' failed');

        return JSON.stringify({
            success: batchSuccess,
            failed: batchFailed,
            processed: endIndex,
            total: timecodes.length,
            errors: errors
        });

    } catch (e) {
        $.writeln('[AutoCam] razorBatch ERROR: ' + e.message);
        return JSON.stringify({
            error: 'razorBatch failed: ' + e.message,
            line: e.line || 'unknown'
        });
    }
};

// ============================================================
// STEP 3: ENABLE/DISABLE PER TRACK
// ============================================================

/**
 * Enable/disable clips on a single video track based on camera assignments.
 * After razor cuts split all tracks, this sets clip.disabled so only
 * the active camera's clip is visible at each time point.
 *
 * Call this once per video track (trackIndex 0, 1, 2, ...).
 *
 * @param {number} trackIndex - The video track index to process
 * @returns {string} JSON result with {enabled, disabled, clipCount, errors}
 */
$._autocam_.enableDisableTrack = function (trackIndex) {
    try {
        if (!$._autocam_._prepared) {
            return JSON.stringify({ error: 'Not prepared. Call prepareTimeline() first.' });
        }

        var prep = $._autocam_._prepared;
        var intervals = prep.intervals;

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ error: 'No active sequence.' });
        }

        if (trackIndex >= seq.videoTracks.numTracks) {
            return JSON.stringify({ error: 'Track index ' + trackIndex + ' out of range.' });
        }

        var track = seq.videoTracks[trackIndex];
        var clipCount = 0;
        try {
            clipCount = track.clips.numItems;
        } catch (e) {
            return JSON.stringify({ error: 'Cannot read clips on V' + (trackIndex + 1) + ': ' + e.message });
        }

        var enabled = 0;
        var disabled = 0;
        var errors = [];

        $.writeln('[AutoCam] Enable/disable V' + (trackIndex + 1) + ': ' + clipCount + ' clips');

        for (var c = 0; c < clipCount; c++) {
            try {
                var clip = track.clips[c];

                // Get clip time range
                var clipStart = $._autocam_.timeToSeconds(clip.start);
                var clipEnd = $._autocam_.timeToSeconds(clip.end);
                var midpoint = (clipStart + clipEnd) / 2;

                // Look up which camera should be active at this clip's midpoint
                var activeCamera = $._autocam_.getActiveCameraAt(intervals, midpoint);

                if (trackIndex === activeCamera) {
                    // This track IS the active camera — make it visible
                    clip.disabled = false;
                    enabled++;
                } else {
                    // This track is NOT the active camera — hide it
                    clip.disabled = true;
                    disabled++;
                }
            } catch (e) {
                if (errors.length < 5) {
                    errors.push('V' + (trackIndex + 1) + ' clip ' + c + ': ' + e.message);
                }
            }
        }

        // SAFETY GUARD: If ALL clips on this track are disabled, force-enable the first clip
        // This prevents entire video tracks from disappearing (e.g., wide camera track)
        if (enabled === 0 && clipCount > 0) {
            $.writeln('[AutoCam] WARNING: V' + (trackIndex + 1) + ' has 0 enabled clips! Enabling first clip as safety guard.');
            try {
                track.clips[0].disabled = false;
                enabled = 1;
                disabled = Math.max(0, disabled - 1);
            } catch (guardErr) {
                $.writeln('[AutoCam] Guard failed: ' + guardErr.message);
            }
        }

        // Update running totals
        prep.enabledTotal += enabled;
        prep.disabledTotal += disabled;

        $.writeln('[AutoCam] V' + (trackIndex + 1) + ' done: ' + enabled + ' enabled, ' + disabled + ' disabled');

        return JSON.stringify({
            enabled: enabled,
            disabled: disabled,
            clipCount: clipCount,
            trackIndex: trackIndex,
            errors: errors
        });

    } catch (e) {
        $.writeln('[AutoCam] enableDisableTrack ERROR: ' + e.message);
        return JSON.stringify({
            error: 'enableDisableTrack failed: ' + e.message,
            line: e.line || 'unknown'
        });
    }
};

// ============================================================
// LAYER 6: SAFE RIPPLE DELETE (SILENCE REMOVAL)
// ============================================================

/**
 * Remove silence gaps from the timeline using ripple extract.
 * Processes gaps in REVERSE chronological order to avoid cascade position shifts.
 *
 * Safety checks per gap:
 *   1. Locked tracks are skipped with warning
 *   2. Gaps too short after safety buffer are skipped
 *
 * Uses the in/out point + extract workflow:
 *   seq.setInPoint(start) -> seq.setOutPoint(end) -> seq.extractWorkArea(true)
 *
 * @param {string} gapsJsonStr - JSON array of {paddedStart, paddedEnd, durationMs}
 * @returns {string} JSON result with {removed, skipped, totalRemovedSeconds, errors, newDuration}
 */
$._autocam_.rippleDeleteSilence = function (gapsJsonStr) {
    try {
        $.writeln('[AutoCam] === RIPPLE DELETE SILENCE (Layer 6) ===');

        var gaps = JSON.parse(gapsJsonStr);
        if (!gaps || gaps.length === 0) {
            return JSON.stringify({ error: 'No silence gaps provided.' });
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ error: 'No active sequence.' });
        }

        $.writeln('[AutoCam] Active sequence for ripple: ' + seq.name);
        $.writeln('[AutoCam] Processing ' + gaps.length + ' silence gaps');

        // Probe test: verify extractWorkArea is available
        var testSupported = true;
        try {
            if (typeof seq.extractWorkArea !== 'function') testSupported = false;
        } catch(e) { testSupported = false; }
        if (!testSupported) {
            return JSON.stringify({
                error: 'seq.extractWorkArea not available in this Premiere version.',
                sequenceName: seq.name
            });
        }

        // Sort gaps by paddedStart in REVERSE order (latest first)
        // Critical: prevents cascade position shifts
        gaps.sort(function (a, b) {
            return b.paddedStart - a.paddedStart;
        });

        // Safety: Check for locked tracks
        var lockedTracks = [];
        for (var lt = 0; lt < seq.videoTracks.numTracks; lt++) {
            try {
                if (seq.videoTracks[lt].isLocked && seq.videoTracks[lt].isLocked()) {
                    lockedTracks.push('V' + (lt + 1));
                }
            } catch (e) {
                // isLocked may not be available in all versions
            }
        }
        for (var la = 0; la < seq.audioTracks.numTracks; la++) {
            try {
                if (seq.audioTracks[la].isLocked && seq.audioTracks[la].isLocked()) {
                    lockedTracks.push('A' + (la + 1));
                }
            } catch (e) {
                // isLocked may not be available
            }
        }

        if (lockedTracks.length > 0) {
            $.writeln('[AutoCam] WARNING: Locked tracks detected: ' + lockedTracks.join(', '));
        }

        var removed = 0;
        var skipped = 0;
        var totalRemovedSeconds = 0;
        var errors = [];

        // Premiere ticks per second for Time object creation
        var TICKS_PER_SECOND = 254016000000;

        for (var g = 0; g < gaps.length; g++) {
            var gap = gaps[g];

            try {
                var gapStart = gap.paddedStart;
                var gapEnd = gap.paddedEnd;
                var gapDuration = gapEnd - gapStart;

                if (gapDuration < 0.05) {
                    skipped++;
                    continue; // Skip trivially small gaps
                }

                $.writeln('[AutoCam] Removing gap: ' + gapStart.toFixed(3) + 's - ' + gapEnd.toFixed(3) + 's (' + gapDuration.toFixed(3) + 's)');

                // Set in/out points using ticks for precision
                var inTicks = String(Math.round(gapStart * TICKS_PER_SECOND));
                var outTicks = String(Math.round(gapEnd * TICKS_PER_SECOND));

                seq.setInPoint(inTicks);
                seq.setOutPoint(outTicks);

                // Extract work area (ripple delete)
                // extractWorkArea(true) = extract with ripple (closes gap)
                // extractWorkArea(false) = lift (leaves gap)
                try {
                    seq.extractWorkArea(true);
                    removed++;
                    totalRemovedSeconds += gapDuration;
                    $.writeln('[AutoCam]   Removed successfully');
                } catch (extractErr) {
                    // Fallback approach: try using QE DOM
                    $.writeln('[AutoCam]   extractWorkArea failed: ' + extractErr.message + ', trying QE...');
                    try {
                        app.enableQE();
                        var qeSeq = qe.project.getActiveSequence();
                        if (qeSeq) {
                            // QE may support different extraction methods
                            // This is a best-effort fallback
                            skipped++;
                            var msg = 'Gap at ' + gapStart.toFixed(2) + 's: extractWorkArea not available, skipped';
                            if (errors.length < 10) {
                                errors.push(msg);
                            }
                            $.writeln('[AutoCam]   ' + msg);
                        }
                    } catch (qeErr) {
                        skipped++;
                        var qeMsg = 'Gap at ' + gapStart.toFixed(2) + 's: ' + extractErr.message;
                        if (errors.length < 10) {
                            errors.push(qeMsg);
                        }
                        $.writeln('[AutoCam]   ' + qeMsg);
                    }
                }

                // Small pause between operations for stability
                $.sleep(100);

            } catch (gapErr) {
                skipped++;
                var gapMsg = 'Gap ' + g + ': ' + gapErr.message;
                if (errors.length < 10) {
                    errors.push(gapMsg);
                }
                $.writeln('[AutoCam]   ' + gapMsg);
            }
        }

        // Clear in/out points after processing
        try {
            seq.setInPoint('');
            seq.setOutPoint('');
        } catch (e) {
            // Non-critical
        }

        // Get new duration
        var newDuration = $._autocam_.getSequenceDuration(seq);

        $.writeln('[AutoCam] Ripple delete complete: ' + removed + ' removed, ' + skipped + ' skipped, ' + totalRemovedSeconds.toFixed(2) + 's total');

        return JSON.stringify({
            success: true,
            removed: removed,
            skipped: skipped,
            totalRemovedSeconds: totalRemovedSeconds,
            errors: errors,
            lockedTracks: lockedTracks,
            newDuration: newDuration
        });

    } catch (e) {
        $.writeln('[AutoCam] rippleDeleteSilence ERROR: ' + e.message + ' (line ' + (e.line || '?') + ')');
        return JSON.stringify({
            error: 'rippleDeleteSilence failed: ' + e.message,
            line: e.line || 'unknown'
        });
    }
};

// ============================================================
// SUMMARY / FINALIZE
// ============================================================

/**
 * Get a summary of the entire apply operation.
 * Call after all razor batches and enable/disable tracks are done.
 *
 * @returns {string} JSON result with totals
 */
$._autocam_.getApplySummary = function () {
    if (!$._autocam_._prepared) {
        return JSON.stringify({ error: 'No prepared data.' });
    }

    var prep = $._autocam_._prepared;

    return JSON.stringify({
        success: true,
        totalCuts: prep.cuts.length,
        totalTimecodes: prep.timecodes.length,
        razorSuccess: prep.razorSuccess,
        razorFailed: prep.razorFailed,
        clipsEnabled: prep.enabledTotal,
        clipsDisabled: prep.disabledTotal,
        videoTrackCount: prep.videoTrackCount
    });
};

// ============================================================
// UNDO HELPER
// ============================================================

/**
 * Re-enable all clips on all video tracks.
 * Useful for resetting a timeline after a failed or unwanted auto-edit.
 *
 * @returns {string} JSON result
 */
$._autocam_.resetAllClips = function () {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ error: 'No active sequence.' });
        }

        var count = 0;
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                try {
                    track.clips[c].disabled = false;
                    count++;
                } catch (e) {
                    // Skip
                }
            }
        }

        return JSON.stringify({ success: true, clipsReset: count });
    } catch (e) {
        return JSON.stringify({ error: 'Reset failed: ' + e.message });
    }
};
