/**
 * Auto Multi-Cam Edit - CEP Panel Orchestration (main.js)
 *
 * Bridges the UI, ExtendScript backend, and Node.js audio analyzer.
 * Handles all user interactions and data flow.
 *
 * v2.0 — Conversation-Aware Editing Engine:
 *   - Weighted mic-to-camera mapping (primary camera + wide shot %)
 *   - Sequence protection (clone before editing)
 *   - Silence removal (post-apply ripple delete)
 *   - New reason types (speaker_switch, monologue_variation, overlap_wide, overlap_dominant)
 */

(function () {
    'use strict';

    // ============================================================
    // GLOBALS & STATE
    // ============================================================

    var csInterface = new CSInterface();
    var extensionPath = null; // Resolved in init()

    // Sequence data from ExtendScript
    var sequenceInfo = null;

    // Cut analysis results from audio analyzer
    var analysisResult = null;

    // Active mapping entries: [{audioIndex, primaryCamera, widePercent}, ...]
    // Populated on scan, user can add/delete rows
    var activeMappings = [];

    // Main Audio track index (-1 = none, all tracks are camera mics)
    var mainAudioTrackIndex = -1;

    // Double-click protection for Apply button
    var isApplyingCuts = false;

    // ============================================================
    // INITIALIZATION
    // ============================================================

    /**
     * Load ExtendScript modules on panel startup.
     */
    function init() {
        log('info', 'Initializing Auto Multi-Cam Edit v2.0...');

        // Resolve extension path (must happen after CSInterface is ready)
        extensionPath = csInterface.getSystemPath(SystemPath.EXTENSION);
        if (!extensionPath) {
            log('error', 'Could not resolve extension path. CEP bridge may not be ready.');
            return;
        }
        log('info', 'Extension path: ' + extensionPath);

        // Normalize path for ExtendScript (forward slashes, URI-decoded)
        var extRoot = extensionPath.replace(/\\/g, '/');

        // Step 1: Load the ExtendScript entry point
        var scriptPath = extRoot + '/host/index.jsx';

        csInterface.evalScript('$.evalFile("' + scriptPath + '")', function (result) {
            if (result === 'EvalScript error.') {
                log('error', 'Failed to load ExtendScript entry point.');
                return;
            }

            // Step 2: Pass the extension root explicitly to load sub-modules
            csInterface.evalScript('$._autocam_.loadModules("' + extRoot + '")', function (loadResult) {
                if (loadResult === 'EvalScript error.') {
                    log('error', 'Failed to load ExtendScript sub-modules.');
                    return;
                }

                try {
                    var loadData = JSON.parse(loadResult);
                    if (loadData.error) {
                        log('error', 'Module load error: ' + loadData.error);
                        return;
                    }
                    if (loadData.errors && loadData.errors.length > 0) {
                        for (var i = 0; i < loadData.errors.length; i++) {
                            log('warning', 'Module warning: ' + loadData.errors[i]);
                        }
                    }
                } catch (e) {
                    // loadResult may not be JSON if modules loaded fine
                }

                // Step 3: Verify full connectivity
                csInterface.evalScript('$._autocam_.ping()', function (pingResult) {
                    try {
                        var data = JSON.parse(pingResult);
                        if (data.status === 'ok') {
                            log('success', 'Extension loaded. Sequence reader: ' +
                                data.hasSequenceReader + ', Editor: ' + data.hasMulticamEditor);
                        } else {
                            log('warning', 'Extension loaded but ping returned unexpected status.');
                        }
                    } catch (e) {
                        log('warning', 'Extension loaded. (ping: ' + pingResult + ')');
                    }
                });
            });
        });

        // Load saved settings
        loadSettings();

        // Apply Premiere Pro theme colors
        applyHostTheme();
    }

    /**
     * Match panel background to Premiere Pro's current theme.
     */
    function applyHostTheme() {
        try {
            var hostEnv = csInterface.getHostEnvironment();
            if (hostEnv && hostEnv.appSkinInfo) {
                var bgColor = hostEnv.appSkinInfo.panelBackgroundColor;
                if (bgColor && bgColor.color) {
                    var r = Math.round(bgColor.color.red);
                    var g = Math.round(bgColor.color.green);
                    var b = Math.round(bgColor.color.blue);
                    document.body.style.backgroundColor = 'rgb(' + r + ',' + g + ',' + b + ')';
                }
            }
        } catch (e) {
            // Fallback to CSS default
        }
    }

    // ============================================================
    // SEQUENCE SCANNING
    // ============================================================

    /**
     * Scan the active sequence in Premiere Pro.
     * Reads track info and source file paths.
     */
    window.scanSequence = function () {
        var btn = document.getElementById('btn-scan');
        btn.disabled = true;
        btn.textContent = 'Scanning...';
        log('info', 'Scanning active sequence...');

        csInterface.evalScript('$._autocam_.getSequenceInfo()', function (result) {
            btn.disabled = false;
            btn.textContent = 'Scan Active Sequence';

            if (result === 'EvalScript error.') {
                log('error', 'ExtendScript error. Make sure the extension is loaded.');
                return;
            }

            try {
                var data = JSON.parse(result);
                if (data.error) {
                    log('error', data.error);
                    return;
                }

                sequenceInfo = data;
                populateSequenceInfo(data);
                populateMainAudioDropdown(data);
                populateMappingGrid(data);
                populateWideShotDropdown(data);

                document.getElementById('btn-analyze').disabled = false;
                log('success', 'Sequence scanned: "' + data.sequenceName + '" (' +
                    data.videoTrackCount + 'V / ' + data.audioTrackCount + 'A tracks)');

            } catch (e) {
                log('error', 'Failed to parse sequence info: ' + e.message);
            }
        });
    };

    /**
     * Populate the Sequence Info panel with scanned data.
     */
    function populateSequenceInfo(data) {
        document.getElementById('seq-name').textContent = data.sequenceName;
        document.getElementById('seq-fps').textContent = data.frameRate.toFixed(2) + ' fps';
        document.getElementById('seq-vtracks').textContent = data.videoTrackCount;
        document.getElementById('seq-atracks').textContent = data.audioTrackCount;

        var durMin = Math.floor(data.durationSeconds / 60);
        var durSec = Math.floor(data.durationSeconds % 60);
        document.getElementById('seq-duration').textContent =
            durMin + 'm ' + durSec + 's';

        document.getElementById('sequence-info').classList.add('visible');
    }

    /**
     * Populate the Main Audio Track dropdown.
     */
    function populateMainAudioDropdown(data) {
        var select = document.getElementById('main-audio-track');
        while (select.options.length > 1) {
            select.remove(1);
        }

        for (var a = 0; a < data.audioTracks.length; a++) {
            var opt = document.createElement('option');
            opt.value = a;
            var trackName = data.audioTracks[a].name || ('A' + (a + 1));
            var clipName = (data.audioTracks[a].clips && data.audioTracks[a].clips.length > 0)
                ? ' - ' + data.audioTracks[a].clips[0].name : '';
            opt.textContent = trackName + clipName;
            select.appendChild(opt);
        }

        // Default: select the last audio track as Main Audio
        if (data.audioTracks.length > 1) {
            mainAudioTrackIndex = data.audioTracks.length - 1;
            select.value = mainAudioTrackIndex;
        }

        document.getElementById('main-audio-section').style.display = 'block';
    }

    /**
     * Handler when Main Audio track selection changes.
     */
    window.onMainAudioChanged = function () {
        var select = document.getElementById('main-audio-track');
        mainAudioTrackIndex = parseInt(select.value, 10);
        if (sequenceInfo) {
            populateMappingGrid(sequenceInfo);
        }
        log('info', 'Main Audio set to: ' + (mainAudioTrackIndex >= 0
            ? 'Track ' + (mainAudioTrackIndex + 1) + ' (excluded from analysis)'
            : 'None (all tracks analyzed)'));
    };

    /**
     * Build the mic-to-camera mapping grid.
     * Now includes primaryCamera + widePercent per mapping entry.
     */
    function populateMappingGrid(data) {
        activeMappings = [];
        var audioCount = Math.min(data.audioTracks.length, 10);
        var videoCount = data.videoTracks.length;
        var camTrackCounter = 0;

        for (var a = 0; a < audioCount; a++) {
            if (a === mainAudioTrackIndex) continue;
            activeMappings.push({
                audioIndex: a,
                primaryCamera: Math.min(camTrackCounter, videoCount - 1),
                widePercent: 20 // Default 20% wide shot
            });
            camTrackCounter++;
        }

        renderMappingGrid();
    }

    /**
     * Render the mapping grid from activeMappings.
     * Each row: Audio Track -> Primary Camera dropdown + Wide Shot % slider
     */
    function renderMappingGrid() {
        if (!sequenceInfo) return;
        var data = sequenceInfo;
        var grid = document.getElementById('mapping-grid');
        grid.innerHTML = '';

        var videoCount = data.videoTracks.length;

        for (var m = 0; m < activeMappings.length; m++) {
            var mapping = activeMappings[m];
            var aTrack = data.audioTracks[mapping.audioIndex];

            var row = document.createElement('div');
            row.className = 'mapping-row';

            // Audio track label
            var label = document.createElement('span');
            label.className = 'mapping-label';
            label.textContent = aTrack.name + (aTrack.clips.length > 0 ? '' : ' (empty)');
            label.title = aTrack.clips.length > 0 ? aTrack.clips[0].name : 'No clips';

            // Arrow
            var arrow = document.createElement('span');
            arrow.className = 'mapping-arrow';
            arrow.innerHTML = '&#8594;';

            // Primary camera dropdown
            var select = document.createElement('select');
            select.dataset.mappingIndex = m;
            for (var v = 0; v < videoCount; v++) {
                var opt = document.createElement('option');
                opt.value = v;
                opt.textContent = data.videoTracks[v].name;
                if (v === mapping.primaryCamera) opt.selected = true;
                select.appendChild(opt);
            }

            select.addEventListener('change', (function (idx) {
                return function () {
                    activeMappings[idx].primaryCamera = parseInt(this.value, 10);
                };
            })(m));

            // Delete button
            var delBtn = document.createElement('span');
            delBtn.className = 'mapping-delete';
            delBtn.innerHTML = '&#215;';
            delBtn.title = 'Remove this mapping';
            delBtn.addEventListener('click', (function (idx) {
                return function () {
                    removeMappingRow(idx);
                };
            })(m));

            row.appendChild(label);
            row.appendChild(arrow);
            row.appendChild(select);
            row.appendChild(delBtn);

            // Wide shot % sub-row
            var wideRow = document.createElement('div');
            wideRow.className = 'mapping-wide-row';

            var wideLabel = document.createElement('label');
            wideLabel.textContent = 'Wide Freq:';

            var wideSlider = document.createElement('input');
            wideSlider.type = 'range';
            wideSlider.min = '0';
            wideSlider.max = '50';
            wideSlider.value = mapping.widePercent;
            wideSlider.step = '5';
            wideSlider.dataset.mappingIndex = m;

            var wideValue = document.createElement('span');
            wideValue.className = 'mapping-wide-value';
            wideValue.textContent = mapping.widePercent + '%';

            wideSlider.addEventListener('input', (function (idx, valSpan) {
                return function () {
                    activeMappings[idx].widePercent = parseInt(this.value, 10);
                    valSpan.textContent = this.value + '%';
                };
            })(m, wideValue));

            wideRow.appendChild(wideLabel);
            wideRow.appendChild(wideSlider);
            wideRow.appendChild(wideValue);
            row.appendChild(wideRow);

            grid.appendChild(row);
        }

        // Add mapping controls at the bottom
        renderAddMappingControls(data, grid);

        document.getElementById('mapping-section').classList.add('visible');
    }

    /**
     * Render the "Add Mapping" controls at the bottom of the mapping grid.
     */
    function renderAddMappingControls(data, grid) {
        var mappedAudioIndices = {};
        for (var m = 0; m < activeMappings.length; m++) {
            mappedAudioIndices[activeMappings[m].audioIndex] = true;
        }

        var hasUnmapped = false;
        for (var a = 0; a < data.audioTracks.length; a++) {
            if (a === mainAudioTrackIndex) continue;
            if (!mappedAudioIndices[a]) { hasUnmapped = true; break; }
        }

        if (!hasUnmapped) return;

        var addRow = document.createElement('div');
        addRow.className = 'mapping-row mapping-add-row';

        // Audio track dropdown
        var audioSelect = document.createElement('select');
        audioSelect.id = 'add-audio-select';

        for (var a2 = 0; a2 < data.audioTracks.length; a2++) {
            if (a2 === mainAudioTrackIndex) continue;
            if (mappedAudioIndices[a2]) continue;
            var opt = document.createElement('option');
            opt.value = a2;
            opt.textContent = data.audioTracks[a2].name;
            audioSelect.appendChild(opt);
        }

        // Arrow
        var arrow = document.createElement('span');
        arrow.className = 'mapping-arrow';
        arrow.innerHTML = '&#8594;';

        // Camera dropdown
        var cameraSelect = document.createElement('select');
        cameraSelect.id = 'add-camera-select';
        for (var v = 0; v < data.videoTracks.length; v++) {
            var camOpt = document.createElement('option');
            camOpt.value = v;
            camOpt.textContent = data.videoTracks[v].name;
            cameraSelect.appendChild(camOpt);
        }

        // Add button
        var addBtn = document.createElement('span');
        addBtn.className = 'mapping-add-btn';
        addBtn.innerHTML = '+';
        addBtn.title = 'Add this mapping';
        addBtn.addEventListener('click', function () {
            addMappingRow();
        });

        addRow.appendChild(audioSelect);
        addRow.appendChild(arrow);
        addRow.appendChild(cameraSelect);
        addRow.appendChild(addBtn);
        grid.appendChild(addRow);
    }

    /**
     * Add a new mapping row.
     */
    function addMappingRow() {
        var audioSelect = document.getElementById('add-audio-select');
        var cameraSelect = document.getElementById('add-camera-select');
        if (!audioSelect || !cameraSelect) return;

        var audioIndex = parseInt(audioSelect.value, 10);
        var cameraIndex = parseInt(cameraSelect.value, 10);
        if (isNaN(audioIndex)) return;

        activeMappings.push({
            audioIndex: audioIndex,
            primaryCamera: cameraIndex,
            widePercent: 20
        });

        log('info', 'Added mapping: A' + (audioIndex + 1) + ' \u2192 V' + (cameraIndex + 1));
        renderMappingGrid();
    }

    /**
     * Remove a mapping row by its index.
     */
    function removeMappingRow(index) {
        if (index < 0 || index >= activeMappings.length) return;
        var removed = activeMappings.splice(index, 1)[0];
        log('info', 'Removed mapping: A' + (removed.audioIndex + 1) + ' \u2192 V' + (removed.primaryCamera + 1));
        renderMappingGrid();
    }

    /**
     * Populate the wide shot track dropdown with available video tracks.
     */
    function populateWideShotDropdown(data) {
        var select = document.getElementById('wide-shot-track');
        while (select.options.length > 1) {
            select.remove(1);
        }

        for (var v = 0; v < data.videoTracks.length; v++) {
            var opt = document.createElement('option');
            opt.value = v;
            opt.textContent = data.videoTracks[v].name;
            select.appendChild(opt);
        }

        // Default: last video track
        if (data.videoTracks.length > 2) {
            select.value = data.videoTracks.length - 1;
        }
    }

    // ============================================================
    // WEIGHTED CAMERA MAPPING
    // ============================================================

    /**
     * Build speaker camera weights from active mappings and wide shot track.
     * Simple mode: Each speaker gets primaryCamera close-up at (100 - wide)%
     *              and wideShotTrack at wide%.
     *
     * Output: { speakerTrackIdx: [{cameraIndex, weight}, ...], ... }
     */
    function buildSpeakerCameraWeights() {
        var wideShotTrack = parseInt(document.getElementById('wide-shot-track').value, 10);
        var weights = {};

        for (var m = 0; m < activeMappings.length; m++) {
            var mapping = activeMappings[m];
            // The "speakerTrack" from the analyzer's perspective is the filtered index,
            // not the original audioIndex. During analyze, tracks are numbered 0, 1, 2...
            var filteredIdx = m; // Sequential index of this mapping
            var closeWeight = 100 - mapping.widePercent;
            var wideWeight = mapping.widePercent;

            var pool = [
                { cameraIndex: mapping.primaryCamera, weight: closeWeight }
            ];

            // Add wide shot if configured and different from primary
            if (wideShotTrack >= 0 && wideShotTrack !== mapping.primaryCamera && wideWeight > 0) {
                pool.push({ cameraIndex: wideShotTrack, weight: wideWeight });
            }

            weights[filteredIdx] = pool;
        }

        return weights;
    }

    // ============================================================
    // AUDIO ANALYSIS
    // ============================================================

    /**
     * Run the audio analysis pipeline.
     * Uses the new 7-layer conversation-aware engine.
     */
    window.analyzeAudio = function () {
        if (!sequenceInfo) {
            log('error', 'No sequence scanned. Click "Scan Active Sequence" first.');
            return;
        }

        var btn = document.getElementById('btn-analyze');
        btn.disabled = true;
        btn.textContent = 'Analyzing...';
        showProgress(true);

        log('info', 'Starting conversation-aware audio analysis...');

        // Gather audio track data from active mappings — ALL clips per track
        var audioTracks = [];

        for (var m = 0; m < activeMappings.length; m++) {
            var audioIdx = activeMappings[m].audioIndex;

            var at = sequenceInfo.audioTracks[audioIdx];

            // Collect ALL clips for this track with timeline positions
            var trackClips = [];
            var firstMediaPath = '';

            if (at.clips && at.clips.length > 0) {
                firstMediaPath = at.clips[0].mediaPath || '';
                for (var c = 0; c < at.clips.length; c++) {
                    var clip = at.clips[c];
                    trackClips.push({
                        mediaPath: clip.mediaPath || '',
                        startSeconds: clip.startSeconds || 0,
                        endSeconds: clip.endSeconds || 0,
                        inPointSeconds: clip.inPointSeconds || 0,
                        outPointSeconds: clip.outPointSeconds || 0
                    });
                }
            }

            audioTracks.push({
                index: audioTracks.length,
                originalIndex: audioIdx,
                mediaPath: firstMediaPath,  // backward-compat for single-clip
                clips: trackClips
            });

            log('info', 'Track ' + (audioTracks.length) + ' (A' + (audioIdx + 1) + '): ' +
                trackClips.length + ' clip(s)');
        }

        if (audioTracks.length === 0) {
            log('error', 'No audio tracks mapped. Add mappings in the Mic-to-Camera section.');
            btn.disabled = false;
            btn.textContent = 'Analyze Audio';
            showProgress(false);
            return;
        }

        log('info', 'Analyzing ' + audioTracks.length + ' mapped audio tracks...');

        // Build config for the conversation-aware engine
        var config = {
            extensionRoot: cep_node.require('path').resolve(extensionPath),
            frameRate: sequenceInfo.frameRate,
            // Layer 1: Noise floor
            noiseFloorOffset: parseFloat(document.getElementById('noise-floor-offset').value),
            // Layer 2: Speech segments
            speechStartMs: parseInt(document.getElementById('speech-start-ms').value, 10) || 120,
            speechEndMs: parseInt(document.getElementById('speech-end-ms').value, 10) || 200,
            // Layer 3: State machine
            minShotDurationSec: parseFloat(document.getElementById('min-shot-duration').value),
            prerollFrames: parseInt(document.getElementById('preroll').value, 10),
            suppressionWindowSec: 2.0,
            minSpeakerDurationSec: 1.2,
            reactionIgnoreMaxSec: 0.8,
            overlapIgnoreMaxSec: 0.5,
            // Layer 4: Rhythm & Emotion
            monologueThreshold: parseFloat(document.getElementById('monologue-threshold').value) || 10,
            overlapRmsDiff: parseInt(document.getElementById('overlap-rms-diff').value, 10) || 20,
            spikeThreshold: parseFloat(document.getElementById('spike-threshold').value) || 25,
            // Layer 5: Camera decision
            wideShotTrack: parseInt(document.getElementById('wide-shot-track').value, 10),
            memoryStrictness: parseFloat(document.getElementById('memory-strictness').value) || 0.3,
            speakerCameraWeights: buildSpeakerCameraWeights(),
            cutawayDurationSec: parseFloat(document.getElementById('cutaway-duration').value) || 0.75,
            // Audio tracks
            audioTracks: audioTracks
        };

        // Load and run the Node.js audio analyzer
        try {
            var nodePath = cep_node.require('path');
            var analyzerPath = nodePath.resolve(extensionPath, 'client', 'js', 'audio-analyzer.js');

            // Clear module cache to pick up any changes
            delete cep_node.require.cache[analyzerPath];
            var analyzer = cep_node.require(analyzerPath);

            analyzer.analyze(
                config,
                function onProgress(percent, message) {
                    updateProgress(percent, message);
                    log('info', '[' + percent + '%] ' + message);
                },
                function onComplete(err, result) {
                    btn.disabled = false;
                    btn.textContent = 'Analyze Audio';

                    if (err) {
                        showProgress(false);
                        log('error', 'Analysis failed: ' + err.message);
                        return;
                    }

                    analysisResult = result;
                    updateProgress(100, 'Complete!');

                    log('success', 'Analysis complete: ' + result.cuts.length + ' cuts detected.');

                    // Log analysis stats
                    var a = result.analysis;
                    log('info', 'Segments: ' + a.totalSegments +
                        ' (P:' + a.segmentCounts.PRIMARY_SPEECH +
                        ' S:' + a.segmentCounts.SHORT_SPEECH +
                        ' R:' + a.segmentCounts.REACTION + ')');

                    if (a.reasonCounts) {
                        var reasons = [];
                        for (var r in a.reasonCounts) {
                            reasons.push(r + ':' + a.reasonCounts[r]);
                        }
                        log('info', 'Cut reasons: ' + reasons.join(', '));
                    }

                    // Diagnostic: cutaway breakdown
                    var reactionCount = (a.reasonCounts && a.reasonCounts.reaction_cutaway) || 0;
                    var wideCount = (a.reasonCounts && a.reasonCounts.wide_cutaway) || 0;
                    var cutawayReturnCount = (a.reasonCounts && a.reasonCounts.cutaway_return) || 0;
                    if (reactionCount === 0 && wideCount === 0) {
                        log('warning', 'NO cutaway cuts generated! Check Wide Freq% slider (set to 20%+) and Wide Shot Camera Track dropdown.');
                    } else {
                        log('success', 'Cutaways: ' + reactionCount + ' to other speaker, ' + wideCount + ' to wide, ' + cutawayReturnCount + ' returns');
                    }

                    log('info', 'Tempo zones - FAST:' + a.tempoZoneCounts.FAST +
                        ' NORMAL:' + a.tempoZoneCounts.NORMAL +
                        ' CALM:' + a.tempoZoneCounts.CALM);

                    if (a.removableGapCount > 0) {
                        log('info', 'Silence gaps: ' + a.silenceGapCount +
                            ' (' + a.removableGapCount + ' removable)');
                    }

                    document.getElementById('btn-preview').disabled = false;
                    document.getElementById('btn-apply').disabled = false;

                    // Show silence removal button + settings if gaps found
                    if (result.silenceGaps && result.silenceGaps.length > 0) {
                        document.getElementById('silence-settings').style.display = 'block';
                        document.getElementById('btn-silence').disabled = false;
                    }

                    // Auto-show preview
                    showPreview();
                }
            );
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Analyze Audio';
            showProgress(false);
            log('error', 'Failed to load audio analyzer: ' + e.message);
        }
    };

    // ============================================================
    // CUT PREVIEW
    // ============================================================

    /**
     * Display the cut preview table in the UI.
     * Updated for new reason types.
     */
    window.showPreview = function () {
        if (!analysisResult || !analysisResult.cuts) {
            log('warning', 'No analysis results to preview.');
            return;
        }

        var cuts = analysisResult.cuts;
        var tbody = document.getElementById('preview-tbody');
        tbody.innerHTML = '';

        var switchCount = 0;
        var monologueCount = 0;
        var overlapCount = 0;
        var cutawayCount = 0;
        var wideCount = 0;

        for (var i = 0; i < cuts.length; i++) {
            var cut = cuts[i];
            var tr = document.createElement('tr');

            // Row number
            var tdNum = document.createElement('td');
            tdNum.textContent = i + 1;
            tr.appendChild(tdNum);

            // Timecode
            var tdTime = document.createElement('td');
            tdTime.textContent = formatTimecode(cut.timeSeconds, sequenceInfo.frameRate);
            tr.appendChild(tdTime);

            // Camera name
            var tdCam = document.createElement('td');
            var camName = getCameraName(cut.cameraIndex);
            tdCam.textContent = camName;
            tr.appendChild(tdCam);

            // Reason with color coding
            var tdReason = document.createElement('td');
            var reasonDisplay = cut.reason.replace(/_/g, ' ');
            tdReason.textContent = reasonDisplay;

            // Apply reason-specific CSS class
            switch (cut.reason) {
                case 'speaker_switch':
                    tdReason.className = 'reason-speaker-switch';
                    switchCount++;
                    break;
                case 'monologue_variation':
                    tdReason.className = 'reason-monologue-variation';
                    monologueCount++;
                    break;
                case 'overlap_wide':
                    tdReason.className = 'reason-overlap-wide';
                    overlapCount++;
                    break;
                case 'overlap_dominant':
                    tdReason.className = 'reason-overlap-dominant';
                    overlapCount++;
                    break;
                case 'cutaway_return':
                    tdReason.className = 'reason-cutaway-return';
                    cutawayCount++;
                    break;
                case 'wide_cutaway':
                    tdReason.className = 'reason-monologue-variation';
                    wideCount++;
                    break;
                case 'reaction_cutaway':
                    tdReason.className = 'reason-reaction-cutaway';
                    cutawayCount++;
                    break;
                case 'reaction_wide':
                    tdReason.className = 'reason-overlap-wide';
                    wideCount++;
                    break;
                case 'initial':
                    tdReason.className = 'reason-initial';
                    break;
                default:
                    tdReason.className = 'reason-initial';
                    break;
            }
            tr.appendChild(tdReason);

            // Delete button
            var tdDel = document.createElement('td');
            tdDel.className = 'cut-delete';
            tdDel.innerHTML = '&#10005;';
            tdDel.title = 'Remove this cut';
            tdDel.dataset.cutIndex = i;
            tdDel.addEventListener('click', removeCut);
            tr.appendChild(tdDel);

            tbody.appendChild(tr);
        }

        // Update stats
        document.getElementById('stat-cuts').textContent = cuts.length;
        document.getElementById('stat-switches').textContent = switchCount;
        document.getElementById('stat-monologue').textContent = monologueCount;
        document.getElementById('stat-overlap').textContent = overlapCount;
        document.getElementById('stat-cutaway').textContent = cutawayCount;
        document.getElementById('stat-wide').textContent = wideCount;

        document.getElementById('preview-section').classList.add('visible');
    };

    /**
     * Remove a cut from the preview list.
     */
    function removeCut(e) {
        var idx = parseInt(e.target.dataset.cutIndex, 10);
        if (analysisResult && analysisResult.cuts && idx >= 0) {
            analysisResult.cuts.splice(idx, 1);
            analysisResult.analysis.totalCuts = analysisResult.cuts.length;
            showPreview();
            log('info', 'Removed cut #' + (idx + 1));
        }
    }

    // ============================================================
    // APPLY CUTS (with Sequence Protection)
    // ============================================================

    /**
     * Safely escape a JSON string for passing through csInterface.evalScript.
     */
    function escapeForEvalScript(jsonStr) {
        return JSON.stringify(jsonStr);
    }

    /**
     * Send cut decisions to ExtendScript for timeline execution.
     * Layer 7: Optionally duplicates sequence first.
     * Then: prepare -> razor batches -> enable/disable per track.
     */
    window.applyCuts = function () {
        if (isApplyingCuts) {
            log('warning', 'Apply already in progress. Please wait...');
            return;
        }
        if (!analysisResult || !analysisResult.cuts || analysisResult.cuts.length === 0) {
            log('error', 'No cuts to apply. Run audio analysis first.');
            return;
        }
        isApplyingCuts = true;

        var btn = document.getElementById('btn-apply');
        btn.disabled = true;
        btn.textContent = 'Applying...';
        showProgress(true);
        updateProgress(0, 'Starting...');

        log('info', 'Starting cut application (' + analysisResult.cuts.length + ' cuts)...');

        var protectSequence = document.getElementById('protect-sequence').checked;

        if (protectSequence) {
            // Layer 7: Duplicate sequence before editing
            updateProgress(2, 'Duplicating sequence (protection mode)...');
            log('info', 'Protecting original — duplicating sequence...');

            csInterface.evalScript('$._autocam_.duplicateSequence()', function (dupResult) {
                if (dupResult === 'EvalScript error.') {
                    applyDone('ExtendScript error during sequence duplication.');
                    return;
                }

                try {
                    var dupData = JSON.parse(dupResult);
                    if (dupData.error) {
                        applyDone('Sequence duplication failed: ' + dupData.error);
                        return;
                    }

                    log('success', 'Working on clone: "' + dupData.sequenceName + '"');
                    updateProgress(5, 'Clone ready. Preparing timeline...');

                    // Continue with the actual apply steps
                    executeApply();
                } catch (e) {
                    applyDone('Failed to parse duplication result: ' + e.message);
                }
            });
        } else {
            log('warning', 'SAVE your project before applying! Sequence protection is OFF.');
            executeApply();
        }

        function executeApply() {
            // Begin undo group so ALL changes can be undone with a single Ctrl+Z
            csInterface.evalScript('$._autocam_.beginUndoGroup()', function () {});

            // Build payload for the prepare step
            var payload = {
                cuts: analysisResult.cuts,
                frameRate: sequenceInfo.frameRate
            };
            var escapedArg = escapeForEvalScript(JSON.stringify(payload));

            // ========================================
            // STEP 1: Prepare Timeline
            // ========================================
            updateProgress(8, 'Preparing timeline...');

            csInterface.evalScript(
                "$._autocam_.prepareTimeline(" + escapedArg + ")",
                function (result) {
                    if (result === 'EvalScript error.') {
                        applyDone('ExtendScript error during preparation.');
                        return;
                    }

                    try {
                        var prep = JSON.parse(result);
                        if (prep.error) {
                            applyDone('Preparation failed: ' + prep.error);
                            return;
                        }

                        var totalTimecodes = prep.totalTimecodes;
                        var totalTracks = prep.videoTrackCount;

                        log('success', 'Prepared: ' + totalTimecodes + ' razor points, ' +
                            prep.totalIntervals + ' intervals, ' + totalTracks + ' video tracks');

                        updateProgress(12, 'Razor cuts starting...');

                        // ========================================
                        // STEP 2: Razor Cuts in Batches
                        // ========================================
                        var razorIndex = 0;
                        var razorBatchSize = 5;
                        var totalRazorSuccess = 0;
                        var totalRazorFailed = 0;

                        function nextRazorBatch() {
                            if (razorIndex >= totalTimecodes) {
                                log('success', 'Razor complete: ' + totalRazorSuccess + ' cuts' +
                                    (totalRazorFailed > 0 ? ' (' + totalRazorFailed + ' failed)' : ''));
                                updateProgress(60, 'Switching cameras...');
                                setTimeout(startEnableDisable, 500);
                                return;
                            }

                            var pct = 12 + Math.round((razorIndex / totalTimecodes) * 48);
                            updateProgress(pct, 'Razor: ' + Math.min(razorIndex + razorBatchSize, totalTimecodes) + '/' + totalTimecodes);

                            csInterface.evalScript(
                                '$._autocam_.razorBatch(' + razorIndex + ', ' + razorBatchSize + ')',
                                function (batchResult) {
                                    if (batchResult === 'EvalScript error.') {
                                        log('warning', 'Razor batch error at index ' + razorIndex);
                                    } else {
                                        try {
                                            var br = JSON.parse(batchResult);
                                            if (br.error) {
                                                log('warning', 'Razor batch: ' + br.error);
                                            } else {
                                                totalRazorSuccess += br.success;
                                                totalRazorFailed += br.failed;
                                                if (br.errors && br.errors.length > 0) {
                                                    for (var e = 0; e < br.errors.length; e++) {
                                                        log('warning', 'Razor: ' + br.errors[e]);
                                                    }
                                                }
                                            }
                                        } catch (ex) {
                                            log('warning', 'Could not parse razor batch result.');
                                        }
                                    }

                                    razorIndex += razorBatchSize;
                                    setTimeout(nextRazorBatch, 50);
                                }
                            );
                        }

                        // ========================================
                        // STEP 3: Enable/Disable Per Track
                        // ========================================
                        var trackIndex = 0;
                        var totalEnabled = 0;
                        var totalDisabled = 0;

                        function startEnableDisable() {
                            log('info', 'Applying camera switches across ' + totalTracks + ' video tracks...');
                            nextTrackEnableDisable();
                        }

                        function nextTrackEnableDisable() {
                            if (trackIndex >= totalTracks) {
                                finishApply();
                                return;
                            }

                            var pct = 60 + Math.round((trackIndex / totalTracks) * 35);
                            updateProgress(pct, 'Camera switch: V' + (trackIndex + 1) + '/' + totalTracks);

                            csInterface.evalScript(
                                '$._autocam_.enableDisableTrack(' + trackIndex + ')',
                                function (trackResult) {
                                    if (trackResult === 'EvalScript error.') {
                                        log('warning', 'Enable/disable error on V' + (trackIndex + 1));
                                    } else {
                                        try {
                                            var tr = JSON.parse(trackResult);
                                            if (tr.error) {
                                                log('warning', 'V' + (trackIndex + 1) + ': ' + tr.error);
                                            } else {
                                                totalEnabled += tr.enabled;
                                                totalDisabled += tr.disabled;
                                                log('info', 'V' + (trackIndex + 1) + ': ' + tr.clipCount + ' clips (' +
                                                    tr.enabled + ' on, ' + tr.disabled + ' off)');
                                            }
                                        } catch (ex) {
                                            log('warning', 'Could not parse track result for V' + (trackIndex + 1));
                                        }
                                    }

                                    trackIndex++;
                                    setTimeout(nextTrackEnableDisable, 50);
                                }
                            );
                        }

                        // ========================================
                        // STEP 4: Finish
                        // ========================================
                        function finishApply() {
                            // End undo group so Ctrl+Z undoes ALL cuts in one step
                            csInterface.evalScript('$._autocam_.endUndoGroup()', function () {});

                            updateProgress(100, 'Complete!');
                            log('success', '=== CUTS APPLIED SUCCESSFULLY ===');
                            log('success', 'Razor: ' + totalRazorSuccess + ' operations' +
                                (totalRazorFailed > 0 ? ' (' + totalRazorFailed + ' failed)' : ''));
                            log('success', 'Clips: ' + totalEnabled + ' enabled, ' + totalDisabled + ' disabled');

                            // Post-apply guidance
                            var seqName = sequenceInfo ? sequenceInfo.sequenceName : 'sequence';
                            var protectOn = document.getElementById('protect-sequence').checked;
                            if (protectOn) {
                                log('info', 'Original sequence untouched. Working on "' + seqName + '_AUTO_EDIT".');
                            }
                            log('info', 'Tip: Ctrl+Z to undo all cuts. Scrub timeline to verify camera switches.');

                            btn.disabled = false;
                            btn.textContent = 'Apply Cuts to Timeline';
                            isApplyingCuts = false;

                            // Enable silence removal button ONLY after Apply completes
                            if (analysisResult.silenceGaps && analysisResult.silenceGaps.length > 0) {
                                document.getElementById('btn-silence').disabled = false;
                                log('info', '"Remove Silence Gaps" is now available.');
                            }
                        }

                        // Start the razor batch chain
                        nextRazorBatch();

                    } catch (e) {
                        applyDone('Failed to parse preparation result: ' + e.message);
                    }
                }
            );
        }

        function applyDone(errorMsg) {
            if (errorMsg) {
                log('error', errorMsg);
            }
            showProgress(false);
            btn.disabled = false;
            btn.textContent = 'Apply Cuts to Timeline';
            isApplyingCuts = false;
        }
    };

    // ============================================================
    // SILENCE REMOVAL (Layer 6)
    // ============================================================

    /**
     * Remove silence gaps from the timeline using safe ripple delete.
     * Sends identified gaps to ExtendScript for removal.
     */
    window.removeSilence = function () {
        if (!analysisResult || !analysisResult.silenceGaps) {
            log('error', 'No silence gap data. Run analysis first.');
            return;
        }

        var minGapSec = parseFloat(document.getElementById('min-silence-gap').value) || 1.5;

        // Filter gaps by minimum duration and classification
        var gapsToRemove = [];
        for (var g = 0; g < analysisResult.silenceGaps.length; g++) {
            var gap = analysisResult.silenceGaps[g];
            if (gap.durationSec >= minGapSec &&
                (gap.classification === 'removable' || gap.classification === 'strong_candidate')) {

                // Add 150ms safety buffer on each side
                var bufferSec = 0.15;
                var paddedStart = gap.startSec + bufferSec;
                var paddedEnd = gap.endSec - bufferSec;

                if (paddedEnd > paddedStart + 0.1) { // Must still have content to remove
                    gapsToRemove.push({
                        paddedStart: paddedStart,
                        paddedEnd: paddedEnd,
                        durationMs: (paddedEnd - paddedStart) * 1000,
                        originalStart: gap.startSec,
                        originalEnd: gap.endSec
                    });
                }
            }
        }

        if (gapsToRemove.length === 0) {
            log('warning', 'No silence gaps meet the minimum duration (' + minGapSec + 's). Adjust the slider or threshold.');
            return;
        }

        var btn = document.getElementById('btn-silence');
        btn.disabled = true;
        btn.textContent = 'Removing silence...';
        showProgress(true);
        updateProgress(0, 'Preparing silence removal...');

        log('info', 'Starting silence removal: ' + gapsToRemove.length + ' gaps (min ' + minGapSec + 's)');

        // SEQUENCE PROTECTION: Duplicate sequence before ripple delete
        log('info', 'Protecting original — duplicating sequence before ripple delete...');
        updateProgress(5, 'Duplicating sequence for protection...');

        csInterface.evalScript('$._autocam_.duplicateSequence()', function (dupResult) {
            if (dupResult === 'EvalScript error.') {
                log('error', 'ExtendScript error during sequence duplication.');
                btn.disabled = false;
                btn.textContent = 'Remove Silence Gaps';
                showProgress(false);
                return;
            }

            try {
                var dupData = JSON.parse(dupResult);
                if (dupData.error) {
                    log('error', 'Sequence duplication failed: ' + dupData.error);
                    btn.disabled = false;
                    btn.textContent = 'Remove Silence Gaps';
                    showProgress(false);
                    return;
                }

                log('success', 'Working on clone: "' + dupData.sequenceName + '"');

                // Verify clone is actually active (not still on original)
                if (!dupData.cloneFound || dupData.sequenceName === dupData.originalName) {
                    log('error', 'Clone did not activate. Ripple delete aborted to protect original.');
                    log('info', 'Tip: Try opening the "_AUTO_EDIT" sequence manually then re-run.');
                    btn.disabled = false;
                    btn.textContent = 'Remove Silence Gaps';
                    showProgress(false);
                    return;
                }

                updateProgress(15, 'Clone ready. Starting ripple delete...');
            } catch (e) {
                log('error', 'Failed to parse duplication result: ' + e.message);
                btn.disabled = false;
                btn.textContent = 'Remove Silence Gaps';
                showProgress(false);
                return;
            }

            // Begin undo group for single Ctrl+Z undo
            csInterface.evalScript('$._autocam_.beginUndoGroup()', function () {});

            log('warning', 'Note: After silence removal, cut timecodes will shift!');

            var escapedGaps = escapeForEvalScript(JSON.stringify(gapsToRemove));

            updateProgress(20, 'Removing ' + gapsToRemove.length + ' gaps (may take ~'
                + Math.ceil(gapsToRemove.length * 0.2) + 's)...');

            csInterface.evalScript(
                '$._autocam_.rippleDeleteSilence(' + escapedGaps + ')',
                function (result) {
                    // End undo group
                    csInterface.evalScript('$._autocam_.endUndoGroup()', function () {});

                    btn.disabled = false;
                    btn.textContent = 'Remove Silence Gaps';
                    showProgress(false);

                    if (result === 'EvalScript error.') {
                        log('error', 'ExtendScript error during silence removal.');
                        return;
                    }

                    try {
                        var data = JSON.parse(result);
                        if (data.error) {
                            log('error', 'Silence removal failed: ' + data.error);
                            return;
                        }

                        updateProgress(100, 'Complete!');
                        log('success', '=== SILENCE REMOVAL COMPLETE ===');
                        log('success', 'Removed: ' + data.removed + ' gaps (' + data.totalRemovedSeconds.toFixed(1) + 's)');
                        if (data.skipped > 0) {
                            log('warning', 'Skipped: ' + data.skipped + ' gaps (locked tracks or markers)');
                        }
                        if (data.errors && data.errors.length > 0) {
                            for (var e = 0; e < data.errors.length; e++) {
                                log('warning', data.errors[e]);
                            }
                        }
                        log('info', 'New sequence duration: ' + data.newDuration.toFixed(1) + 's');
                        log('info', 'Tip: Ctrl+Z to undo all silence removal. Original sequence untouched.');

                    } catch (e) {
                        log('error', 'Failed to parse silence removal result: ' + e.message);
                    }
                }
            );
        });
    };

    // ============================================================
    // UI HELPERS
    // ============================================================

    /**
     * Toggle advanced settings visibility.
     */
    window.toggleAdvancedSettings = function () {
        var panel = document.getElementById('advanced-settings');
        var arrow = document.getElementById('advanced-arrow');
        if (panel.style.display === 'none') {
            panel.style.display = 'flex';
            arrow.classList.add('open');
        } else {
            panel.style.display = 'none';
            arrow.classList.remove('open');
        }
    };

    /**
     * Update a setting display value when slider changes.
     */
    window.updateSettingDisplay = function (id, displayText) {
        document.getElementById(id + '-value').textContent = displayText;
    };

    /**
     * Show/hide progress bar.
     */
    function showProgress(visible) {
        var container = document.getElementById('progress-container');
        if (visible) {
            container.classList.add('visible');
        } else {
            container.classList.remove('visible');
        }
    }

    /**
     * Update progress bar fill and text.
     */
    function updateProgress(percent, message) {
        var fill = document.getElementById('progress-fill');
        var text = document.getElementById('progress-text');
        fill.style.width = percent + '%';
        text.textContent = percent + '%' + (message ? ' - ' + message : '');
    }

    /**
     * Format seconds as timecode HH:MM:SS:FF.
     */
    function formatTimecode(seconds, fps) {
        if (seconds < 0) seconds = 0;
        var roundedFps = Math.round(fps);

        function pad(n) {
            return n < 10 ? '0' + n : '' + n;
        }

        var fpsR = Math.round(fps * 100) / 100;
        var isDF = (Math.abs(fpsR - 29.97) < 0.02) || (Math.abs(fpsR - 59.94) < 0.02);

        if (!isDF) {
            var totalFrames = Math.round(seconds * roundedFps);
            var ff = totalFrames % roundedFps;
            var totalSecs = Math.floor(totalFrames / roundedFps);
            var ss = totalSecs % 60;
            var totalMins = Math.floor(totalSecs / 60);
            var mm = totalMins % 60;
            var hh = Math.floor(totalMins / 60);
            return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);
        }

        // Drop-frame timecode (SMPTE 12M)
        var d = (roundedFps === 30) ? 2 : 4;
        var totalFramesDF = Math.round(seconds * fps);
        var fpm = roundedFps * 60 - d;
        var fp10m = fpm * 10 + d;

        var blocks10 = Math.floor(totalFramesDF / fp10m);
        var rem10 = totalFramesDF % fp10m;
        var extraMin = (rem10 < d) ? 0 : Math.floor((rem10 - d) / fpm) + 1;

        var displayFrame = totalFramesDF + d * (9 * blocks10 + extraMin);
        var dfFF = displayFrame % roundedFps;
        var dfS = Math.floor(displayFrame / roundedFps);
        var dfSS = dfS % 60;
        var dfM = Math.floor(dfS / 60);
        var dfMM = dfM % 60;
        var dfHH = Math.floor(dfM / 60);

        return pad(dfHH) + ';' + pad(dfMM) + ';' + pad(dfSS) + ';' + pad(dfFF);
    }

    /**
     * Get camera/track display name by video track index.
     */
    function getCameraName(trackIndex) {
        if (sequenceInfo && sequenceInfo.videoTracks && trackIndex < sequenceInfo.videoTracks.length) {
            return sequenceInfo.videoTracks[trackIndex].name;
        }
        return 'Cam ' + (trackIndex + 1);
    }

    /**
     * Add a message to the status log.
     */
    function log(level, message) {
        var logDiv = document.getElementById('status-log');
        var entry = document.createElement('div');
        entry.className = 'log-entry ' + level;

        var timestamp = new Date();
        var timeStr = pad2(timestamp.getHours()) + ':' + pad2(timestamp.getMinutes()) + ':' +
                      pad2(timestamp.getSeconds());

        entry.textContent = '[' + timeStr + '] ' + message;
        logDiv.appendChild(entry);
        logDiv.scrollTop = logDiv.scrollHeight;

        while (logDiv.children.length > 200) {
            logDiv.removeChild(logDiv.firstChild);
        }
    }

    function pad2(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    // ============================================================
    // SETTINGS PERSISTENCE
    // ============================================================

    /**
     * Save current settings to localStorage.
     */
    function saveSettings() {
        try {
            var settings = {
                noiseFloorOffset: document.getElementById('noise-floor-offset').value,
                minShotDuration: document.getElementById('min-shot-duration').value,
                preroll: document.getElementById('preroll').value,
                wideShotTrack: document.getElementById('wide-shot-track').value,
                protectSequence: document.getElementById('protect-sequence').checked,
                monologueThreshold: document.getElementById('monologue-threshold').value,
                overlapRmsDiff: document.getElementById('overlap-rms-diff').value,
                speechStartMs: document.getElementById('speech-start-ms').value,
                speechEndMs: document.getElementById('speech-end-ms').value,
                memoryStrictness: document.getElementById('memory-strictness').value,
                spikeThreshold: document.getElementById('spike-threshold').value,
                minSilenceGap: document.getElementById('min-silence-gap').value
            };
            localStorage.setItem('autocam_settings', JSON.stringify(settings));
        } catch (e) {
            // Silent fail
        }
    }

    /**
     * Load saved settings from localStorage.
     */
    function loadSettings() {
        try {
            var raw = localStorage.getItem('autocam_settings');
            if (!raw) return;
            var s = JSON.parse(raw);

            if (s.noiseFloorOffset) {
                document.getElementById('noise-floor-offset').value = s.noiseFloorOffset;
                updateSettingDisplay('noise-floor-offset', s.noiseFloorOffset + ' dB');
            }
            if (s.minShotDuration) {
                document.getElementById('min-shot-duration').value = s.minShotDuration;
                updateSettingDisplay('min-shot-duration', s.minShotDuration + 's');
            }
            if (s.preroll) {
                document.getElementById('preroll').value = s.preroll;
                updateSettingDisplay('preroll', s.preroll + ' frames');
            }
            if (typeof s.protectSequence === 'boolean') {
                document.getElementById('protect-sequence').checked = s.protectSequence;
            }
            if (s.monologueThreshold) {
                document.getElementById('monologue-threshold').value = s.monologueThreshold;
                updateSettingDisplay('monologue-threshold', s.monologueThreshold + 's');
            }
            if (s.overlapRmsDiff) {
                document.getElementById('overlap-rms-diff').value = s.overlapRmsDiff;
                updateSettingDisplay('overlap-rms-diff', s.overlapRmsDiff + '%');
            }
            if (s.speechStartMs) {
                document.getElementById('speech-start-ms').value = s.speechStartMs;
                updateSettingDisplay('speech-start-ms', s.speechStartMs + 'ms');
            }
            if (s.speechEndMs) {
                document.getElementById('speech-end-ms').value = s.speechEndMs;
                updateSettingDisplay('speech-end-ms', s.speechEndMs + 'ms');
            }
            if (s.memoryStrictness) {
                document.getElementById('memory-strictness').value = s.memoryStrictness;
                updateSettingDisplay('memory-strictness', (parseFloat(s.memoryStrictness) * 100).toFixed(0) + '%');
            }
            if (s.spikeThreshold) {
                document.getElementById('spike-threshold').value = s.spikeThreshold;
                updateSettingDisplay('spike-threshold', s.spikeThreshold + ' dB');
            }
            if (s.minSilenceGap) {
                document.getElementById('min-silence-gap').value = s.minSilenceGap;
                updateSettingDisplay('min-silence-gap', s.minSilenceGap + 's');
            }
        } catch (e) {
            // Silent fail
        }
    }

    // Save settings when any input changes
    document.addEventListener('input', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
            saveSettings();
        }
    });

    document.addEventListener('change', function (e) {
        if (e.target.type === 'checkbox') {
            saveSettings();
        }
    });

    // ============================================================
    // BOOT
    // ============================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
