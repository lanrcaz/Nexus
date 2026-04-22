/**
 * Auto Multi-Cam Edit - Sequence Reader
 * Reads active sequence metadata: tracks, clips, source file paths, frame rate.
 */

/**
 * Detect if a frame rate is drop-frame.
 * Drop-frame applies to 29.97fps and 59.94fps.
 *
 * @param {number} fps - Frame rate
 * @returns {boolean} True if drop-frame
 */
$._autocam_.isDropFrame = function (fps) {
    var rounded = Math.round(fps * 100) / 100;
    return (Math.abs(rounded - 29.97) < 0.02) || (Math.abs(rounded - 59.94) < 0.02);
};

/**
 * Convert seconds to timecode string for QE DOM razor().
 * Non-drop-frame: "HH:MM:SS:FF" (colons)
 * Drop-frame (29.97/59.94): "HH;MM;SS;FF" (semicolons + SMPTE frame skip)
 *
 * Drop-frame skips frame numbers 0,1 (or 0-3 for 59.94) at the start
 * of each minute, EXCEPT every 10th minute (00, 10, 20, 30, 40, 50).
 *
 * @param {number} totalSeconds - Time in seconds
 * @param {number} fps - Frames per second (e.g., 24, 29.97, 30, 59.94)
 * @returns {string} Timecode string
 */
$._autocam_.secondsToTimecode = function (totalSeconds, fps) {
    if (totalSeconds < 0) totalSeconds = 0;

    function pad(num) {
        var s = String(num);
        while (s.length < 2) s = '0' + s;
        return s;
    }

    var isDF = $._autocam_.isDropFrame(fps);
    var roundedFps = Math.round(fps);

    if (!isDF) {
        // Non-drop-frame: simple division, colon separators
        var totalFrames = Math.round(totalSeconds * roundedFps);
        var ff = totalFrames % roundedFps;
        var totalSecs = Math.floor(totalFrames / roundedFps);
        var ss = totalSecs % 60;
        var totalMins = Math.floor(totalSecs / 60);
        var mm = totalMins % 60;
        var hh = Math.floor(totalMins / 60);
        return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);
    }

    // Drop-frame timecode (SMPTE 12M standard)
    var d = (roundedFps === 30) ? 2 : 4;  // frames to skip per minute
    var totalFramesDF = Math.round(totalSeconds * fps);
    var fpm = roundedFps * 60 - d;         // frames per regular minute (1798 for 29.97)
    var fp10m = fpm * 10 + d;              // frames per 10-min block (17982 for 29.97)

    var blocks10 = Math.floor(totalFramesDF / fp10m);
    var rem10 = totalFramesDF % fp10m;
    var extraMin = (rem10 < d) ? 0 : Math.floor((rem10 - d) / fpm) + 1;

    // Add back the skipped frame numbers to get display frame
    var displayFrame = totalFramesDF + d * (9 * blocks10 + extraMin);

    var dfFF = displayFrame % roundedFps;
    var dfTotalSecs = Math.floor(displayFrame / roundedFps);
    var dfSS = dfTotalSecs % 60;
    var dfTotalMins = Math.floor(dfTotalSecs / 60);
    var dfMM = dfTotalMins % 60;
    var dfHH = Math.floor(dfTotalMins / 60);

    // Semicolon separators for drop-frame
    return pad(dfHH) + ';' + pad(dfMM) + ';' + pad(dfSS) + ';' + pad(dfFF);
};

/**
 * Convert a Premiere Time object to seconds.
 * Premiere's Time object has a .seconds property but also .ticks for precision.
 *
 * @param {Time} timeObj - Premiere Time object
 * @returns {number} Time in seconds
 */
$._autocam_.timeToSeconds = function (timeObj) {
    if (!timeObj) return 0;
    if (typeof timeObj.seconds !== 'undefined') {
        return parseFloat(timeObj.seconds);
    }
    // Fallback: try ticks-based conversion
    if (typeof timeObj.ticks !== 'undefined') {
        // Premiere uses 254016000000 ticks per second
        return parseFloat(timeObj.ticks) / 254016000000;
    }
    return 0;
};

/**
 * Get the frame rate of the active sequence.
 * Tries multiple approaches since there's no direct frameRate property.
 *
 * @param {Sequence} seq - The active sequence
 * @returns {number} Frame rate (e.g., 29.97, 24, 30)
 */
$._autocam_.getFrameRate = function (seq) {
    // Approach 1: Use seq.timebase (ticks per frame) — most reliable
    // seq.timebase returns ticks-per-frame, NOT the frame rate itself
    // Premiere Pro uses 254016000000 ticks per second
    try {
        if (seq.timebase) {
            var ticksPerFrame = parseFloat(seq.timebase);
            if (ticksPerFrame > 0) {
                var fps = 254016000000 / ticksPerFrame;
                $.writeln('[AutoCam] Frame rate from timebase: ' + fps);
                return fps;
            }
        }
    } catch (e) {
        $.writeln('[AutoCam] getFrameRate approach 1 (timebase) failed: ' + e.message);
    }

    // Approach 2: Use QE DOM to get frame rate string
    try {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (qeSeq) {
            // QE DOM may expose frame rate info
            var numTracks = qeSeq.numVideoTracks;
            $.writeln('[AutoCam] QE sequence found, video tracks: ' + numTracks);
        }
    } catch (e) {
        $.writeln('[AutoCam] getFrameRate approach 2 (QE DOM) failed: ' + e.message);
    }

    // Default fallback
    $.writeln('[AutoCam] WARNING: Could not determine frame rate, defaulting to 29.97');
    return 29.97;
};

