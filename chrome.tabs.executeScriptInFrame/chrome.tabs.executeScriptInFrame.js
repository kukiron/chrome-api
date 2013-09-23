/**
 * (c) 2013 Rob Wu <gwnRob@gmail.com>
 * Released under the MIT license
 * https://github.com/Rob--W/chrome-api/chrome.tabs.executeScriptInFrame
 *
 * Implements the chrome.tabs.executeScriptInFrame API.
 * This API exposes the chrome.tabs.executeScript method, extended with property frameId.
 * This frameId can be obtained through the webNavigation or webRequest API.
 *
 * When an error occurs, chrome.runtime.lastError is set.
 *
 * Required permissions:
 * webRequest
 * webRequestBlocking
 * https://robwu.nl/204*
 * Host permissions for the tab
 */

/* jshint browser:true, maxlen:100 */
/* globals chrome, console */
(function() {
'use strict';
chrome.tabs.executeScriptInFrame = executeScript;

// This URL is used to communicate the frameId. The resource is never visited, so it should
// be a non-existent location. Namespaced to extensionID to prevent conflicts.
var URL_WHAT_IS_MY_FRAME_ID = 'https://robwu.nl/204?' + chrome.runtime.id + '/frameId';
// The callback will be called within ... ms:
// Don't set a too low value.
var MAXIMUM_RESPONSE_TIME_MS = 1000;

// Callbacks are stored here until they're invoked.
// Key = dummyUrl, value = callback function
var callbacks = {};

chrome.webRequest.onBeforeRequest.addListener(function showFrameId(details) {
    // Positive integer frameId >= 0
    // Since an image is used as a data transport, we add 1 to get a non-zero height.
    var frameId = details.frameId + 1; 
    // Assume that the frameId fits in two bytes - which is a very reasonable assumption.
    var width = String.fromCharCode(frameId & 0xFF, frameId & 0xFF00);
    var height = '\x01\x00';
    // Convert data to base64 to avoid loss of bytes
    var image = 'data:image/gif;base64,' + btoa(
                // 4749 4638 3961 (GIF header)
                'GIF89a' +
                // Logical Screen Width (LSB)
                width +
                // Logical Screen Height (LSB)
                height +
                // "No Global Color Table follows"
                '\x00' +
                // Background color
                '\xff' +
                // No aspect information is given
                '\x00' +
                // (image descriptor)
                // Image Separator
                '\x2c' +
                // Image Position (Left & Top)
                '\x00\x00\x00\x00' +
                // Image Width (LSB)
                width +
                // Image Height (LSB)
                height +
                // Local Color Table is not present
                '\x00' +
                // (End of image descriptor)
                // Image data
                '\x02\x02\x44\x01\x00' +
                // GIF trailer
                '\x3b'
                );
        return {redirectUrl: image};
}, {
    urls: [URL_WHAT_IS_MY_FRAME_ID + '*'],
    types: ['image']
}, ['blocking']);

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message && message.executeScriptCallback) {
        var callback = callbacks[message.dummyUrl];
        if (callback) {
            if (message.hello) {
                clearTimeout(callback.timer);
                return;
            }
            delete callbacks[message.dummyUrl];
            // Result within an array to be consistent with the chrome.tabs.executeScript API.
            callback([message.evalResult]);
        } else {
            console.warn('Callback not found for response in tab ' + sender.tab.id);
        }
    }
});

/**
 * Execute content script in a specific frame.
 *
 * @param tabId {integer} required
 * @param details.frameId {integer} required
 * @param details.code {string} Code or file is required (not both)
 * @param details.file {string} Code or file is required (not both)
 * @param details.runAt {optional string} One of "document_start", "document_end", "document_idle"
 * @param callback {optional function(optional array of any result)} When an error occurs, result
 *                                                                   is not set.
 */
