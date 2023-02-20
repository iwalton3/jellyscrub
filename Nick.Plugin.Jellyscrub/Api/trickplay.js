let basePath = document.currentScript?.getAttribute('src')?.replace('Trickplay/ClientScript', '') ?? '/';

const JELLYSCRUB_GUID = 'aa2da09c-b2cf-4897-a746-e3bc885c8868';
const MANIFEST_ENDPOINT = basePath + 'Trickplay/{itemId}/GetManifest';
const TILE_ENDPOINT = basePath + 'Trickplay/{itemId}/{width}/{tileId}.jpg';
const RETRY_INTERVAL = 60_000;  // ms (1 minute)

let mediaSourceId = null;
let mediaRuntimeTicks = null;   // NOT ms -- Microsoft DateTime.Ticks. Must be divided by 10,000.

const EMBY_AUTH_HEADER = 'X-Emby-Authorization';
let embyAuthValue = '';

let hasFailed = false;
let trickplayManifest = null;
let trickplayData = null;
let currentTrickplayFrame = null;

let hiddenSliderBubble = null;
let customSliderBubble = null;
let customThumbImgWrapper = null;
let customThumbImg = null;
let customChapterText = null;

let osdPositionSlider = null;
let osdOriginalBubbleHtml = null;
let osdGetBubbleHtml = null;
let osdGetBubbleHtmlLock = false;

/*
 * Utility methods
 */

const LOG_PREFIX  = '[jellyscrub] ';

function debug(msg) {
    console.debug(LOG_PREFIX + msg);
}

function error(msg) {
    console.error(LOG_PREFIX + msg);
}

function info(msg) {
    console.info(LOG_PREFIX + msg);
}

/*
 * Get config values
 */

// -- ApiClient hasn't loaded by this point... :(
// -- Also needs to go in async function
//const jellyscrubConfig = await ApiClient.getPluginConfiguration(JELLYSCRUB_GUID);
//let STYLE_TRICKPLAY_CONTAINER = jellyscrubConfig.StyleTrickplayContainer ?? true;
let STYLE_TRICKPLAY_CONTAINER = true;

/*
 * Inject style to be used for slider bubble popup
 */

if (STYLE_TRICKPLAY_CONTAINER) {
    let jellyscrubStyle = document.createElement('style');
    jellyscrubStyle.id = 'jellscrubStyle';
    jellyscrubStyle.textContent += '.chapterThumbContainer { overflow: hidden; }';
    jellyscrubStyle.textContent += '.chapterThumbWrapper { overflow: hidden; position: relative; }';
    jellyscrubStyle.textContent += '.chapterThumb { position: absolute; width: unset; min-width: unset; height: unset; min-height: unset; }';
    jellyscrubStyle.textContent += '.chapterThumbTextContainer {position: relative; background: rgb(38, 38, 38); text-align: center;}';
    jellyscrubStyle.textContent += '.chapterThumbText {margin: 0; opacity: unset; padding: unset;}';
    document.body.appendChild(jellyscrubStyle);
}

/*
 * Monitor current page to be used for trickplay load/unload
 */

let videoPath = 'playback/video/index.html';
let previousRoutePath = null;

document.addEventListener('viewshow', function () {
    let currentRoutePath = Emby.Page.currentRouteInfo.route.path;

    if (currentRoutePath == videoPath) {
        loadVideoView();
    } else if (previousRoutePath == videoPath) {
        unloadVideoView();
    }

    previousRoutePath = currentRoutePath;
});

let sliderConfig = { attributeFilter: ['style', 'class'] };
let sliderObserver = new MutationObserver(sliderCallback);

function sliderCallback(mutationList, observer) {
    if (!customSliderBubble || !trickplayData) return;

    for (const mutation of mutationList) {
        switch (mutation.attributeName) {
            case 'style':
                customSliderBubble.setAttribute('style', mutation.target.getAttribute('style'));
                break;
            case 'class':
                if (mutation.target.classList.contains('hide')) {
                    customSliderBubble.classList.add('hide');
                } else {
                    customSliderBubble.classList.remove('hide');
                }
                break;
        }
    }
}

