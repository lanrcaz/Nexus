/**
 * Auto Multi-Cam Edit - ExtendScript Entry Point
 * Loads sub-modules and provides the $._autocam_ namespace.
 *
 * IMPORTANT: Do NOT auto-load modules here. $.fileName is unreliable
 * when loaded via csInterface.evalScript('$.evalFile(...)').
 * Instead, main.js calls $._autocam_.loadModules(extensionRoot) explicitly.
 */

// Create namespace
$._autocam_ = {};

// Extension root path - set by loadModules()
$._autocam_.extensionRoot = '';

// Track whether modules are loaded
$._autocam_.modulesLoaded = false;

/**
 * Load all sub-modules. Called from main.js with the correct extension path.
 * This avoids relying on $.fileName which is unreliable in CEP evalScript context.
 *
 * @param {string} extensionRoot - The extension root folder path (forward slashes)
 * @returns {string} JSON status
 */
$._autocam_.loadModules = function (extensionRoot) {
    $._autocam_.extensionRoot = extensionRoot;

    // Load JSON2 for JSON support (ExtendScript has no native JSON)
    var jsonPath = extensionRoot + '/client/lib/json2.js';
    try {
        $.evalFile(jsonPath);
        if (typeof JSON === 'undefined') {
            return '{"error": "JSON object not defined after loading json2.js from: ' + jsonPath + '"}';
        }
    } catch (e) {
        return '{"error": "Could not load json2.js from: ' + jsonPath + ' - ' + e.message + '"}';
    }

    // Load sub-modules
    var hostDir = extensionRoot + '/host';
    var errors = [];

    try {
        $.evalFile(hostDir + '/sequence-reader.jsx');
    } catch (e) {
        errors.push('sequence-reader.jsx: ' + e.message);
    }

    try {
        $.evalFile(hostDir + '/multicam-editor.jsx');
    } catch (e) {
        errors.push('multicam-editor.jsx: ' + e.message);
    }

    $._autocam_.modulesLoaded = true;

    if (errors.length > 0) {
        return JSON.stringify({ status: 'partial', errors: errors });
    }

    return JSON.stringify({ status: 'ok', message: 'All modules loaded successfully.' });
};

/**
 * Simple test function to verify the extension is loaded and modules work.
 * Called from CEP panel to check connectivity.
 */
$._autocam_.ping = function () {
    var hasJSON = (typeof JSON !== 'undefined');
    var hasGetSeqInfo = (typeof $._autocam_.getSequenceInfo === 'function');
    var hasApplyCuts = (typeof $._autocam_.applyCutDecisions === 'function');

    if (hasJSON) {
        return JSON.stringify({
            status: 'ok',
            modulesLoaded: $._autocam_.modulesLoaded,
            hasSequenceReader: hasGetSeqInfo,
            hasMulticamEditor: hasApplyCuts
        });
    }
    // If JSON isn't loaded, return a manual string
    return '{"status":"ok","modulesLoaded":' + $._autocam_.modulesLoaded + ',"hasSequenceReader":' + hasGetSeqInfo + ',"hasMulticamEditor":' + hasApplyCuts + '}';
};