/**
 * Get the total duration of the sequence in seconds.
 *
 * @param {Sequence} seq - The active sequence
 * @returns {number} Duration in seconds
 */
$._autocam_.getSequenceDuration = function (seq) {
    try {
        if (seq.end && typeof seq.end !== 'undefined') {
            return $._autocam_.timeToSeconds(seq.end);
        }
    } catch (e) {
        $.writeln('[AutoCam] getSequenceDuration from seq.end failed: ' + e.message);
    }

    // Fallback: find the latest clip end time across all tracks
    var maxEnd = 0;
    try {
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clipEnd = $._autocam_.timeToSeconds(track.clips[c].end);
                if (clipEnd > maxEnd) maxEnd = clipEnd;
            }
        }
        for (var t2 = 0; t2 < seq.audioTracks.numTracks; t2++) {
            var aTrack = seq.audioTracks[t2];
            for (var c2 = 0; c2 < aTrack.clips.numItems; c2++) {
                var aClipEnd = $._autocam_.timeToSeconds(aTrack.clips[c2].end);
                if (aClipEnd > maxEnd) maxEnd = aClipEnd;
            }
        }
    } catch (e) {
        $.writeln('[AutoCam] getSequenceDuration fallback failed: ' + e.message);
    }

    return maxEnd;
};

/**
 * Main function: Read all sequence metadata and return as JSON string.
 * Called from CEP panel via csInterface.evalScript.
 *
 * @returns {string} JSON string with sequence info, or error JSON
 */
$._autocam_.getSequenceInfo = function () {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({
                error: 'No active sequence. Please open a sequence in Premiere Pro.'
            });
        }

        var fps = $._autocam_.getFrameRate(seq);
        var duration = $._autocam_.getSequenceDuration(seq);

        // Read video tracks
        var videoTracks = [];
        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            var vTrack = seq.videoTracks[v];
            var vClipCount = 0;
            try {
                vClipCount = vTrack.clips.numItems;
            } catch (e) {
                vClipCount = 0;
            }
            videoTracks.push({
                index: v,
                name: vTrack.name || ('V' + (v + 1)),
                clipCount: vClipCount
            });
        }

        // Read audio tracks with source file paths
        var audioTracks = [];
        for (var a = 0; a < seq.audioTracks.numTracks; a++) {
            var aTrack = seq.audioTracks[a];
            var clips = [];
            try {
                for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
                    var clip = aTrack.clips[ac];
                    var mediaPath = '';
                    var clipName = '';
                    var audioStreamIndex = 0;

                    try {
                        clipName = clip.name || '';
                    } catch (e) {
                        clipName = 'Unknown';
                    }

                    try {
                        if (clip.projectItem) {
                            mediaPath = clip.projectItem.getMediaPath() || '';
                        }
                    } catch (e) {
                        $.writeln('[AutoCam] Could not get media path for clip: ' + clipName);
                    }

                    var clipStart = $._autocam_.timeToSeconds(clip.start);
                    var clipEnd = $._autocam_.timeToSeconds(clip.end);
                    var inPoint = 0;
                    var outPoint = 0;
                    try {
                        inPoint = $._autocam_.timeToSeconds(clip.inPoint);
                        outPoint = $._autocam_.timeToSeconds(clip.outPoint);
                    } catch (e) {
                        // inPoint/outPoint may not be accessible
                    }

                    clips.push({
                        name: clipName,
                        mediaPath: mediaPath,
                        startSeconds: clipStart,
                        endSeconds: clipEnd,
                        inPointSeconds: inPoint,
                        outPointSeconds: outPoint
                    });
                }
            } catch (e) {
                $.writeln('[AutoCam] Error reading audio track ' + a + ' clips: ' + e.message);
            }

            audioTracks.push({
                index: a,
                name: aTrack.name || ('A' + (a + 1)),
                clipCount: clips.length,
                clips: clips
            });
        }

        var result = {
            sequenceName: seq.name || 'Untitled Sequence',
            frameRate: fps,
            durationSeconds: duration,
            videoTrackCount: seq.videoTracks.numTracks,
            audioTrackCount: seq.audioTracks.numTracks,
            videoTracks: videoTracks,
            audioTracks: audioTracks
        };

        return JSON.stringify(result);

    } catch (e) {
        return JSON.stringify({
            error: 'Failed to read sequence: ' + e.message
        });
    }
};