function executeScript(tabId, details, callback) {
    console.assert(typeof details === 'object', 'details must be an object (argument 0)');
    var frameId = details.frameId;
    console.assert(typeof tabId === 'number', 'details.tabId must be a number');
    console.assert(typeof frameId === 'number', 'details.frameId must be a number');
    var sourceType = 'code' in details ? 'code' : 'file';
    console.assert(sourceType in details, 'No source code or file specified');
    var sourceValue = details[sourceType];
    console.assert(typeof sourceValue === 'string', 'details.' + sourceType + ' must be a string');
    var runAt = details.runAt;
    if (!callback) callback = function() {/* no-op*/};
    console.assert(typeof callback === 'function', 'callback must be a function');

    if (frameId === 0) {
        // No need for heavy lifting if we want to inject the script in the main frame
        var injectDetails = {
            allFrames: false,
            runAt: runAt
        };
        injectDetails[sourceType] = sourceValue;
        chrome.tabs.executeScript(tabId, injectDetails, callback);
        return;
    }

    // URL to uniquely identify a executeScript call
    var dummyUrl = URL_WHAT_IS_MY_FRAME_ID + Math.random();

    if (sourceType === 'code') {
        executeScriptInFrame();
    } else { // sourceType === 'file'
        (function() {
            var x = new XMLHttpRequest();
            x.open('GET', chrome.extension.getURL(sourceValue), true);
            x.onload = function() {
                sourceValue = x.responseText;
                executeScriptInFrame();
            };
            x.onerror = function executeScriptResourceFetchError() {
                var message = 'Failed to load file: "' + sourceValue + '".';
                console.error('executeScript: ' + message);
                chrome.runtime.lastError = chrome.extension.lastError = { message: message };
                try {
                    callback();
                } finally {
                    chrome.runtime.lastError = chrome.extension.lastError = undefined;
                }
            };
            x.send();
        })();
    }


    function executeScriptInFrame() {
        callbacks[dummyUrl] = callback;
        chrome.tabs.executeScript(tabId, {
            code: '(' + DETECT_FRAME + ')(' +
                  'window,' +
                  JSON.stringify(dummyUrl) + ',' +
                  frameId + ',' +
                  JSON.stringify(sourceValue) + ')',
            allFrames: true,
            runAt: 'document_start'
        }, function(results) {
            if (results) {
                callback.timer = setTimeout(executeScriptTimedOut, MAXIMUM_RESPONSE_TIME_MS);
            } else {
                // Failed :(
                delete callbacks[dummyUrl];
                callback();
            }
        });
    }
    function executeScriptTimedOut() {
        var callback = callbacks[dummyUrl];
        if (!callback) {
            return;
        }
        delete callbacks[dummyUrl];
        var message = 'Failed to execute script: Frame ' + frameId + ' not found in tab ' + tabId;
        console.error('executeScript: ' + message);
        chrome.runtime.lastError = chrome.extension.lastError = { message: message };
        try {
            callback();
        } finally {
            chrome.runtime.lastError = chrome.extension.lastError = undefined;
        }
    }
}

/**
 * Code executed as a content script.
 */
var DETECT_FRAME = '' + function checkFrame(window, dummyUrl, frameId, code) {
    var i;
    if ('__executeScript_frameId__' in window) {
        evalAsContentScript();
    } else {
        // Do NOT use new Image(), because of http://crbug.com/245296 in Chrome 27-29
        i = window.document.createElement('img');
        i.onload = function() {
            window.__executeScript_frameId__ = this.naturalWidth - 1;
            evalAsContentScript();
        };
        i.src = dummyUrl + Math.random(); // Trigger webRequest event
    }

    for (i = 0 ; i < window.frames.length; ++i) {
        try {
            var frame = window.frames[i];
            var scheme = frame.location.protocol;
            if (scheme !== 'https:' && scheme !== 'http:' && scheme !== 'file:') {
                checkFrame(frame, dummyUrl, frameId, code);
            }
        } catch (e) {
            // blocked by same origin policy, so it's not a javascript: / about:blank
            // URL. chrome.tabs.executeScript will run the script for the frame.
        }
    }
    function evalAsContentScript() {
        if (window.__executeScript_frameId__ !== frameId) {
            return;
        }
        // Send an early message to make sure that any blocking code
        // in the evaluated code does not cause the time-out in the background page
        // to be triggered
        chrome.runtime.sendMessage({
            executeScriptCallback: true,
            hello: true,
            dummyUrl: dummyUrl
        });
        var result = null;
        try {
            // jshint evil:true
            result = window.eval(code);
        } finally {
            chrome.runtime.sendMessage({
                executeScriptCallback: true,
                evalResult: result,
                dummyUrl: dummyUrl
            });
        }
    }
};

})();