function loadVideoView() {
    debug('!!!!!!! Loading video view !!!!!!!');

    let slider = document.getElementsByClassName('osdPositionSlider')[0];
    if (slider) {
        osdPositionSlider = slider;
        debug(`Found OSD slider: ${osdPositionSlider}`);

        osdOriginalBubbleHtml = osdPositionSlider.getBubbleHtml;
        osdGetBubbleHtml = osdOriginalBubbleHtml;

        Object.defineProperty(osdPositionSlider, 'getBubbleHtml', {
            get() { return osdGetBubbleHtml },
            set(value) { if (!osdGetBubbleHtmlLock) osdGetBubbleHtml = value; },
            configurable: true,
            enumerable: true
        });

        let bubble = document.getElementsByClassName('sliderBubble')[0];
        if (bubble) {
            hiddenSliderBubble = bubble;

            let customBubble = document.createElement('div');
            customBubble.classList.add('sliderBubble', 'hide');

            let customThumbContainer = document.createElement('div');
            customThumbContainer.classList.add('chapterThumbContainer');

            customThumbImgWrapper = document.createElement('div');
            customThumbImgWrapper.classList.add('chapterThumbWrapper');
            customThumbContainer.appendChild(customThumbImgWrapper);

            customThumbImg = document.createElement('img');
            // Fix for custom styles that set radius on EVERYTHING causing weird holes when both img and text container are rounded
            if (STYLE_TRICKPLAY_CONTAINER) customThumbImg.setAttribute('style', 'border-radius: unset !important;')
            customThumbImg.classList.add('chapterThumb');
            customThumbImgWrapper.appendChild(customThumbImg);

            let customChapterTextContainer = document.createElement('div');
            customChapterTextContainer.classList.add('chapterThumbTextContainer');
            // Fix for custom styles that set radius on EVERYTHING causing weird holes when both img and text container are rounded
            if (STYLE_TRICKPLAY_CONTAINER) customChapterTextContainer.setAttribute('style', 'border-radius: unset !important;')

            customChapterText = document.createElement('h2');
            customChapterText.classList.add('chapterThumbText');
            customChapterText.textContent = '--:--';
            customChapterTextContainer.appendChild(customChapterText);

            customThumbContainer.appendChild(customChapterTextContainer);
            customBubble.appendChild(customThumbContainer);
            customSliderBubble = hiddenSliderBubble.parentElement.appendChild(customBubble);

            sliderObserver.observe(hiddenSliderBubble, sliderConfig);
        }

        // Main execution will first by triggered by the load video view method, but later (e.g. in the case of TV series)
        // will be triggered by the playback request interception
        if (!hasFailed && !trickplayData && mediaSourceId && mediaRuntimeTicks && embyAuthValue
            && osdPositionSlider && hiddenSliderBubble && customSliderBubble) mainScriptExecution();
    }
}

function clearTrickplayData() {
    if (trickplayData && trickplayData.blobUrls && trickplayData.blobUrls.length > 0) {
        trickplayData.blobUrls.forEach(url => URL.revokeObjectURL(url));
    }
    trickplayData = null;
}

function unloadVideoView() {
    debug('!!!!!!! Unloading video view !!!!!!!');

    // Clear old values
    clearTimeout(mainScriptExecution);

    mediaSourceId = null;
    mediaRuntimeTicks = null;

    embyAuthValue = '';

    hasFailed = false;
    trickplayManifest = null;
    clearTrickplayData();
    currentTrickplayFrame = null;

    hiddenSliderBubble = null;
    customSliderBubble = null;
    customThumbImg = null;
    customChapterText = null;

    osdPositionSlider = null;
    osdOriginalBubbleHtml = null;
    osdGetBubbleHtml = null;
    osdGetBubbleHtmlLock = false;
    // Clear old values
}

/*
 * Update mediaSourceId, runtime, and emby auth data
 */

// Override fetch method used by jellyfin-web internal API calls
const { fetch: originalFetch } = window;

