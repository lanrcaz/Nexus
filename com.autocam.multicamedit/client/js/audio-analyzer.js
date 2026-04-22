/**
 * Auto Multi-Cam Edit - Conversation-Aware Audio Analyzer (Node.js Module)
 *
 * 7-Layer Analysis Pipeline:
 *   Layer 1: Audio extraction + RMS (50ms windows) + noise floor calibration + smoothing
 *   Layer 2: Speech Segment Builder (onset/offset detection, duration classification)
 *   Layer 3: Conversation State Machine (inertia, core rules, suppression)
 *   Layer 4: Rhythm & Emotion Engine (tempo zones, emotional spikes)
 *   Layer 5: Camera Decision Engine (weighted selection, memory, spike bias)
 *   + Silence gap identification for Layer 6 (Safe Ripple Engine)
 *
 * Usage from main.js:
 *   const analyzer = cep_node.require(__dirname + '/audio-analyzer.js');
 *   analyzer.analyze(config, onProgress, onComplete);
 */

(function () {
    'use strict';

    var path = require('path');
    var fs = require('fs');
    var childProcess = require('child_process');

    // ============================================================
    // CONSTANTS
    // ============================================================

    var SAMPLE_RATE = 16000;         // 16kHz - sufficient for speech detection
    var WINDOW_SIZE_MS = 50;         // 50ms analysis windows (was 100ms)
    var SAMPLES_PER_WINDOW = SAMPLE_RATE * WINDOW_SIZE_MS / 1000; // 800 samples
    var BYTES_PER_SAMPLE = 4;        // float32
    var BYTES_PER_WINDOW = SAMPLES_PER_WINDOW * BYTES_PER_SAMPLE; // 3200 bytes

    // ============================================================
    // LAYER 1A: FFMPEG UTILITIES (unchanged)
    // ============================================================

    /**
     * Find FFmpeg binary path.
     * Priority: bundled bin/ folder -> system PATH
     */
    function findFFmpeg(extensionRoot) {
        var bundledPath;
        if (process.platform === 'win32') {
            bundledPath = path.join(extensionRoot, 'bin', 'ffmpeg.exe');
        } else {
            bundledPath = path.join(extensionRoot, 'bin', 'ffmpeg');
        }

        if (fs.existsSync(bundledPath)) {
            return bundledPath;
        }

        return 'ffmpeg';
    }

    /**
     * Check if FFmpeg is available.
     */
    function checkFFmpeg(ffmpegPath, callback) {
        try {
            var proc = childProcess.spawn(ffmpegPath, ['-version'], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            var output = '';
            proc.stdout.on('data', function (data) {
                output += data.toString();
            });
            proc.on('close', function (code) {
                if (code === 0) {
                    var versionMatch = output.match(/ffmpeg version (\S+)/);
                    var version = versionMatch ? versionMatch[1] : 'unknown';
                    callback(null, version);
                } else {
                    callback(new Error('FFmpeg exited with code ' + code));
                }
            });
            proc.on('error', function (err) {
                callback(new Error('FFmpeg not found at: ' + ffmpegPath + '. ' + err.message));
            });
        } catch (e) {
            callback(e);
        }
    }

    // ============================================================
    // LAYER 1B: AUDIO EXTRACTION + RMS COMPUTATION
    // ============================================================

    /**
     * Extract audio from a media file and compute RMS per 50ms window.
     * Streams PCM float32 from FFmpeg stdout.
     */
    function extractAndAnalyze(ffmpegPath, mediaPath, onWindow, onComplete) {
        var args = [
            '-i', mediaPath,
            '-vn',              // No video
            '-ac', '1',         // Mono
            '-ar', String(SAMPLE_RATE),
            '-f', 'f32le',      // 32-bit float little-endian
            '-y',
            'pipe:1'
        ];

        var proc = childProcess.spawn(ffmpegPath, args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        var buffer = Buffer.alloc(0);
        var windowIndex = 0;
        var stderrOutput = '';

        proc.stdout.on('data', function (chunk) {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= BYTES_PER_WINDOW) {
                var windowBuffer = buffer.slice(0, BYTES_PER_WINDOW);
                buffer = buffer.slice(BYTES_PER_WINDOW);

                var sumSquares = 0;
                for (var i = 0; i < SAMPLES_PER_WINDOW; i++) {
                    var sample = windowBuffer.readFloatLE(i * BYTES_PER_SAMPLE);
                    sumSquares += sample * sample;
                }
                var rms = Math.sqrt(sumSquares / SAMPLES_PER_WINDOW);
                var rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;

                onWindow(windowIndex, rmsDb);
                windowIndex++;
            }
        });

        proc.stderr.on('data', function (chunk) {
            stderrOutput += chunk.toString();
        });

        proc.on('close', function (code) {
            if (code === 0 || code === null) {
                // Process remaining partial window
                if (buffer.length > BYTES_PER_SAMPLE) {
                    var remainingSamples = Math.floor(buffer.length / BYTES_PER_SAMPLE);
                    var sumSquares = 0;
                    for (var i = 0; i < remainingSamples; i++) {
                        var sample = buffer.readFloatLE(i * BYTES_PER_SAMPLE);
                        sumSquares += sample * sample;
                    }
                    var rms = Math.sqrt(sumSquares / remainingSamples);
                    var rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;
                    onWindow(windowIndex, rmsDb);
                    windowIndex++;
                }
                onComplete(null, windowIndex);
            } else {
                onComplete(new Error('FFmpeg error (code ' + code + '): ' + stderrOutput.slice(-500)));
            }
        });

        proc.on('error', function (err) {
            onComplete(new Error('FFmpeg process error: ' + err.message));
        });
    }

    // ============================================================
    // LAYER 1B2: CLIP-AWARE AUDIO EXTRACTION
    // ============================================================

    /**
     * Extract audio from a specific clip region using FFmpeg seek.
     * Uses -ss (seek start) BEFORE -i for fast input seeking,
     * and -t (duration) to extract only the trimmed source region.
     *
     * @param {string} ffmpegPath - Path to FFmpeg binary
     * @param {string} mediaPath - Source media file path
     * @param {number} inPointSec - Source in-point in seconds
     * @param {number} outPointSec - Source out-point in seconds
     * @param {function} onWindow - callback(windowIndex, rmsDb) per 50ms window
     * @param {function} onComplete - callback(err, totalWindows)
     */
    function extractAndAnalyzeClip(ffmpegPath, mediaPath, inPointSec, outPointSec, onWindow, onComplete) {
        var duration = outPointSec - inPointSec;
        if (duration <= 0) {
            onComplete(null, 0);
            return;
        }

        var args = [
            '-ss', String(inPointSec),    // Seek to source in-point (fast input seek)
            '-t', String(duration),        // Extract only the trimmed duration
            '-i', mediaPath,
            '-vn',
            '-ac', '1',
            '-ar', String(SAMPLE_RATE),
            '-f', 'f32le',
            '-y',
            'pipe:1'
        ];

        var proc = childProcess.spawn(ffmpegPath, args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        var buffer = Buffer.alloc(0);
        var windowIndex = 0;
        var stderrOutput = '';

        proc.stdout.on('data', function (chunk) {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= BYTES_PER_WINDOW) {
                var windowBuffer = buffer.slice(0, BYTES_PER_WINDOW);
                buffer = buffer.slice(BYTES_PER_WINDOW);

                var sumSquares = 0;
                for (var i = 0; i < SAMPLES_PER_WINDOW; i++) {
                    var sample = windowBuffer.readFloatLE(i * BYTES_PER_SAMPLE);
                    sumSquares += sample * sample;
                }
                var rms = Math.sqrt(sumSquares / SAMPLES_PER_WINDOW);
                var rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;

                onWindow(windowIndex, rmsDb);
                windowIndex++;
            }
        });

        proc.stderr.on('data', function (chunk) {
            stderrOutput += chunk.toString();
        });

        proc.on('close', function (code) {
            if (code === 0 || code === null) {
                if (buffer.length > BYTES_PER_SAMPLE) {
                    var remainingSamples = Math.floor(buffer.length / BYTES_PER_SAMPLE);
                    var sumSquares = 0;
                    for (var i = 0; i < remainingSamples; i++) {
                        var sample = buffer.readFloatLE(i * BYTES_PER_SAMPLE);
                        sumSquares += sample * sample;
                    }
                    var rms = Math.sqrt(sumSquares / remainingSamples);
                    var rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;
                    onWindow(windowIndex, rmsDb);
                    windowIndex++;
                }
                onComplete(null, windowIndex);
            } else {
                onComplete(new Error('FFmpeg clip error (code ' + code + '): ' + stderrOutput.slice(-500)));
            }
        });

        proc.on('error', function (err) {
            onComplete(new Error('FFmpeg clip process error: ' + err.message));
        });
    }

    /**
     * Extract and analyze ALL clips on a single audio track,
     * placing RMS windows at correct timeline positions.
     * Gaps between clips are filled with silence (-100 dB).
     *
     * @param {string} ffmpegPath - Path to FFmpeg binary
     * @param {Array} clips - Array of {mediaPath, startSeconds, endSeconds, inPointSeconds, outPointSeconds}
     * @param {number} timelineDurationSec - Total timeline duration for sizing the output array
     * @param {function} onClipProgress - callback(message) for status updates
     * @param {function} onComplete - callback(err, rmsWindows) where rmsWindows is a flat array
     */
    function extractMultiClipTrack(ffmpegPath, clips, timelineDurationSec, onClipProgress, onComplete) {
        var windowDuration = WINDOW_SIZE_MS / 1000; // 0.05s
        var totalTimelineWindows = Math.ceil(timelineDurationSec / windowDuration);

        // Pre-fill entire timeline with silence
        var rmsWindows = new Array(totalTimelineWindows);
        for (var i = 0; i < totalTimelineWindows; i++) {
            rmsWindows[i] = -100;
        }

        // Sort clips by timeline start position (defensive)
        clips.sort(function (a, b) { return a.startSeconds - b.startSeconds; });

        var clipIndex = 0;

        function processNextClip() {
            if (clipIndex >= clips.length) {
                onComplete(null, rmsWindows);
                return;
            }

            var clip = clips[clipIndex];
            clipIndex++;

            // Skip clips with no media
            if (!clip.mediaPath || clip.mediaPath === '') {
                onClipProgress('Clip ' + clipIndex + '/' + clips.length + ': no media path, filling silence');
                processNextClip();
                return;
            }

            // Validate file exists
            if (!fs.existsSync(clip.mediaPath)) {
                onClipProgress('Clip ' + clipIndex + '/' + clips.length + ': file not found, filling silence');
                processNextClip();
                return;
            }

            var timelineStartWindow = Math.floor(clip.startSeconds / windowDuration);
            var inPoint = clip.inPointSeconds || 0;
            var outPoint = clip.outPointSeconds || 0;

            // If in/out points are zero or invalid, derive from timeline duration
            if (outPoint <= inPoint) {
                outPoint = inPoint + (clip.endSeconds - clip.startSeconds);
            }

            onClipProgress('Clip ' + clipIndex + '/' + clips.length + ': ' +
                path.basename(clip.mediaPath) + ' [' +
                clip.startSeconds.toFixed(1) + 's-' + clip.endSeconds.toFixed(1) + 's]');

            extractAndAnalyzeClip(
                ffmpegPath,
                clip.mediaPath,
                inPoint,
                outPoint,
                function (windowIndex, rmsDb) {
                    // Place this window at the correct timeline position
                    var targetWindow = timelineStartWindow + windowIndex;
                    if (targetWindow >= 0 && targetWindow < totalTimelineWindows) {
                        // Handle overlap: take the louder value
                        if (rmsWindows[targetWindow] === -100 || rmsDb > rmsWindows[targetWindow]) {
                            rmsWindows[targetWindow] = rmsDb;
                        }
                    }
                },
                function (err, totalWindows) {
                    if (err) {
                        onClipProgress('WARNING: Clip ' + clipIndex + ' failed: ' + err.message);
                    }
                    processNextClip();
                }
            );
        }

        processNextClip();
    }

    // ============================================================
    // LAYER 1C: RMS SMOOTHING
    // ============================================================

    /**
     * Apply 3-window rolling average to smooth RMS data.
     * Used for noise floor calibration and tempo zone detection.
     * NOTE: Speech segment builder uses RAW data (not smoothed) for precise onset.
     *
     * @param {Array[]} rmsData - rmsData[trackIdx][windowIdx] = dB
     * @returns {Array[]} smoothed[trackIdx][windowIdx] = averaged dB
     */
    function smoothRmsData(rmsData) {
        var smoothed = [];
        for (var t = 0; t < rmsData.length; t++) {
            var track = rmsData[t];
            var s = [];
            for (var w = 0; w < track.length; w++) {
                var prev = (w > 0) ? track[w - 1] : track[w];
                var curr = track[w];
                var next = (w < track.length - 1) ? track[w + 1] : track[w];
                s.push((prev + curr + next) / 3);
            }
            smoothed.push(s);
        }
        return smoothed;
    }

    // ============================================================
    // LAYER 1D: NOISE FLOOR CALIBRATION
    // ============================================================

    /**
     * Calibrate noise floor per track from the first N seconds of audio.
     * Algorithm: Take first calibrationWindows, sort by value, discard top 20%,
     * average the rest. This filters out speech bleed during calibration period.
     *
     * @param {Array[]} rmsData - rmsData[trackIdx][windowIdx] = dB
     * @param {number} calibrationWindows - Number of windows to analyze (default 60 = 3s at 50ms)
     * @returns {Array} noiseFloors[trackIdx] = dB value
     */
    function calibrateNoiseFloor(rmsData, calibrationWindows) {
        calibrationWindows = calibrationWindows || 60; // 3 seconds at 50ms windows
        var noiseFloors = [];

        for (var t = 0; t < rmsData.length; t++) {
            var track = rmsData[t];
            var calWindow = Math.min(calibrationWindows, track.length);

            if (calWindow === 0) {
                noiseFloors.push(-60); // Default if no data
                continue;
            }

            // Collect calibration windows and sort
            var calValues = [];
            for (var w = 0; w < calWindow; w++) {
                calValues.push(track[w]);
            }
            calValues.sort(function (a, b) { return a - b; });

            // Discard top 20% (likely speech bleed)
            var keepCount = Math.max(1, Math.floor(calValues.length * 0.8));
            var sum = 0;
            for (var i = 0; i < keepCount; i++) {
                sum += calValues[i];
            }

            noiseFloors.push(sum / keepCount);
        }

        return noiseFloors;
    }

    // ============================================================
    // LAYER 2: SPEECH SEGMENT BUILDER
    // ============================================================

    /**
     * Build contiguous speech segments from raw RMS data.
     * Uses RAW (not smoothed) RMS for precise onset detection.
     *
     * Speech starts when RMS > threshold for sustained speechStartMs.
     * Speech ends when RMS < threshold for sustained speechEndMs.
     *
     * Classification by duration:
     *   < 0.7s  → REACTION
     *   0.7-1.5s → SHORT_SPEECH
     *   > 1.5s  → PRIMARY_SPEECH
     *
     * @param {Array[]} rmsData - rmsData[trackIdx][windowIdx] = dB (raw)
     * @param {Array} thresholds - Per-track threshold in dB
     * @param {Object} config - {speechStartMs, speechEndMs}
     * @returns {Array[]} segments[trackIdx] = [{startSec, endSec, peakRms, avgRms, type, trackIdx}]
     */
    function buildSpeechSegments(rmsData, thresholds, config) {
        var windowMs = WINDOW_SIZE_MS;
        var speechStartWindows = Math.ceil((config.speechStartMs || 120) / windowMs); // ~3 windows
        var speechEndWindows = Math.ceil((config.speechEndMs || 200) / windowMs);     // ~4 windows

        var allSegments = [];

        for (var t = 0; t < rmsData.length; t++) {
            var track = rmsData[t];
            var threshold = thresholds[t];
            var trackSegments = [];

            var inSpeech = false;
            var segStartWindow = -1;
            var consecutiveAbove = 0;
            var consecutiveBelow = 0;
            var peakRms = -100;
            var sumRms = 0;
            var windowCount = 0;

            for (var w = 0; w < track.length; w++) {
                var db = track[w];
                var aboveThreshold = db > threshold;

                if (!inSpeech) {
                    if (aboveThreshold) {
                        consecutiveAbove++;
                        if (consecutiveAbove >= speechStartWindows) {
                            // Speech onset confirmed
                            inSpeech = true;
                            segStartWindow = w - speechStartWindows + 1;
                            peakRms = -100;
                            sumRms = 0;
                            windowCount = 0;
                            // Accumulate from segment start
                            for (var sw = segStartWindow; sw <= w; sw++) {
                                if (track[sw] > peakRms) peakRms = track[sw];
                                sumRms += track[sw];
                                windowCount++;
                            }
                        }
                    } else {
                        consecutiveAbove = 0;
                    }
                } else {
                    // In speech
                    if (aboveThreshold) {
                        consecutiveBelow = 0;
                        if (db > peakRms) peakRms = db;
                        sumRms += db;
                        windowCount++;
                    } else {
                        consecutiveBelow++;
                        // Still count these windows for RMS averaging
                        sumRms += db;
                        windowCount++;

                        if (consecutiveBelow >= speechEndWindows) {
                            // Speech ended
                            var segEndWindow = w - speechEndWindows;
                            var startSec = segStartWindow * windowMs / 1000;
                            var endSec = segEndWindow * windowMs / 1000;
                            var durationSec = endSec - startSec;

                            if (durationSec > 0.01) { // Skip zero-length
                                var type;
                                if (durationSec < 0.7) {
                                    type = 'REACTION';
                                } else if (durationSec < 1.5) {
                                    type = 'SHORT_SPEECH';
                                } else {
                                    type = 'PRIMARY_SPEECH';
                                }

                                trackSegments.push({
                                    startSec: startSec,
                                    endSec: endSec,
                                    peakRms: peakRms,
                                    avgRms: windowCount > 0 ? sumRms / windowCount : -100,
                                    type: type,
                                    trackIdx: t
                                });
                            }

                            inSpeech = false;
                            consecutiveAbove = 0;
                            consecutiveBelow = 0;
                            peakRms = -100;
                            sumRms = 0;
                            windowCount = 0;
                        }
                    }
                }
            }

            // Close any open segment at end of track
            if (inSpeech && segStartWindow >= 0) {
                var finalStart = segStartWindow * windowMs / 1000;
                var finalEnd = track.length * windowMs / 1000;
                var finalDur = finalEnd - finalStart;
                if (finalDur > 0.01) {
                    var finalType = finalDur < 0.7 ? 'REACTION' : finalDur < 1.5 ? 'SHORT_SPEECH' : 'PRIMARY_SPEECH';
                    trackSegments.push({
                        startSec: finalStart,
                        endSec: finalEnd,
                        peakRms: peakRms,
                        avgRms: windowCount > 0 ? sumRms / windowCount : -100,
                        type: finalType,
                        trackIdx: t
                    });
                }
            }

            allSegments.push(trackSegments);
        }

        return allSegments;
    }

    // ============================================================
    // LAYER 4: RHYTHM & EMOTION ENGINE
    // ============================================================

    /**
     * Detect tempo zones across the timeline.
     * Every 500ms (10 windows), classify conversation energy as FAST/NORMAL/CALM.
     *
     * @param {Array} conversationStates - Per-window state array from buildConversationStates()
     * @param {Array[]} rmsSmoothed - Smoothed RMS data
     * @param {number} maxWindows - Total window count
     * @returns {Array} tempoZones[zoneIdx] = {zone, startWindow, endWindow}
     */
    function detectTempoZones(conversationStates, rmsSmoothed, maxWindows) {
        var TEMPO_WINDOW = 10; // 10 * 50ms = 500ms
        var zones = [];

        for (var tz = 0; tz < maxWindows; tz += TEMPO_WINDOW) {
            var zoneEnd = Math.min(tz + TEMPO_WINDOW, maxWindows);
            var overlapCount = 0;
            var totalAmplitude = 0;
            var windowsInZone = zoneEnd - tz;

            for (var zw = tz; zw < zoneEnd; zw++) {
                if (zw < conversationStates.length) {
                    if (conversationStates[zw].state === 'OVERLAP') overlapCount++;
                    for (var zt = 0; zt < rmsSmoothed.length; zt++) {
                        if (zw < rmsSmoothed[zt].length && rmsSmoothed[zt][zw] > -60) {
                            totalAmplitude += (rmsSmoothed[zt][zw] + 60); // normalize to 0+
                        }
                    }
                }
            }

            var overlapRatio = overlapCount / windowsInZone;
            var avgAmplitude = totalAmplitude / (windowsInZone * Math.max(1, rmsSmoothed.length));
            var zone;

            if (overlapRatio > 0.3 && avgAmplitude > 20) {
                zone = 'FAST';
            } else if (avgAmplitude < 8 || overlapRatio < 0.05) {
                zone = 'CALM';
            } else {
                zone = 'NORMAL';
            }

            zones.push({
                zone: zone,
                startWindow: tz,
                endWindow: zoneEnd
            });
        }

        return zones;
    }

    /**
     * Detect emotional spikes — sudden RMS jumps above baseline.
     * Compare each window to a trailing 2s (40 windows) baseline.
     *
     * @param {Array[]} rmsSmoothed - Smoothed RMS data
     * @param {number} spikeThresholdDb - dB jump to trigger spike (default 25)
     * @returns {Array} spikes[{window, trackIdx}]
     */
    function detectEmotionalSpikes(rmsSmoothed, spikeThresholdDb) {
        spikeThresholdDb = spikeThresholdDb || 25;
        var BASELINE_WINDOWS = 40; // 2 seconds at 50ms
        var spikes = [];

        for (var t = 0; t < rmsSmoothed.length; t++) {
            var track = rmsSmoothed[t];
            for (var w = BASELINE_WINDOWS; w < track.length; w++) {
                var baselineSum = 0;
                for (var bw = w - BASELINE_WINDOWS; bw < w; bw++) {
                    baselineSum += track[bw];
                }
                var baselineAvg = baselineSum / BASELINE_WINDOWS;
                var current = track[w];
                var jump = current - baselineAvg;

                if (jump > spikeThresholdDb && current > -30) {
                    spikes.push({ window: w, trackIdx: t, jump: jump });
                    w += 10; // Skip ahead to avoid duplicate spikes
                }
            }
        }

        return spikes;
    }

    // ============================================================
    // LAYER 5: CAMERA DECISION ENGINE (WEIGHTED SELECTION)
    // ============================================================

    /**
     * Select a camera using weighted random selection with memory.
     *
     * @param {number} speakerTrack - Which audio track is the active speaker
     * @param {Object} speakerCameraWeights - Per-speaker camera pools
     *   e.g. { 0: [{cameraIndex:0, weight:70}, {cameraIndex:2, weight:20}, {cameraIndex:1, weight:10}], ... }
     * @param {Array} cameraHistory - Last N camera indices used
     * @param {number} memoryStrictness - 0 to 1, how much to penalize repeats
     * @param {boolean} isSpike - Whether we're in an emotional spike (boost close-up)
     * @returns {number} Selected camera index
     */
    function selectCamera(speakerTrack, speakerCameraWeights, cameraHistory, memoryStrictness, isSpike) {
        var pool = speakerCameraWeights[speakerTrack];
        if (!pool || pool.length === 0) {
            return speakerTrack; // Fallback: direct mapping
        }

        // Copy weights
        var adjusted = [];
        for (var i = 0; i < pool.length; i++) {
            adjusted.push({
                cameraIndex: pool[i].cameraIndex,
                weight: pool[i].weight
            });
        }

        // Emotional spike: boost first entry (assumed close-up) by 20%
        if (isSpike && adjusted.length > 0) {
            adjusted[0].weight *= 1.2;
        }

        // Memory penalty: reduce weight for recently used cameras
        for (var h = 0; h < cameraHistory.length; h++) {
            var recency = (cameraHistory.length - h); // more recent = higher
            var penaltyFactor = 1 - (memoryStrictness * recency / cameraHistory.length);
            penaltyFactor = Math.max(0.1, penaltyFactor);

            for (var aw = 0; aw < adjusted.length; aw++) {
                if (adjusted[aw].cameraIndex === cameraHistory[h]) {
                    adjusted[aw].weight *= penaltyFactor;
                }
            }
        }

        // Alternation detection: if last 4 cameras show A-B-A-B, boost any third camera
        if (cameraHistory.length >= 4) {
            var last4 = cameraHistory.slice(-4);
            if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
                for (var alt = 0; alt < adjusted.length; alt++) {
                    if (adjusted[alt].cameraIndex !== last4[0] &&
                        adjusted[alt].cameraIndex !== last4[1]) {
                        adjusted[alt].weight *= 3; // Strong boost for break-out camera
                    }
                }
            }
        }

        // Normalize and weighted random pick
        var totalWeight = 0;
        for (var nw = 0; nw < adjusted.length; nw++) {
            totalWeight += adjusted[nw].weight;
        }

        if (totalWeight <= 0) return pool[0].cameraIndex;

        var roll = Math.random() * totalWeight;
        var cumulative = 0;
        for (var pw = 0; pw < adjusted.length; pw++) {
            cumulative += adjusted[pw].weight;
            if (roll <= cumulative) {
                return adjusted[pw].cameraIndex;
            }
        }

        return adjusted[0].cameraIndex;
    }

    // ============================================================
    // LAYER 3+4+5: CONVERSATION ENGINE (UNIFIED STATE MACHINE)
    // ============================================================

    /**
     * Build per-window conversation states from speech segments.
     * Determines who is speaking at each 50ms window.
     *
     * @param {Array[]} segments - segments[trackIdx] = [{startSec, endSec, ...}]
     * @param {number} maxWindows - Total number of windows
     * @returns {Array} states[windowIdx] = {state, speakerTrack, activeTracks}
     */
    function buildConversationStates(segments, maxWindows) {
        var windowMs = WINDOW_SIZE_MS;
        var states = [];

        for (var w = 0; w < maxWindows; w++) {
            var timeSec = w * windowMs / 1000;
            var activeTracks = [];

            for (var t = 0; t < segments.length; t++) {
                for (var s = 0; s < segments[t].length; s++) {
                    var seg = segments[t][s];
                    if (timeSec >= seg.startSec && timeSec <= seg.endSec) {
                        activeTracks.push({ trackIdx: t, segment: seg });
                        break;
                    }
                }
            }

            var state, speakerTrack;

            if (activeTracks.length === 0) {
                state = 'SILENCE';
                speakerTrack = -1;
            } else if (activeTracks.length === 1) {
                var only = activeTracks[0];
                if (only.segment.type === 'REACTION') {
                    state = 'REACTION';
                } else {
                    state = 'SPEAKING'; // Generic, track index identifies who
                }
                speakerTrack = only.trackIdx;
            } else {
                state = 'OVERLAP';
                // Pick loudest as primary
                var loudest = activeTracks[0];
                for (var a = 1; a < activeTracks.length; a++) {
                    if (activeTracks[a].segment.avgRms > loudest.segment.avgRms) {
                        loudest = activeTracks[a];
                    }
                }
                speakerTrack = loudest.trackIdx;
            }

            states.push({
                state: state,
                speakerTrack: speakerTrack,
                activeTracks: activeTracks,
                timeSec: timeSec
            });
        }

        return states;
    }

    /**
     * Helper: find the active speech segment for a track at a given time.
     */
    function findActiveSegment(trackSegments, timeSec) {
        for (var i = 0; i < trackSegments.length; i++) {
            if (timeSec >= trackSegments[i].startSec && timeSec <= trackSegments[i].endSec) {
                return trackSegments[i];
            }
        }
        return null;
    }

    /**
     * Helper: check if an emotional spike is near a given window index.
     */
    function isSpikeNear(spikes, windowIdx, rangeWindows) {
        for (var i = 0; i < spikes.length; i++) {
            if (Math.abs(spikes[i].window - windowIdx) <= rangeWindows) {
                return true;
            }
        }
        return false;
    }

    /**
     * Helper: compute average RMS for a track over a window range.
     * Used for intensity-aware cutting decisions.
     *
     * @param {Array[]} rmsSmoothed - Smoothed RMS data
     * @param {number} trackIdx - Which audio track
     * @param {number} centerWindow - Center window index
     * @param {number} radius - Number of windows on each side (default 20 = 1 second)
     * @returns {number} Average RMS in dB, or -100 if no valid data
     */
    function computeLocalRms(rmsSmoothed, trackIdx, centerWindow, radius) {
        radius = radius || 20;
        if (trackIdx < 0 || trackIdx >= rmsSmoothed.length) return -100;
        var track = rmsSmoothed[trackIdx];
        var startW = Math.max(0, centerWindow - radius);
        var endW = Math.min(track.length - 1, centerWindow + radius);
        var sum = 0;
        var count = 0;
        for (var w = startW; w <= endW; w++) {
            if (track[w] > -60) {  // Exclude silence/noise floor
                sum += track[w];
                count++;
            }
        }
        return count > 0 ? sum / count : -100;
    }

    /**
     * Helper: get tempo-adjusted parameters at a given window index.
     */
    function getTempoParams(tempoZones, windowIdx, config) {
        var TEMPO_WINDOW = 10;
        var zoneIdx = Math.floor(windowIdx / TEMPO_WINDOW);
        if (zoneIdx >= tempoZones.length) zoneIdx = tempoZones.length - 1;
        var zone = (tempoZones[zoneIdx] && tempoZones[zoneIdx].zone) || 'NORMAL';

        var minShot, inertiaMs;
        switch (zone) {
            case 'FAST':
                minShot = Math.max(config.minShotDurationSec || 1.8, 2.0);
                inertiaMs = 200;
                break;
            case 'CALM':
                minShot = Math.max(config.minShotDurationSec || 1.8, 6.0);
                inertiaMs = 350;
                break;
            default: // NORMAL
                minShot = Math.max(config.minShotDurationSec || 1.8, 4.0);
                inertiaMs = 275;
                break;
        }

        return { minShot: minShot, inertiaMs: inertiaMs, zone: zone };
    }

    /**
     * Run the full conversation engine — Layers 3+4+5.
     * Replaces evaluateTruthTable() + applyHysteresis().
     *
     * @param {Array[]} segments - Speech segments per track
     * @param {Array[]} rmsSmoothed - Smoothed RMS data
     * @param {Object} config - All configuration parameters
     * @returns {Object} {cuts, conversationStates, tempoZones, emotionalSpikes}
     */
    function runConversationEngine(segments, rmsSmoothed, config) {
        var windowMs = WINDOW_SIZE_MS;
        var windowSec = windowMs / 1000;

        // Defaults
        var minSpeakerDur = config.minSpeakerDurationSec || 1.2;
        var suppressionWindow = config.suppressionWindowSec || 2.0;
        var reactionIgnore = config.reactionIgnoreMaxSec || 0.8;
        var overlapIgnore = config.overlapIgnoreMaxSec || 0.5;
        var overlapRmsDiffPct = (config.overlapRmsDiff || 20) / 100; // Convert % to fraction
        var prerollSec = (config.prerollFrames || 5) / (config.frameRate || 29.97);
        var memoryStrictness = config.memoryStrictness || 0.3;
        var spikeThreshold = config.spikeThreshold || 25;
        var monologueThreshold = config.monologueThreshold || 10;
        var wideShotTrack = (typeof config.wideShotTrack === 'number') ? config.wideShotTrack : -1;
        var speakerWeights = config.speakerCameraWeights || {};
        var cutawayDurationSec = config.cutawayDurationSec || 0.75;

        // Compute wide cutaway interval from average widePercent across all speakers
        // widePercent=0 -> disabled, widePercent=20 -> 10s, widePercent=50 -> 4s
        var avgWidePercent = 0;
        var speakerCount = 0;
        for (var wp in speakerWeights) {
            if (speakerWeights.hasOwnProperty(wp)) {
                var pool = speakerWeights[wp];
                for (var wpi = 0; wpi < pool.length; wpi++) {
                    if (pool[wpi].cameraIndex === wideShotTrack) {
                        avgWidePercent += pool[wpi].weight;
                    }
                }
                speakerCount++;
            }
        }
        if (speakerCount > 0) avgWidePercent = avgWidePercent / speakerCount;
        var wideCutawayInterval = avgWidePercent > 0 ? (200 / avgWidePercent) : Infinity;
        // Clamp to reasonable range: 4-30 seconds
        wideCutawayInterval = Math.max(4, Math.min(30, wideCutawayInterval));

        // Find max windows across all tracks
        var maxWindows = 0;
        for (var t = 0; t < rmsSmoothed.length; t++) {
            if (rmsSmoothed[t].length > maxWindows) maxWindows = rmsSmoothed[t].length;
        }

        if (maxWindows === 0) {
            return { cuts: [], conversationStates: [], tempoZones: [], emotionalSpikes: [] };
        }

        // Phase A: Build conversation states
        var conversationStates = buildConversationStates(segments, maxWindows);

        // Phase B: Detect tempo zones
        var tempoZones = detectTempoZones(conversationStates, rmsSmoothed, maxWindows);

        // Phase C: Detect emotional spikes
        var emotionalSpikes = detectEmotionalSpikes(rmsSmoothed, spikeThreshold);

        // Phase D-pre: Compute per-track average RMS for intensity-aware cutting
        var trackAvgRms = [];
        for (var ta = 0; ta < rmsSmoothed.length; ta++) {
            var sumAboveNoise = 0;
            var countAboveNoise = 0;
            for (var tw = 0; tw < rmsSmoothed[ta].length; tw++) {
                if (rmsSmoothed[ta][tw] > -50) {  // Only count windows with actual speech
                    sumAboveNoise += rmsSmoothed[ta][tw];
                    countAboveNoise++;
                }
            }
            trackAvgRms.push(countAboveNoise > 0 ? sumAboveNoise / countAboveNoise : -40);
        }

        // Helper inside runConversationEngine(): build cutaway targets for a given speaker
        function buildCutawayPool(activeSpeaker) {
            var targets = [];
            // Add other speakers' primary close-ups
            for (var sp in speakerWeights) {
                if (sp != activeSpeaker && speakerWeights.hasOwnProperty(sp)) {
                    var primary = speakerWeights[sp][0];
                    if (primary) targets.push(primary.cameraIndex);
                }
            }
            // Add wide shot
            if (wideShotTrack >= 0) {
                var hasWide = false;
                for (var t = 0; t < targets.length; t++) {
                    if (targets[t] === wideShotTrack) { hasWide = true; break; }
                }
                if (!hasWide) targets.push(wideShotTrack);
            }
            return targets;
        }

        // Phase D: State machine with inertia
        var cuts = [];
        var currentSpeaker = -1;
        var pendingSpeaker = -1;
        var pendingStartWindow = 0;
        var lastCutTimeSec = -Infinity;
        var cameraHistory = [];
        var sameSpeakerSince = 0; // For monologue detection
        var lastMonologueBreak = -Infinity;
        var lastCutCamera = -1;  // Track camera of most recent cut (same-camera guard)
        var lastCutawayType = ''; // 'reaction_cutaway' | 'wide_cutaway' | ''
        var reactionCutawayActive = false; // True when holding on a reaction shot
        var reactionCutawayStartWindow = -1; // Window index where reaction cutaway began

        // Find initial speaker (first non-silence, non-reaction)
        for (var iw = 0; iw < conversationStates.length; iw++) {
            var ics = conversationStates[iw];
            if (ics.speakerTrack >= 0 && ics.state !== 'REACTION' && ics.state !== 'SILENCE') {
                currentSpeaker = ics.speakerTrack;
                sameSpeakerSince = ics.timeSec;
                break;
            }
        }

        // Initial camera selection
        var initialCamera;
        if (speakerWeights[currentSpeaker] && speakerWeights[currentSpeaker].length > 0) {
            initialCamera = selectCamera(currentSpeaker, speakerWeights, [], 0, false);
        } else {
            initialCamera = currentSpeaker >= 0 ? currentSpeaker : 0;
        }

        cuts.push({
            timeSeconds: 0,
            cameraIndex: initialCamera,
            reason: 'initial'
        });
        cameraHistory.push(initialCamera);
        lastCutTimeSec = 0;
        lastCutCamera = initialCamera;

        // Main state machine loop
        for (var mw = 0; mw < conversationStates.length; mw++) {
            var cs = conversationStates[mw];
            var currentTimeSec = cs.timeSec;
            var tempoParams = getTempoParams(tempoZones, mw, config);
            var inertiaWindows = Math.ceil(tempoParams.inertiaMs / windowMs);
            var effectiveMinShot = tempoParams.minShot;
            var timeSinceLastCut = currentTimeSec - lastCutTimeSec;

            // --- CUTAWAY RETURN: Smart return to active speaker ---
            // For reaction_cutaway: hold until speaker naturally pauses (human "nod cut")
            // For wide_cutaway: use jittered timer return (wide is neutral)
            if (currentSpeaker >= 0 && lastCutCamera >= 0 && cs.state === 'SPEAKING' &&
                cs.speakerTrack === currentSpeaker) {
                // Check if lastCutCamera belongs to the active speaker's pool
                var cameraMatchesSpeaker = false;
                var spkPool = speakerWeights[currentSpeaker];
                if (spkPool) {
                    for (var cmi = 0; cmi < spkPool.length; cmi++) {
                        if (spkPool[cmi].cameraIndex === lastCutCamera) {
                            cameraMatchesSpeaker = true;
                            break;
                        }
                    }
                }
                var isOnWide = (lastCutCamera === wideShotTrack && wideShotTrack >= 0);

                var shouldReturn = false;

                if (reactionCutawayActive && lastCutawayType === 'reaction_cutaway') {
                    // HUMAN EDIT: Hold reaction shot until speaker pauses or max 3s
                    var maxHoldWindows = 60; // 3 seconds at 50ms
                    var holdExceeded = (mw - reactionCutawayStartWindow) >= maxHoldWindows;
                    // Detect natural pause: speaker goes SILENCE (at least 150ms = 3 windows)
                    var speakerPaused = false;
                    if (!holdExceeded) {
                        var silenceRun = 0;
                        for (var sw = mw; sw < Math.min(conversationStates.length, mw + 4); sw++) {
                            if (conversationStates[sw].state === 'SILENCE') silenceRun++;
                        }
                        speakerPaused = (silenceRun >= 3);
                    }
                    shouldReturn = speakerPaused || holdExceeded;
                } else if (!cameraMatchesSpeaker || isOnWide) {
                    // Timer-based return for wide shot and other non-reaction cutaways
                    var jitteredReturnDuration = cutawayDurationSec *
                        (0.7 + ((mw * 13) % 100) / 100 * 0.6);
                    shouldReturn = timeSinceLastCut >= jitteredReturnDuration;
                }

                if (shouldReturn) {
                    var returnCamera;
                    if (spkPool && spkPool.length > 0) {
                        returnCamera = spkPool[0].cameraIndex;
                    } else {
                        returnCamera = currentSpeaker;
                    }

                    if (returnCamera !== lastCutCamera) {
                        cuts.push({
                            timeSeconds: Math.max(0, currentTimeSec - prerollSec),
                            cameraIndex: returnCamera,
                            reason: 'cutaway_return'
                        });
                        lastCutCamera = returnCamera;
                        lastCutTimeSec = currentTimeSec;
                        cameraHistory.push(returnCamera);
                        if (cameraHistory.length > 6) cameraHistory.shift();
                        reactionCutawayActive = false;
                        lastCutawayType = '';
                        continue;
                    }
                }
            }

            // --- HIGH-ENERGY DETECTION ---
            // During powerful speech, hold on the speaker's camera (suppress cuts)
            var isHighEnergy = false;
            if (currentSpeaker >= 0) {
                var currentRms = computeLocalRms(rmsSmoothed, currentSpeaker, mw, 20);
                isHighEnergy = (currentRms > trackAvgRms[currentSpeaker] + 6);
            }
            if (isHighEnergy) {
                effectiveMinShot = effectiveMinShot * 1.5; // Hold 50% longer during power moments
            }

            // --- EMOTIONAL ARC CUTAWAY: React to impactful statement endings ---
            // Human editors cut to reaction right after a powerful statement ends.
            // Detect: speaker was above-average energy, then RMS drops sharply
            // followed by brief silence — the "punchline moment".
            if (currentSpeaker >= 0 && cs.speakerTrack === currentSpeaker &&
                cs.state === 'SPEAKING' && !reactionCutawayActive &&
                timeSinceLastCut >= effectiveMinShot * 0.5) {

                var recentRms = computeLocalRms(rmsSmoothed, currentSpeaker, mw - 5, 10);
                var olderRms = computeLocalRms(rmsSmoothed, currentSpeaker, mw - 20, 10);
                var wasHighEnergy = olderRms > trackAvgRms[currentSpeaker] + 4;
                var isDropping = (recentRms - olderRms) < -3;

                if (wasHighEnergy && isDropping) {
                    // Confirm statement ended: silence ahead within next 500ms
                    var silenceAhead = 0;
                    for (var sa = mw; sa < Math.min(mw + 10, conversationStates.length); sa++) {
                        if (conversationStates[sa].state === 'SILENCE') silenceAhead++;
                    }
                    if (silenceAhead >= 2) {
                        // TRIGGER: Immediate reaction cutaway (not timer-based)
                        var arcPool = buildCutawayPool(currentSpeaker);
                        var arcValid = [];
                        for (var at = 0; at < arcPool.length; at++) {
                            if (arcPool[at] !== lastCutCamera) arcValid.push(arcPool[at]);
                        }
                        if (arcValid.length > 0) {
                            // Bias toward other-speaker reaction (70%) vs wide (30%)
                            var arcPick = arcValid[Math.floor(Math.random() * arcValid.length)];
                            var hasNonWide = false;
                            for (var an = 0; an < arcValid.length; an++) {
                                if (arcValid[an] !== wideShotTrack) { hasNonWide = true; break; }
                            }
                            if (hasNonWide && Math.random() < 0.7) {
                                var nonWideArc = [];
                                for (var av = 0; av < arcValid.length; av++) {
                                    if (arcValid[av] !== wideShotTrack) nonWideArc.push(arcValid[av]);
                                }
                                arcPick = nonWideArc[Math.floor(Math.random() * nonWideArc.length)];
                            }
                            var arcReason = arcPick === wideShotTrack ? 'wide_cutaway' : 'reaction_cutaway';
                            cuts.push({
                                timeSeconds: Math.max(0, currentTimeSec - prerollSec),
                                cameraIndex: arcPick,
                                reason: arcReason
                            });
                            cameraHistory.push(arcPick);
                            if (cameraHistory.length > 6) cameraHistory.shift();
                            lastCutCamera = arcPick;
                            lastCutTimeSec = currentTimeSec;
                            lastMonologueBreak = currentTimeSec;
                            lastCutawayType = arcReason;
                            if (arcReason === 'reaction_cutaway') {
                                reactionCutawayActive = true;
                                reactionCutawayStartWindow = mw;
                            }
                            continue;
                        }
                    }
                }
            }

            // --- REACTION CUTAWAY during sustained speech (rotates through all available cameras) ---
            if (currentSpeaker >= 0 && cs.speakerTrack === currentSpeaker &&
                cs.state === 'SPEAKING' && !isHighEnergy && !reactionCutawayActive) {
                var sameSpeakerDur = currentTimeSec - sameSpeakerSince;
                var timeSinceMonoBreak = currentTimeSec - lastMonologueBreak;

                // Jittered interval: base ± 30% randomness
                var jitteredInterval = wideCutawayInterval * (0.7 + Math.random() * 0.6);

                if (sameSpeakerDur > jitteredInterval &&
                    timeSinceMonoBreak > jitteredInterval &&
                    timeSinceLastCut >= effectiveMinShot) {

                    var cutawayPool = buildCutawayPool(currentSpeaker);
                    // Filter: don't pick lastCutCamera (avoid same-camera cut)
                    var validTargets = [];
                    for (var ct = 0; ct < cutawayPool.length; ct++) {
                        if (cutawayPool[ct] !== lastCutCamera) validTargets.push(cutawayPool[ct]);
                    }
                    if (validTargets.length > 0) {
                        // Randomize: slight bias toward wide (40%) vs other speaker (60%)
                        var pickTarget;
                        var wideIdxInPool = -1;
                        for (var vi = 0; vi < validTargets.length; vi++) {
                            if (validTargets[vi] === wideShotTrack) { wideIdxInPool = vi; break; }
                        }
                        if (wideIdxInPool >= 0 && Math.random() < 0.4) {
                            pickTarget = wideShotTrack;
                        } else {
                            // Pick a random non-wide target, or wide if it's the only one
                            var nonWide = [];
                            for (var vw = 0; vw < validTargets.length; vw++) {
                                if (validTargets[vw] !== wideShotTrack) nonWide.push(validTargets[vw]);
                            }
                            pickTarget = nonWide.length > 0
                                ? nonWide[Math.floor(Math.random() * nonWide.length)]
                                : validTargets[0];
                        }

                        var cutReason = pickTarget === wideShotTrack ? 'wide_cutaway' : 'reaction_cutaway';
                        cuts.push({
                            timeSeconds: Math.max(0, currentTimeSec - prerollSec),
                            cameraIndex: pickTarget,
                            reason: cutReason
                        });
                        cameraHistory.push(pickTarget);
                        if (cameraHistory.length > 6) cameraHistory.shift();
                        lastCutCamera = pickTarget;
                        lastCutTimeSec = currentTimeSec;
                        lastMonologueBreak = currentTimeSec;
                        lastCutawayType = cutReason;
                        if (cutReason === 'reaction_cutaway') {
                            reactionCutawayActive = true;
                            reactionCutawayStartWindow = mw;
                        }
                        continue;
                    }
                }
            }

            // --- MONOLOGUE VARIATION (Rule 4) — Editorial: wide shot for monologue breaks ---
            if (currentSpeaker >= 0 && cs.speakerTrack === currentSpeaker &&
                cs.state === 'SPEAKING') {
                var sameSpeakerDuration = currentTimeSec - sameSpeakerSince;
                var timeSinceMonologueBreak = currentTimeSec - lastMonologueBreak;

                // Adaptive monologue threshold: animated speakers get longer holds
                var adaptiveMonologueThreshold = monologueThreshold; // Base: 10s
                if (currentSpeaker >= 0) {
                    var monoRms = computeLocalRms(rmsSmoothed, currentSpeaker, mw, 40);
                    if (monoRms > trackAvgRms[currentSpeaker] + 4) {
                        adaptiveMonologueThreshold = monologueThreshold * 1.8; // ~18s for animated speakers
                    } else if (monoRms > trackAvgRms[currentSpeaker] + 2) {
                        adaptiveMonologueThreshold = monologueThreshold * 1.3; // ~13s
                    }
                }

                if (!isHighEnergy &&
                    sameSpeakerDuration > adaptiveMonologueThreshold &&
                    timeSinceMonologueBreak > adaptiveMonologueThreshold &&
                    timeSinceLastCut >= effectiveMinShot) {

                    // EDITORIAL: Monologue break = wide shot (deterministic)
                    var monoCamera;
                    if (wideShotTrack >= 0 && wideShotTrack !== lastCutCamera) {
                        monoCamera = wideShotTrack; // Wide is the natural monologue break camera
                    } else if (speakerWeights[currentSpeaker] && speakerWeights[currentSpeaker].length > 0) {
                        // Wide unavailable or was last camera — pick a close-up alternative
                        var monoPool = [];
                        for (var mpi = 0; mpi < speakerWeights[currentSpeaker].length; mpi++) {
                            if (speakerWeights[currentSpeaker][mpi].cameraIndex !== wideShotTrack || wideShotTrack < 0) {
                                monoPool.push({ cameraIndex: speakerWeights[currentSpeaker][mpi].cameraIndex, weight: speakerWeights[currentSpeaker][mpi].weight });
                            }
                        }
                        if (monoPool.length === 0) monoPool = speakerWeights[currentSpeaker].slice();
                        var monoW = {};
                        monoW[currentSpeaker] = monoPool;
                        monoCamera = selectCamera(currentSpeaker, monoW, cameraHistory, memoryStrictness, false);
                    } else {
                        continue; // No alternate available
                    }

                    // GUARD: Skip if same camera as last cut (pointless razor mark)
                    if (monoCamera === lastCutCamera) {
                        continue;
                    }

                    cuts.push({
                        timeSeconds: Math.max(0, currentTimeSec - prerollSec),
                        cameraIndex: monoCamera,
                        reason: 'monologue_variation'
                    });
                    cameraHistory.push(monoCamera);
                    if (cameraHistory.length > 6) cameraHistory.shift();
                    lastCutCamera = monoCamera;
                    lastCutTimeSec = currentTimeSec;
                    lastMonologueBreak = currentTimeSec;
                    sameSpeakerSince = currentTimeSec;
                    continue;
                }
            }

            // --- REACTION POINT: Wide cut after high-intensity statement end ---
            // The "president documentary" moment: speaker finishes powerful statement,
            // silence follows — cut to wide to show the host's reaction
            if (currentSpeaker >= 0 && wideShotTrack >= 0 &&
                cs.state === 'SILENCE' && timeSinceLastCut >= effectiveMinShot) {

                var recentRms = computeLocalRms(rmsSmoothed, currentSpeaker, mw - 20, 20);
                var speakerAvg = trackAvgRms[currentSpeaker];

                if (recentRms > speakerAvg + 4) { // Speaker was above-average intensity
                    // Verify this is a real pause, not a breath (need 500ms+ silence ahead)
                    var silenceAhead = 0;
                    for (var sa = mw; sa < Math.min(mw + 20, conversationStates.length); sa++) {
                        if (conversationStates[sa].state === 'SILENCE' ||
                            conversationStates[sa].state === 'REACTION') {
                            silenceAhead++;
                        } else {
                            break;
                        }
                    }

                    if (silenceAhead >= 10 && wideShotTrack !== lastCutCamera) {
                        cuts.push({
                            timeSeconds: Math.max(0, currentTimeSec - prerollSec),
                            cameraIndex: wideShotTrack,
                            reason: 'reaction_wide'
                        });
                        cameraHistory.push(wideShotTrack);
                        if (cameraHistory.length > 6) cameraHistory.shift();
                        lastCutCamera = wideShotTrack;
                        lastCutTimeSec = currentTimeSec;
                        continue;
                    }
                }
            }

            // --- SKIP SILENCE ---
            if (cs.state === 'SILENCE') {
                pendingSpeaker = -1;
                continue;
            }

            // --- SKIP MICRO REACTIONS (Rule 2) ---
            if (cs.state === 'REACTION' && cs.speakerTrack !== currentSpeaker) {
                var reactSeg = null;
                for (var rs = 0; rs < cs.activeTracks.length; rs++) {
                    if (cs.activeTracks[rs].segment.type === 'REACTION') {
                        reactSeg = cs.activeTracks[rs].segment;
                        break;
                    }
                }
                if (reactSeg && (reactSeg.endSec - reactSeg.startSec) < reactionIgnore) {
                    pendingSpeaker = -1; // Clear pending to avoid state leak
                    continue; // Ignore micro reaction
                }
            }

            // --- HANDLE OVERLAP (Rule 5) ---
            if (cs.state === 'OVERLAP') {
                // Check overlap duration
                var overlapStartW = mw;
                while (overlapStartW > 0 && conversationStates[overlapStartW - 1].state === 'OVERLAP') {
                    overlapStartW--;
                }
                var overlapDuration = (mw - overlapStartW) * windowSec;

                if (overlapDuration < overlapIgnore) {
                    continue; // Ignore brief overlaps
                }

                // Compare RMS of overlapping speakers
                if (cs.activeTracks.length >= 2) {
                    // Sort by avgRms descending so we always compare the loudest speakers
                    // (handles 3+ simultaneous speakers correctly)
                    var sortedActive = cs.activeTracks.slice().sort(function (x, y) {
                        return y.segment.avgRms - x.segment.avgRms;
                    });
                    var trackA = sortedActive[0];
                    var trackB = sortedActive[1];
                    var rmsA = trackA.segment.avgRms;
                    var rmsB = trackB.segment.avgRms;

                    // Convert dB difference to ratio
                    var rmsRatioA = Math.pow(10, rmsA / 20);
                    var rmsRatioB = Math.pow(10, rmsB / 20);

                    if (rmsRatioA > rmsRatioB * (1 + overlapRmsDiffPct)) {
                        // Speaker A is louder — they win
                        if (trackA.trackIdx !== currentSpeaker && timeSinceLastCut >= suppressionWindow) {
                            var overlapCamA = selectCamera(trackA.trackIdx, speakerWeights, cameraHistory, memoryStrictness, false);
                            // GUARD: If same camera, try alternate from pool
                            if (overlapCamA === lastCutCamera) {
                                var altPoolA = speakerWeights[trackA.trackIdx];
                                if (altPoolA && altPoolA.length > 1) {
                                    for (var raiA = 0; raiA < altPoolA.length; raiA++) {
                                        if (altPoolA[raiA].cameraIndex !== lastCutCamera) {
                                            overlapCamA = altPoolA[raiA].cameraIndex;
                                            break;
                                        }
                                    }
                                }
                            }
                            if (overlapCamA !== lastCutCamera) {
                                cuts.push({
                                    timeSeconds: Math.max(0, currentTimeSec - prerollSec),
                                    cameraIndex: overlapCamA,
                                    reason: 'overlap_dominant'
                                });
                                currentSpeaker = trackA.trackIdx;
                                sameSpeakerSince = currentTimeSec;
                                lastCutTimeSec = currentTimeSec;
                                lastCutCamera = overlapCamA;
                                cameraHistory.push(overlapCamA);
                                if (cameraHistory.length > 6) cameraHistory.shift();
                                pendingSpeaker = -1;
                            }
                        }
                    } else if (rmsRatioB > rmsRatioA * (1 + overlapRmsDiffPct)) {
                        // Speaker B is louder
                        if (trackB.trackIdx !== currentSpeaker && timeSinceLastCut >= suppressionWindow) {
                            var overlapCamB = selectCamera(trackB.trackIdx, speakerWeights, cameraHistory, memoryStrictness, false);
                            // GUARD: If same camera, try alternate from pool
                            if (overlapCamB === lastCutCamera) {
                                var altPoolB = speakerWeights[trackB.trackIdx];
                                if (altPoolB && altPoolB.length > 1) {
                                    for (var raiB = 0; raiB < altPoolB.length; raiB++) {
                                        if (altPoolB[raiB].cameraIndex !== lastCutCamera) {
                                            overlapCamB = altPoolB[raiB].cameraIndex;
                                            break;
                                        }
                                    }
                                }
                            }
                            if (overlapCamB !== lastCutCamera) {
                                cuts.push({
                                    timeSeconds: Math.max(0, currentTimeSec - prerollSec),
                                    cameraIndex: overlapCamB,
                                    reason: 'overlap_dominant'
                                });
                                currentSpeaker = trackB.trackIdx;
                                sameSpeakerSince = currentTimeSec;
                                lastCutTimeSec = currentTimeSec;
                                lastCutCamera = overlapCamB;
                                cameraHistory.push(overlapCamB);
                                if (cameraHistory.length > 6) cameraHistory.shift();
                                pendingSpeaker = -1;
                            }
                        }
                    } else if (overlapDuration > 0.5 && timeSinceLastCut >= suppressionWindow) {
                        // EDITORIAL: Equal overlap = wide shot (deterministic)
                        var overlapCamera;
                        if (wideShotTrack >= 0 && wideShotTrack !== lastCutCamera) {
                            overlapCamera = wideShotTrack; // Both speaking = show both = wide
                        } else if (wideShotTrack >= 0 && wideShotTrack === lastCutCamera) {
                            overlapCamera = trackA.trackIdx; // Already on wide, go to louder speaker
                        } else {
                            overlapCamera = trackA.trackIdx; // No wide configured
                        }
                        // GUARD: Skip if same camera
                        if (overlapCamera !== lastCutCamera) {
                            cuts.push({
                                timeSeconds: Math.max(0, currentTimeSec - prerollSec),
                                cameraIndex: overlapCamera,
                                reason: 'overlap_wide'
                            });
                            lastCutTimeSec = currentTimeSec;
                            lastCutCamera = overlapCamera;
                            cameraHistory.push(overlapCamera);
                            if (cameraHistory.length > 6) cameraHistory.shift();
                            pendingSpeaker = -1;
                        }
                    }
                }
                pendingSpeaker = -1; // Clear pending to avoid state leak through overlaps
                continue; // Overlap handled, skip normal processing
            }

            // --- NORMAL SPEAKER SWITCH LOGIC (Rules 1, 3, 4) ---
            var detectedSpeaker = cs.speakerTrack;

            if (detectedSpeaker === currentSpeaker) {
                // Same speaker — reset pending
                pendingSpeaker = -1;
                continue;
            }

            if (detectedSpeaker < 0) continue;

            // Different speaker detected
            if (detectedSpeaker === pendingSpeaker) {
                // Same pending candidate — check inertia
                var heldWindows = mw - pendingStartWindow;

                // ANTICIPATION CUT: Read RMS trend to predict speaker change
                // Human editors cut just BEFORE the new speaker starts — no dead air
                var anticipationTriggered = false;
                if (detectedSpeaker >= 0 && detectedSpeaker !== currentSpeaker &&
                    heldWindows >= 2 && heldWindows < inertiaWindows) {
                    var pendingTrend = 0, curTrend = 0, trendCount = 0;
                    var tStart = Math.max(0, mw - 6);
                    for (var rtw = tStart; rtw <= mw; rtw++) {
                        if (rmsSmoothed[detectedSpeaker] && rmsSmoothed[currentSpeaker]) {
                            pendingTrend += rmsSmoothed[detectedSpeaker][rtw] || -100;
                            curTrend += rmsSmoothed[currentSpeaker][rtw] || -100;
                            trendCount++;
                        }
                    }
                    if (trendCount > 0) {
                        // Pending speaker is audibly rising above current speaker
                        anticipationTriggered = (pendingTrend / trendCount) >
                            (curTrend / trendCount) * 1.12;
                    }
                }

                if (heldWindows >= inertiaWindows || anticipationTriggered) {
                    // Inertia confirmed (or anticipation triggered). Now check ALL core cut rules:

                    // Rule 1+3: New speaker duration > 1.2s
                    var speakerSeg = findActiveSegment(segments[detectedSpeaker], currentTimeSec);
                    var speakerDuration = speakerSeg
                        ? (currentTimeSec - speakerSeg.startSec)
                        : (heldWindows * windowSec);

                    if (speakerDuration < minSpeakerDur) {
                        continue; // Not sustained enough
                    }

                    // Rule 1: Current shot > effective min shot
                    if (timeSinceLastCut < effectiveMinShot) {
                        continue; // Too soon
                    }

                    // Rule: Not classified as reaction
                    if (speakerSeg && speakerSeg.type === 'REACTION') {
                        continue;
                    }

                    // Suppression: Not within 2s suppression window
                    if (timeSinceLastCut < suppressionWindow) {
                        continue;
                    }

                    // ALL RULES PASSED — COMMIT THE CUT
                    var spikeActive = isSpikeNear(emotionalSpikes, mw, 20);

                    // EDITORIAL: Speaker switch = close-up of new speaker (exclude wide from pool)
                    var switchWeights = {};
                    if (speakerWeights[detectedSpeaker] && speakerWeights[detectedSpeaker].length > 0) {
                        var closeUpPool = [];
                        for (var cwi = 0; cwi < speakerWeights[detectedSpeaker].length; cwi++) {
                            var cwe = speakerWeights[detectedSpeaker][cwi];
                            if (cwe.cameraIndex !== wideShotTrack || wideShotTrack < 0) {
                                closeUpPool.push({ cameraIndex: cwe.cameraIndex, weight: cwe.weight });
                            }
                        }
                        if (closeUpPool.length === 0) closeUpPool = speakerWeights[detectedSpeaker].slice();
                        switchWeights[detectedSpeaker] = closeUpPool;
                    } else {
                        switchWeights = speakerWeights;
                    }

                    var selectedCamera = selectCamera(
                        detectedSpeaker, switchWeights, cameraHistory,
                        memoryStrictness, spikeActive
                    );

                    // GUARD: If same camera as last cut, try alternate from pool
                    if (selectedCamera === lastCutCamera) {
                        var swPool = switchWeights[detectedSpeaker] || speakerWeights[detectedSpeaker];
                        if (swPool) {
                            for (var sci = 0; sci < swPool.length; sci++) {
                                if (swPool[sci].cameraIndex !== lastCutCamera) {
                                    selectedCamera = swPool[sci].cameraIndex;
                                    break;
                                }
                            }
                        }
                    }

                    // Rule 6: Natural pause alignment — search backward up to 1000ms, forward up to 500ms
                    var cutWindowTarget = pendingStartWindow;
                    var searchBackWindows = Math.ceil(1000 / windowMs); // ~20 windows (extended from 6)
                    var searchForwardWindows = Math.ceil(500 / windowMs); // ~10 windows (NEW)

                    // Search backward first (preferred — cut before speaker change)
                    for (var pb = pendingStartWindow; pb >= Math.max(0, pendingStartWindow - searchBackWindows); pb--) {
                        if (pb < conversationStates.length && conversationStates[pb].state === 'SILENCE') {
                            cutWindowTarget = pb;
                            break;
                        }
                    }
                    // If no pause found backward, search forward (cut at next natural break)
                    if (cutWindowTarget === pendingStartWindow) {
                        for (var pf = pendingStartWindow + 1;
                             pf <= Math.min(conversationStates.length - 1, pendingStartWindow + searchForwardWindows);
                             pf++) {
                            if (conversationStates[pf].state === 'SILENCE') {
                                cutWindowTarget = pf;
                                break;
                            }
                        }
                    }

                    var cutTime = Math.max(0, (cutWindowTarget * windowSec) - prerollSec);

                    cuts.push({
                        timeSeconds: cutTime,
                        cameraIndex: selectedCamera,
                        reason: 'speaker_switch'
                    });

                    currentSpeaker = detectedSpeaker;
                    sameSpeakerSince = currentTimeSec;
                    lastCutTimeSec = cutTime;
                    lastCutCamera = selectedCamera;
                    cameraHistory.push(selectedCamera);
                    if (cameraHistory.length > 6) cameraHistory.shift();
                    pendingSpeaker = -1;
                }
                // else: still within inertia, keep waiting
            } else {
                // New candidate — start tracking
                pendingSpeaker = detectedSpeaker;
                pendingStartWindow = mw;
            }
        }

        // Sort cuts chronologically — preroll arithmetic and monologue injection
        // can produce out-of-order cuts; downstream razor assumes sorted order
        cuts.sort(function (a, b) { return a.timeSeconds - b.timeSeconds; });

        // POST-PROCESS: Remove consecutive same-camera cuts (safety net)
        if (cuts.length > 1) {
            var deduped = [cuts[0]];
            for (var dd = 1; dd < cuts.length; dd++) {
                if (cuts[dd].cameraIndex !== deduped[deduped.length - 1].cameraIndex) {
                    deduped.push(cuts[dd]);
                }
                // else: skip — same camera as previous cut (meaningless razor mark)
            }
            cuts = deduped;
        }

        // POST-PROCESS: Merge cuts within 500ms of each other (prevent rapid-fire)
        if (cuts.length > 1) {
            var merged = [cuts[0]];
            for (var mg = 1; mg < cuts.length; mg++) {
                if (cuts[mg].timeSeconds - merged[merged.length - 1].timeSeconds < 0.5) {
                    merged[merged.length - 1] = cuts[mg]; // Keep the later decision
                } else {
                    merged.push(cuts[mg]);
                }
            }
            cuts = merged;
        }

        return {
            cuts: cuts,
            conversationStates: conversationStates,
            tempoZones: tempoZones,
            emotionalSpikes: emotionalSpikes
        };
    }

    // ============================================================
    // SILENCE GAP IDENTIFICATION (for Layer 6)
    // ============================================================

    /**
     * Identify silence gaps from speech segments.
     * Gaps = time ranges NOT covered by any speech segment across all tracks.
     *
     * Classification:
     *   < 500ms     → 'natural_breath' (keep)
     *   500ms-1.5s  → 'optional_tighten'
     *   1.5-3s      → 'removable'
     *   > 3s        → 'strong_candidate'
     *
     * @param {Array[]} segments - Speech segments per track
     * @param {number} totalDurationSec - Total audio duration
     * @returns {Array} gaps[{startSec, endSec, durationSec, classification}]
     */
    function identifySilenceGaps(segments, totalDurationSec) {
        // Merge all speech segments into a unified timeline
        var allSpeech = [];
        for (var t = 0; t < segments.length; t++) {
            for (var s = 0; s < segments[t].length; s++) {
                allSpeech.push({
                    start: segments[t][s].startSec,
                    end: segments[t][s].endSec
                });
            }
        }

        // Sort by start time
        allSpeech.sort(function (a, b) { return a.start - b.start; });

        // Merge overlapping speech regions
        var merged = [];
        for (var m = 0; m < allSpeech.length; m++) {
            if (merged.length === 0 || allSpeech[m].start > merged[merged.length - 1].end) {
                merged.push({ start: allSpeech[m].start, end: allSpeech[m].end });
            } else {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, allSpeech[m].end);
            }
        }

        // Find gaps between merged speech regions
        var gaps = [];
        var lastEnd = 0;

        for (var g = 0; g < merged.length; g++) {
            if (merged[g].start > lastEnd + 0.01) {
                var gapStart = lastEnd;
                var gapEnd = merged[g].start;
                var gapDuration = gapEnd - gapStart;

                var classification;
                if (gapDuration < 0.5) {
                    classification = 'natural_breath';
                } else if (gapDuration < 1.5) {
                    classification = 'optional_tighten';
                } else if (gapDuration < 3.0) {
                    classification = 'removable';
                } else {
                    classification = 'strong_candidate';
                }

                gaps.push({
                    startSec: gapStart,
                    endSec: gapEnd,
                    durationSec: gapDuration,
                    classification: classification
                });
            }
            lastEnd = merged[g].end;
        }

        // Final gap (after last speech to end)
        if (totalDurationSec > lastEnd + 0.5) {
            var finalGap = totalDurationSec - lastEnd;
            gaps.push({
                startSec: lastEnd,
                endSec: totalDurationSec,
                durationSec: finalGap,
                classification: finalGap < 0.5 ? 'natural_breath'
                    : finalGap < 1.5 ? 'optional_tighten'
                    : finalGap < 3.0 ? 'removable'
                    : 'strong_candidate'
            });
        }

        return gaps;
    }

    // ============================================================
    // MAIN ORCHESTRATOR
    // ============================================================

    /**
     * Main analysis function — runs the full 7-step pipeline.
     *
     * @param {Object} config - Configuration
     * @param {function} onProgress - callback(percent, message)
     * @param {function} onComplete - callback(err, result)
     */
    function analyze(config, onProgress, onComplete) {
        var extensionRoot = config.extensionRoot || '';
        var audioTracks = config.audioTracks || [];
        var noiseFloorOffset = config.noiseFloorOffset || 12;
        var windowDuration = WINDOW_SIZE_MS / 1000;

        var ffmpegPath = findFFmpeg(extensionRoot);

        onProgress(0, 'Checking FFmpeg...');

        checkFFmpeg(ffmpegPath, function (err, version) {
            if (err) {
                onComplete(err);
                return;
            }

            onProgress(5, 'FFmpeg found (v' + version + '). Starting audio extraction...');

            var rmsData = [];
            var totalTracks = audioTracks.length;

            if (totalTracks === 0) {
                onComplete(new Error('No audio tracks to analyze.'));
                return;
            }

            // ============================================================
            // STEP 1: Extract audio + compute RMS per track
            // ============================================================
            function processNextTrack(trackIdx) {
                if (trackIdx >= totalTracks) {
                    finalizeAnalysis();
                    return;
                }

                var track = audioTracks[trackIdx];
                var pctBase = 5 + Math.round((trackIdx / totalTracks) * 65);
                var pctEnd = 5 + Math.round(((trackIdx + 1) / totalTracks) * 65);

                // Determine if this is a multi-clip or single-clip track
                var hasMultiClips = track.clips && track.clips.length > 1;
                var hasSingleClip = track.clips && track.clips.length === 1;
                var hasLegacyPath = !track.clips && track.mediaPath;

                if (hasMultiClips) {
                    // --- MULTI-CLIP PATH (new) ---
                    onProgress(pctBase,
                        'Extracting track ' + (trackIdx + 1) + '/' + totalTracks +
                        ' (' + track.clips.length + ' clips)...');

                    // Compute timeline duration from latest clip end
                    var trackEnd = 0;
                    for (var ce = 0; ce < track.clips.length; ce++) {
                        if (track.clips[ce].endSeconds > trackEnd) {
                            trackEnd = track.clips[ce].endSeconds;
                        }
                    }

                    extractMultiClipTrack(
                        ffmpegPath,
                        track.clips,
                        trackEnd,
                        function (message) {
                            onProgress(pctBase, 'T' + (trackIdx + 1) + ': ' + message);
                        },
                        function (err, rmsWindows) {
                            if (err) {
                                onProgress(pctEnd,
                                    'WARNING: Track ' + (trackIdx + 1) + ' multi-clip failed.');
                                rmsData[trackIdx] = [];
                            } else {
                                onProgress(pctEnd,
                                    'Track ' + (trackIdx + 1) + ': ' + rmsWindows.length +
                                    ' windows (' + track.clips.length + ' clips)');
                                rmsData[trackIdx] = rmsWindows;
                            }
                            processNextTrack(trackIdx + 1);
                        }
                    );

                } else if (hasSingleClip) {
                    // --- SINGLE-CLIP with trim info ---
                    var singleClip = track.clips[0];
                    var mediaPath = singleClip.mediaPath || '';

                    if (!mediaPath || !fs.existsSync(mediaPath)) {
                        onProgress(pctEnd,
                            'WARNING: Missing file for track ' + (trackIdx + 1) + ', filling silence.');
                        rmsData[trackIdx] = [];
                        processNextTrack(trackIdx + 1);
                        return;
                    }

                    onProgress(pctBase,
                        'Extracting track ' + (trackIdx + 1) + '/' + totalTracks +
                        ' (' + path.basename(mediaPath) + ')...');

                    // Use timeline-aware extraction even for single clip
                    var singleDuration = singleClip.endSeconds ||
                        (singleClip.outPointSeconds - singleClip.inPointSeconds) || 0;

                    if (singleDuration > 0 && singleClip.inPointSeconds !== undefined) {
                        extractMultiClipTrack(
                            ffmpegPath,
                            [singleClip],
                            singleDuration,
                            function (message) {
                                onProgress(pctBase, 'T' + (trackIdx + 1) + ': ' + message);
                            },
                            function (err, rmsWindows) {
                                if (err) {
                                    rmsData[trackIdx] = [];
                                } else {
                                    rmsData[trackIdx] = rmsWindows;
                                }
                                onProgress(pctEnd, 'Track ' + (trackIdx + 1) + ': ' +
                                    rmsData[trackIdx].length + ' windows');
                                processNextTrack(trackIdx + 1);
                            }
                        );
                    } else {
                        // Fallback: extract whole file (no trim info)
                        var trackWindows = [];
                        extractAndAnalyze(ffmpegPath, mediaPath,
                            function (windowIndex, rmsDb) { trackWindows.push(rmsDb); },
                            function (extractErr, totalWindows) {
                                if (extractErr) {
                                    onProgress(pctEnd, 'WARNING: Track ' + (trackIdx + 1) + ' failed.');
                                    trackWindows = [];
                                } else {
                                    onProgress(pctEnd, 'Track ' + (trackIdx + 1) + ': ' + totalWindows + ' windows');
                                }
                                rmsData[trackIdx] = trackWindows;
                                processNextTrack(trackIdx + 1);
                            }
                        );
                    }

                } else if (hasLegacyPath) {
                    // --- LEGACY PATH: no clips array, just mediaPath ---
                    var legacyPath = track.mediaPath;

                    if (!legacyPath || !fs.existsSync(legacyPath)) {
                        onProgress(pctEnd,
                            'WARNING: Missing file for track ' + (trackIdx + 1) + ', filling silence.');
                        rmsData[trackIdx] = [];
                        processNextTrack(trackIdx + 1);
                        return;
                    }

                    onProgress(pctBase,
                        'Extracting track ' + (trackIdx + 1) + '/' + totalTracks + '...');

                    var legacyWindows = [];
                    extractAndAnalyze(ffmpegPath, legacyPath,
                        function (windowIndex, rmsDb) { legacyWindows.push(rmsDb); },
                        function (extractErr, totalWindows) {
                            if (extractErr) {
                                onProgress(pctEnd, 'WARNING: Track ' + (trackIdx + 1) + ' failed.');
                                legacyWindows = [];
                            } else {
                                onProgress(pctEnd, 'Track ' + (trackIdx + 1) + ': ' + totalWindows + ' windows');
                            }
                            rmsData[trackIdx] = legacyWindows;
                            processNextTrack(trackIdx + 1);
                        }
                    );

                } else {
                    // No clips at all — silent track
                    onProgress(pctEnd, 'Track ' + (trackIdx + 1) + ': empty, filling silence.');
                    rmsData[trackIdx] = [];
                    processNextTrack(trackIdx + 1);
                }
            }

            function finalizeAnalysis() {
                // Find max window count
                var maxWindows = 0;
                for (var t = 0; t < rmsData.length; t++) {
                    if (rmsData[t].length > maxWindows) maxWindows = rmsData[t].length;
                }

                if (maxWindows === 0) {
                    onComplete(new Error('No audio data extracted from any track.'));
                    return;
                }

                // Pad shorter tracks with silence to equalize lengths
                // Critical for the conversation state machine which iterates all tracks per window
                for (var p = 0; p < rmsData.length; p++) {
                    while (rmsData[p].length < maxWindows) {
                        rmsData[p].push(-100);
                    }
                }

                var totalDuration = maxWindows * windowDuration;

                // ============================================================
                // STEP 2: Smooth RMS data
                // ============================================================
                onProgress(72, 'Smoothing RMS data...');
                var rmsSmoothed = smoothRmsData(rmsData);

                // ============================================================
                // STEP 3: Calibrate noise floor
                // ============================================================
                onProgress(74, 'Calibrating noise floor...');
                var noiseFloors = calibrateNoiseFloor(rmsData);
                var thresholds = [];
                for (var nf = 0; nf < noiseFloors.length; nf++) {
                    thresholds.push(noiseFloors[nf] + noiseFloorOffset);
                }

                var noiseFloorMsg = 'Noise floors: ';
                for (var nm = 0; nm < noiseFloors.length; nm++) {
                    noiseFloorMsg += 'T' + (nm + 1) + '=' + noiseFloors[nm].toFixed(1) + 'dB ';
                }
                onProgress(76, noiseFloorMsg);

                // ============================================================
                // STEP 4: Build speech segments (uses RAW RMS, not smoothed)
                // ============================================================
                onProgress(78, 'Building speech segments...');
                var segments = buildSpeechSegments(rmsData, thresholds, config);

                var totalSegments = 0;
                var segCounts = { REACTION: 0, SHORT_SPEECH: 0, PRIMARY_SPEECH: 0 };
                for (var st = 0; st < segments.length; st++) {
                    totalSegments += segments[st].length;
                    for (var ss = 0; ss < segments[st].length; ss++) {
                        segCounts[segments[st][ss].type] = (segCounts[segments[st][ss].type] || 0) + 1;
                    }
                }
                onProgress(80, totalSegments + ' segments (' +
                    segCounts.PRIMARY_SPEECH + ' primary, ' +
                    segCounts.SHORT_SPEECH + ' short, ' +
                    segCounts.REACTION + ' reactions)');

                // ============================================================
                // STEP 5: Run conversation engine (Layers 3+4+5)
                // ============================================================
                onProgress(82, 'Running conversation engine...');
                var engineResult = runConversationEngine(segments, rmsSmoothed, config);
                var cuts = engineResult.cuts;

                onProgress(88, cuts.length + ' camera cuts generated.');

                // ============================================================
                // STEP 6: Identify silence gaps (for Layer 6)
                // ============================================================
                onProgress(90, 'Identifying silence gaps...');
                var silenceGaps = identifySilenceGaps(segments, totalDuration);
                var removableGaps = 0;
                for (var sg = 0; sg < silenceGaps.length; sg++) {
                    if (silenceGaps[sg].classification === 'removable' ||
                        silenceGaps[sg].classification === 'strong_candidate') {
                        removableGaps++;
                    }
                }
                onProgress(92, silenceGaps.length + ' silence gaps found (' + removableGaps + ' removable).');

                // ============================================================
                // STEP 7: Build result
                // ============================================================
                onProgress(95, 'Building results...');

                // Count cut reasons
                var reasonCounts = {};
                for (var rc = 0; rc < cuts.length; rc++) {
                    var r = cuts[rc].reason;
                    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
                }

                // Count tempo zones
                var zoneCounts = { FAST: 0, NORMAL: 0, CALM: 0 };
                for (var tz = 0; tz < engineResult.tempoZones.length; tz++) {
                    var z = engineResult.tempoZones[tz].zone;
                    zoneCounts[z] = (zoneCounts[z] || 0) + 1;
                }

                var result = {
                    cuts: cuts,
                    silenceGaps: silenceGaps,
                    analysis: {
                        totalWindows: maxWindows,
                        windowSizeMs: WINDOW_SIZE_MS,
                        durationSeconds: totalDuration,
                        noiseFloors: noiseFloors,
                        thresholds: thresholds,
                        totalSegments: totalSegments,
                        segmentCounts: segCounts,
                        totalCuts: cuts.length,
                        reasonCounts: reasonCounts,
                        tempoZoneCounts: zoneCounts,
                        emotionalSpikes: engineResult.emotionalSpikes.length,
                        silenceGapCount: silenceGaps.length,
                        removableGapCount: removableGaps
                    }
                };

                onProgress(100, 'Done. ' + cuts.length + ' cuts, ' + totalSegments + ' segments.');
                onComplete(null, result);
            }

            // Start processing
            processNextTrack(0);
        });
    }

    // ============================================================
    // EXPORTS
    // ============================================================

    module.exports = {
        analyze: analyze,
        findFFmpeg: findFFmpeg,
        checkFFmpeg: checkFFmpeg,
        // Exposed for testing
        _smoothRmsData: smoothRmsData,
        _calibrateNoiseFloor: calibrateNoiseFloor,
        _buildSpeechSegments: buildSpeechSegments,
        _runConversationEngine: runConversationEngine,
        _selectCamera: selectCamera,
        _identifySilenceGaps: identifySilenceGaps,
        _buildConversationStates: buildConversationStates,
        _detectTempoZones: detectTempoZones,
        _detectEmotionalSpikes: detectEmotionalSpikes,
        _extractAndAnalyze: extractAndAnalyze,
        _extractAndAnalyzeClip: extractAndAnalyzeClip,
        _extractMultiClipTrack: extractMultiClipTrack
    };

})();