window.fetch = async (...args) => {
    let [resource, config] = args;

    let url = new URL(resource);
    let urlParts = url.pathname.split('/');
    let isPlaybackInfo = urlParts.pop() == 'PlaybackInfo';

    const response = await originalFetch(resource, config);

    if (isPlaybackInfo) {
        mediaSourceId = new URLSearchParams(url.search).get('MediaSourceId');
        mediaSourceId = mediaSourceId ?? urlParts.pop();

        debug(`Found media source ID: ${mediaSourceId}`);

        let auth = config.headers['X-Emby-Authorization'];
        embyAuthValue = auth ?? '';
        debug(`Using Emby auth value: ${embyAuthValue}`);

        response.clone().json().then((data) => {
            for (const source of data.MediaSources) {
                if (source.Id == mediaSourceId) {
                    mediaRuntimeTicks = source.RunTimeTicks;
                    debug(`Found media runtime of ${mediaRuntimeTicks} ticks`);

                    debug(`Attempting to change trickplay data to source ${mediaSourceId}`);
                    changeCurrentMedia();

                    break;
                } else {
                    debug(`Runtime -- found media source ID ${source.Id} but main source is ${mediaSourceId}`);
                }
            }
        });
    }

    return response;
};

function changeCurrentMedia() {
    // Reset trickplay-related variables
    hasFailed = false;
    trickplayManifest = null;
    clearTrickplayData();
    currentTrickplayFrame = null;

    // Set bubble html back to default
    if (osdOriginalBubbleHtml) osdGetBubbleHtml = osdOriginalBubbleHtml;
    osdGetBubbleHtmlLock = false;

    // Main execution will first by triggered by the load video view method, but later (e.g. in the case of TV series)
    // will be triggered by the playback request interception
    if (!hasFailed && !trickplayData && mediaSourceId && mediaRuntimeTicks && embyAuthValue
        && osdPositionSlider && hiddenSliderBubble && customSliderBubble) mainScriptExecution();
}

/*
 * Main script execution -- not actually run first
 */

function manifestLoad() {
    if (this.status == 200) {
        if (!this.response) {
            error(`Received 200 status from manifest endpoint but a null response. (RESPONSE URL: ${this.responseURL})`);
            hasFailed = true;
            return;
        }

        trickplayManifest = this.response;
        setTimeout(mainScriptExecution, 0); // Hacky way of avoiding using fetch/await by returning then calling function again
    } else if (this.status == 503) {
        info(`Received 503 from server -- still generating manifest. Waiting ${RETRY_INTERVAL}ms then retrying...`);
        setTimeout(mainScriptExecution, RETRY_INTERVAL);
    } else {
        debug(`Failed to get manifest file: url ${this.responseURL}, error ${this.status}, ${this.responseText}`)
        hasFailed = true;
    }
}

function loadTiles(blobUrls, config) {
    trickplayData = {
        BlobUrls: blobUrls,
        ...config
    };

    mainScriptExecution();
}

function mainScriptExecution() {
    // Get trickplay manifest file
    if (!trickplayManifest) {
        let manifestUrl = MANIFEST_ENDPOINT.replace('{itemId}', mediaSourceId);
        let manifestRequest = new XMLHttpRequest();
        manifestRequest.responseType = 'json';
        manifestRequest.addEventListener('load', manifestLoad);

        manifestRequest.open('GET', manifestUrl);
        manifestRequest.setRequestHeader(EMBY_AUTH_HEADER, embyAuthValue);

        debug(`Requesting Manifest @ ${manifestUrl}`);
        manifestRequest.send();
        return;
    }

    // Get trickplay BIF file
    if (!trickplayData && trickplayManifest) {
        // Determine which width to use
        // Prefer highest resolution @ less than 20% of total screen resolution width
        let resolutions = trickplayManifest.WidthResolutions;
        if (resolutions) resolutions = Object.values(resolutions);

        if (resolutions.length > 0)
        {
            resolutions.sort((a, b) => a.Width - b.Width);
            let screenWidth = window.screen.width * window.devicePixelRatio;
            let config = resolutions[0];

            // Prefer bigger trickplay images granted they are less than or equal to 20% of total screen width
            for (let i = 1; i < resolutions.length; i++)
            {
                let biggerConfig = resolutions[i];
                if (biggerConfig.Width <= (screenWidth * .2)) config = biggerConfig;
            }
            info(`Requesting tiles with width ${config.Width}`);

            let baseTileUrl = TILE_ENDPOINT.replace('{itemId}', mediaSourceId).replace('{width}', config.Width);
            let tileCount = Math.ceil(config.TileCount / config.TileWidth / config.TileHeight);
            const urls = [];
            for (let i = 1; i <= tileCount; i++) {
                urls.push(baseTileUrl.replace('{tileId}', i));
            }

            Promise.all(urls.map(url => originalFetch(url, {headers: {[EMBY_AUTH_HEADER]: embyAuthValue}})))
            .then(responses => Promise.all(responses.map(res => res.blob())))
            .then(blobs => loadTiles(blobs.map(blob => URL.createObjectURL(blob)), config))
            .catch(error => { hasFailed = true; error(`Failed to load tiles: ${error}`); });

            return;
        } else {
            error(`Have manifest file with no listed resolutions: ${trickplayManifest}`);
        }
    }

    // Set the bubble function to our custom trickplay one
    if (trickplayData) {
        osdPositionSlider.getBubbleHtml = getBubbleHtmlTrickplay;
        osdGetBubbleHtmlLock = true;
    }
}

function getBubbleHtmlTrickplay(sliderValue) {
    //showOsd();

    const currentTicks = mediaRuntimeTicks * (sliderValue / 100);
    const currentTimeMs = currentTicks / 10_000
    const currentTile = Math.floor(currentTimeMs / trickplayData.Interval);
    const tileSize = trickplayData.TileWidth * trickplayData.TileHeight;
    const tileOffset = currentTile % tileSize;
    const currentTileSet = Math.floor(currentTile / tileSize);
    const tileOffsetX = tileOffset % trickplayData.TileWidth;
    const tileOffsetY = Math.floor(tileOffset / trickplayData.TileWidth);
    const imageSrc = trickplayData.BlobUrls[currentTileSet];

    customThumbImg.src = imageSrc;
    customThumbImgWrapper.style.height = `${trickplayData.Height}px`;
    customThumbImgWrapper.style.width = `${trickplayData.Width}px`;
    customThumbImg.style.left = `-${tileOffsetX * trickplayData.Width}px`;
    customThumbImg.style.top = `-${tileOffsetY * trickplayData.Height}px`;
    customChapterText.textContent = getDisplayRunningTime(currentTicks);


    return `<div style="min-width: ${customSliderBubble.offsetWidth}px; max-height: 0px"></div>`;
}

// Not the same, but should be functionally equaivalent to --
// https://github.com/jellyfin/jellyfin-web/blob/8ff9d63e25b40575e02fe638491259c480c89ba5/src/controllers/playback/video/index.js#L237
/*
function showOsd() {
    //document.getElementsByClassName('skinHeader')[0]?.classList.remove('osdHeader-hidden');
    // todo: actually can't be bothered so I'll wait and see if it works without it or not
}
*/

// Taken from https://github.com/jellyfin/jellyfin-web/blob/8ff9d63e25b40575e02fe638491259c480c89ba5/src/scripts/datetime.js#L76
function getDisplayRunningTime(ticks) {
    const ticksPerHour = 36000000000;
    const ticksPerMinute = 600000000;
    const ticksPerSecond = 10000000;

    const parts = [];

    let hours = ticks / ticksPerHour;
    hours = Math.floor(hours);

    if (hours) {
        parts.push(hours);
    }

    ticks -= (hours * ticksPerHour);

    let minutes = ticks / ticksPerMinute;
    minutes = Math.floor(minutes);

    ticks -= (minutes * ticksPerMinute);

    if (minutes < 10 && hours) {
        minutes = '0' + minutes;
    }
    parts.push(minutes);

    let seconds = ticks / ticksPerSecond;
    seconds = Math.floor(seconds);

    if (seconds < 10) {
        seconds = '0' + seconds;
    }
    parts.push(seconds);

    return parts.join(':');
}
