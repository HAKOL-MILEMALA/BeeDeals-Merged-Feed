// ==UserScript==
// @name         Bee.Deals - פיד מאוחד
// @namespace    https://github.com/HAKOL-MILEMALA
// @version      1.3.2
// @description  מאחד את חמשת מדורי Bee.Deals וממיין לפי תאריך הפרסום המקורי, תוך שמירה על תצוגת האתר.
// @author       HAKOL-MILEMALA
// @match        https://bee.deals/dashboard*
// @match        https://www.bee.deals/dashboard*
// @match        https://il.bee.deals/dashboard*
// @run-at       document-idle
// @noframes
// @grant        none
// @homepageURL  https://github.com/HAKOL-MILEMALA/BeeDeals-Merged-Feed
// @supportURL   https://github.com/HAKOL-MILEMALA/BeeDeals-Merged-Feed/issues
// @updateURL    https://raw.githubusercontent.com/HAKOL-MILEMALA/BeeDeals-Merged-Feed/main/BeeDeals-Merged-Feed.user.js
// @downloadURL  https://raw.githubusercontent.com/HAKOL-MILEMALA/BeeDeals-Merged-Feed/main/BeeDeals-Merged-Feed.user.js
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '1.3.2';
    const MERGED_HASH = 'bee-all';
    const MERGED_HREF = '/dashboard#' + MERGED_HASH;
    const NAV_SELECTOR = '.horizontal-navigation[aria-label="תצוגות הפיד"] ul.scroll';
    const NAV_PATHS = [
        '/dashboard',
        '/dashboard/hotDeals',
        '/dashboard/usersAsk',
        '/dashboard/news',
        '/dashboard/newDeals'
    ];
    const FEED_SELECTOR = '#nfItemsHolder .nfDealItemsPin:not(.adItem)';
    const LOAD_MORE_SELECTOR = '#nfItemsHolder .bee-load-more-btn';

    // סדר המקורות משמש רק לשובר שוויון ולבחירת עותק במקרה של כפילות.
    // הסדר הסופי נקבע לפי targetData.date בלבד.
    const SOURCE_ORDER = ['hot', 'updated', 'new', 'news', 'hive'];

    const SOURCES = {
        updated: { key: 'updated', label: 'הדילים המעודכנים', flags: {} },
        hot: { key: 'hot', label: 'הדילים החמים', flags: { hotDeals: 1 } },
        hive: { key: 'hive', label: 'מוח כוורת', flags: { usersAsk: 1 } },
        news: { key: 'news', label: 'עדכונים מהרשת', flags: { news: 1 } },
        new: { key: 'new', label: 'חדש בכוורת', flags: { newDeals: 1 } }
    };

    const log = (...args) => console.info('[Bee.Deals מאוחד]', ...args);
    const warn = (...args) => console.warn('[Bee.Deals מאוחד]', ...args);
    const error = (...args) => console.error('[Bee.Deals מאוחד]', ...args);

    let injector = null;
    let $rootScope = null;
    let $state = null;
    let $location = null;
    let $timeout = null;
    let dealService = null;

    let mergedActive = false;
    let initialLoading = false;
    let loadingMore = false;
    let controllerScope = null;
    let sourceStates = [];
    let firstAdPosition = null;
    let navActiveObserver = null;
    let navObserver = null;
    let navEnsureScheduled = false;
    let lastMergeRecords = [];
    let nativeFeedSnapshot = null;

    const sourceStateByKey = new Map();

    function isMergedUrl() {
        return normalizedPath(location.pathname) === '/dashboard' &&
            location.hash.replace(/^#/, '') === MERGED_HASH;
    }

    function normalizedPath(pathname) {
        return (pathname || '/').replace(/\/+$/, '') || '/';
    }

    // התיקון המרכזי ב-1.3.2:
    // הפונקציה נקראה על ידי מנגנון שחזור הניווט, אך לא הוגדרה בגרסה 1.3.1.
    // לכן ה-MutationObserver והבדיקה המחזורית זרקו ReferenceError שוב ושוב.
    function isDashboardRoute() {
        return /^\/dashboard(?:\/|$)/.test(normalizedPath(location.pathname));
    }

    function pathFromAnchor(anchor) {
        try {
            return normalizedPath(new URL(anchor.href, location.origin).pathname);
        } catch (_) {
            return '';
        }
    }

    function findFeedNavigationList() {
        const candidates = [];
        const selectors = [
            NAV_SELECTOR,
            '.horizontal-navigation ul.scroll',
            '.horizontal-navigation ul',
            'nav ul.scroll'
        ];

        for (const selector of selectors) {
            for (const list of document.querySelectorAll(selector)) {
                if (candidates.includes(list)) continue;
                const paths = new Set([...list.querySelectorAll('a[href]')].map(pathFromAnchor));
                const matches = NAV_PATHS.filter(path => paths.has(normalizedPath(path))).length;
                if (paths.has('/dashboard') && matches >= 3) candidates.push(list);
            }
        }

        candidates.sort((a, b) => {
            const score = list => {
                const paths = new Set([...list.querySelectorAll('a[href]')].map(pathFromAnchor));
                const matches = NAV_PATHS.filter(path => paths.has(normalizedPath(path))).length;
                const preferred = list.matches(NAV_SELECTOR) ? 100 : 0;
                return preferred + matches * 10 - Math.min(20, list.querySelectorAll('a[href]').length);
            };
            return score(b) - score(a);
        });

        return candidates[0] || null;
    }

    function safeApply(callback) {
        if (!$rootScope) return callback();
        if ($rootScope.$$phase) callback();
        else $rootScope.$apply(callback);
    }

    function waitUntil(test, timeoutMs, description) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const check = () => {
                let result = false;
                try {
                    result = test();
                } catch (_) {}

                if (result) {
                    resolve(result);
                    return;
                }
                if (Date.now() - started >= timeoutMs) {
                    reject(new Error('פג הזמן בהמתנה ל' + description));
                    return;
                }
                setTimeout(check, 200);
            };
            check();
        });
    }

    function getInjector() {
        if (injector) return injector;

        const angular = window.angular;
        if (!angular || !angular.element) return null;

        const appElement = document.querySelector('[ng-app="beeApp"]') ||
            document.querySelector('[ng-app]') || document.documentElement;

        try {
            injector = angular.element(appElement).injector() ||
                angular.element(document.body).injector() || null;
        } catch (e) {
            warn('לא הצלחתי לקבל Angular injector:', e);
        }

        if (!injector) return null;

        try {
            $rootScope = injector.get('$rootScope');
            $state = injector.get('$state');
            $location = injector.get('$location');
            $timeout = injector.get('$timeout');
            dealService = injector.get('dealService');
        } catch (e) {
            injector = null;
            warn('שירותי Angular אינם זמינים עדיין:', e);
            return null;
        }

        return injector;
    }

    function findDashboardScope() {
        if (!window.angular) return null;

        const start = document.querySelector('#nfItemsHolder') ||
            document.querySelector('.nfDealItems');
        let node = start;

        while (node && node.nodeType === 1) {
            try {
                let scope = window.angular.element(node).scope();
                while (scope) {
                    if (typeof scope.addDealsNewsfeed === 'function' &&
                        typeof scope.nfDealsPage !== 'undefined') return scope;
                    scope = scope.$parent;
                }
            } catch (_) {}
            node = node.parentElement;
        }
        return null;
    }

    function waitForDashboardFeed() {
        return waitUntil(() => {
            const scope = findDashboardScope();
            if (!scope) return false;
            const initialRequestFinished = !scope.nfDealsLoading &&
                (Number(scope.nfDealsPage) > 0 || scope.eof === true || scope.nfLoadError === true);
            return initialRequestFinished ? scope : false;
        }, 45000, 'טעינת הפיד הראשוני של Bee.Deals');
    }

    function getSourceState(key) {
        if (!sourceStateByKey.has(key)) {
            sourceStateByKey.set(key, {
                ...SOURCES[key],
                items: [],
                page: 0,
                eof: false,
                failed: false
            });
        }
        return sourceStateByKey.get(key);
    }

    function getPageLimit() {
        return $rootScope && $rootScope.isMobile ? 20 : 50;
    }

    function makeRequestParams(source, page) {
        const scope = controllerScope || {};
        const requestPublisherId = window.publisherId ?? 0;

        const params = {
            limit: getPageLimit(),
            personalFeed: $rootScope ? $rootScope.personalFeed : undefined,
            page,
            publisherId: requestPublisherId,
            catsTree: scope.catsTree,
            userId: $rootScope ? $rootScope.userPageId : undefined,
            groupId: scope.groupId,
            query: scope.query,
            newDeals: 0,
            hotDeals: 0,
            news: 0,
            usersAsk: 0,
            userLoves: 0,
            userBought: 0,
            userSaved: 0
        };

        Object.assign(params, source.flags || {});
        return params;
    }

    // משתמשים בחתימת callback המקורית של האתר (בדיוק כמו dashboard_index).
    // כך אין תלות באופן שבו $resource חושף את $promise בגרסת Angular של האתר.
    function requestSourcePage(source, page) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback(value);
            };
            const timer = setTimeout(() => {
                finish(reject, new Error('השרת לא החזיר תשובה בזמן: ' + source.label + ', עמוד ' + (page + 1)));
            }, 30000);

            try {
                dealService.browseNewsfeedDeals(
                    makeRequestParams(source, page),
                    response => finish(resolve, response),
                    requestError => finish(reject, requestError || new Error('שגיאת שרת במדור ' + source.label))
                );
            } catch (e) {
                finish(reject, e);
            }
        });
    }

    function getRealItems(response) {
        const items = response && Array.isArray(response.result) ? response.result : [];
        return items.filter(item => {
            if (!item || !item.targetData || item.action_type === 'ad') return false;
            const id = item.targetData.id;
            const alphaId = item.targetData.alphaId;
            return (id !== undefined && id !== null && String(id) !== '') ||
                (alphaId !== undefined && alphaId !== null && String(alphaId) !== '');
        });
    }

    function getItemKeys(item) {
        const data = item && item.targetData;
        if (!data) return [];
        const keys = [];
        if (data.alphaId !== undefined && data.alphaId !== null && String(data.alphaId).trim()) {
            keys.push('alpha:' + String(data.alphaId).trim());
        }
        if (data.id !== undefined && data.id !== null && String(data.id).trim()) {
            keys.push('id:' + String(data.id).trim());
        }
        return keys;
    }

    // התאריך היחיד הקובע הוא targetData.date. last_edit_date אינו נקרא כלל.
    function parsePublicationDate(value) {
        if (value === undefined || value === null || value === '') return 0;

        if (value instanceof Date) {
            const timestamp = value.getTime();
            return Number.isFinite(timestamp) && timestamp >= 946684800000 && timestamp <= 4102444800000
                ? timestamp : 0;
        }

        if (typeof value === 'object') {
            value = value.$date ?? value.date ?? value.value ?? '';
            if (value === '') return 0;
        }

        if (typeof value === 'number' ||
            (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
            const number = Number(value);
            if (!Number.isFinite(number) || number <= 0) return 0;
            if (number >= 946684800000 && number <= 4102444800000) return number;
            if (number >= 946684800 && number <= 4102444800) return number * 1000;
            return 0;
        }

        const text = String(value).trim();
        let match;

        // DD/MM/YYYY או DD.MM.YYYY, עם שעה אופציונלית.
        match = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/.exec(text);
        if (match) {
            const day = Number(match[1]);
            const month = Number(match[2]);
            const year = Number(match[3]);
            const hour = Number(match[4] || 0);
            const minute = Number(match[5] || 0);
            const second = Number(match[6] || 0);
            const millisecond = Number((match[7] || '').padEnd(3, '0') || 0);
            let timestamp;

            if (match[8]) {
                const utc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
                const check = new Date(utc);
                if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
                    check.getUTCDate() !== day || check.getUTCHours() !== hour ||
                    check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return 0;

                if (match[8] === 'Z') timestamp = utc;
                else {
                    const zone = /([+-])(\d{2}):?(\d{2})/.exec(match[8]);
                    if (!zone || Number(zone[2]) > 14 || Number(zone[3]) > 59) return 0;
                    const offset = (Number(zone[2]) * 60 + Number(zone[3])) * 60000;
                    timestamp = utc + (zone[1] === '+' ? -offset : offset);
                }
            } else {
                const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
                if (date.getFullYear() !== year || date.getMonth() !== month - 1 ||
                    date.getDate() !== day || date.getHours() !== hour ||
                    date.getMinutes() !== minute || date.getSeconds() !== second) return 0;
                timestamp = date.getTime();
            }
            return timestamp >= 946684800000 && timestamp <= 4102444800000 ? timestamp : 0;
        }

        // YYYY-MM-DD HH:mm[:ss], ללא אזור זמן — זמן מקומי.
        match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(text);
        if (match) {
            const year = Number(match[1]);
            const month = Number(match[2]);
            const day = Number(match[3]);
            const hour = Number(match[4] || 0);
            const minute = Number(match[5] || 0);
            const second = Number(match[6] || 0);
            const millisecond = Number((match[7] || '').padEnd(3, '0') || 0);
            const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
            if (date.getFullYear() !== year || date.getMonth() !== month - 1 ||
                date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute ||
                date.getSeconds() !== second) return 0;
            const timestamp = date.getTime();
            return timestamp >= 946684800000 && timestamp <= 4102444800000 ? timestamp : 0;
        }

        // ISO 8601, כולל Z והיסט אזור זמן.
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) && parsed >= 946684800000 && parsed <= 4102444800000
            ? parsed : 0;
    }

    function getPublicationTimestamp(item) {
        return parsePublicationDate(item && item.targetData && item.targetData.date);
    }

    function formatTimestamp(timestamp) {
        return timestamp ? new Date(timestamp).toLocaleString('he-IL') : 'לא זוהה';
    }

    function prepareItem(item) {
        if (item && item.targetData) {
            item.targetData.imgWidth = Number(item.targetData.highlight) === 1 ? 515 : 400;
        }
        return item;
    }

    function addResponseToSource(sourceState, response) {
        const found = !!(response && response.nfItemsFound);
        // dashboard_index מוסיף ל-deals רק כאשר nfItemsFound אמת.
        const items = found ? getRealItems(response).map(prepareItem) : [];
        sourceState.items.push(...items);

        const limit = getPageLimit();
        const responseCount = Number(response && response.cnt);
        const actualCount = Number.isFinite(responseCount) ? responseCount : items.length;

        // כמו באתר: nfDealsPage מתקדם רק כאשר nfItemsFound אמת;
        // eof נקבע לפי cnt מול limit, כפי שעושה dashboard_index.
        if (found) sourceState.page += 1;
        sourceState.eof = !found || actualCount < limit;
        sourceState.failed = false;
        return items.length;
    }

    async function fetchFirstPageForSource(key) {
        const sourceState = getSourceState(key);
        try {
            const response = await requestSourcePage(sourceState, 0);
            const count = addResponseToSource(sourceState, response);
            log(sourceState.label + ': נטענו ' + count + ' פרסומים בעמוד הראשון.');
            return true;
        } catch (e) {
            sourceState.failed = true;
            sourceState.eof = false;
            warn('טעינת המדור "' + sourceState.label + '" נכשלה:', e);
            return false;
        }
    }

    const NATIVE_SCOPE_KEYS = [
        'nfDealsPage', 'eof', 'noDeals', 'nfLoadError', 'isRefreshing',
        'adsCount', 'nfDealsLoading'
    ];
    const NATIVE_ROOT_KEYS = ['deals', 'dealsLimit', 'nfAz', 'adsCount'];

    function captureNativeFeed(scope) {
        if (nativeFeedSnapshot && nativeFeedSnapshot.scope === scope) return;

        const scopeValues = {};
        for (const key of NATIVE_SCOPE_KEYS) {
            scopeValues[key] = {
                own: Object.prototype.hasOwnProperty.call(scope, key),
                value: scope[key]
            };
        }

        const rootValues = {};
        for (const key of NATIVE_ROOT_KEYS) {
            rootValues[key] = {
                own: Object.prototype.hasOwnProperty.call($rootScope, key),
                value: $rootScope[key],
                nestedLoaded: key === 'nfAz' && $rootScope.nfAz
                    ? $rootScope.nfAz.loaded : undefined
            };
        }

        nativeFeedSnapshot = { scope, scopeValues, rootValues };
        log('נשמר מצב הפיד המקורי כדי להחזיר אותו ביציאה מהלשונית המאוחדת.');
    }

    function restoreNativeFeedSnapshot() {
        const snapshot = nativeFeedSnapshot;
        if (!snapshot) return false;

        try {
            safeApply(() => {
                for (const [key, saved] of Object.entries(snapshot.rootValues)) {
                    if (saved.own) {
                        if (key === 'nfAz' && saved.value && typeof saved.value === 'object') {
                            saved.value.loaded = saved.nestedLoaded;
                        }
                        $rootScope[key] = saved.value;
                    } else {
                        delete $rootScope[key];
                    }
                }

                const scope = snapshot.scope;
                if (scope && !scope.$$destroyed) {
                    for (const [key, saved] of Object.entries(snapshot.scopeValues)) {
                        if (saved.own) scope[key] = saved.value;
                        else delete scope[key];
                    }
                }
            });
            nativeFeedSnapshot = null;
            scheduleMasonryRelayout();
            log('הפיד המקורי שוחזר.');
            return true;
        } catch (e) {
            warn('לא הצלחתי לשחזר את הפיד המקורי במלואו:', e);
            nativeFeedSnapshot = null;
            return false;
        }
    }

    function seedUpdatedSource(scope) {
        captureNativeFeed(scope);
        const sourceState = getSourceState('updated');
        const raw = Array.isArray($rootScope.deals) ? $rootScope.deals : [];

        sourceState.items = raw
            .filter(item => item && item.action_type !== 'ad' && item.targetData)
            .map(prepareItem);
        sourceState.page = Math.max(0, Number(scope.nfDealsPage) || 0);
        sourceState.eof = !!scope.eof;
        sourceState.failed = !!scope.nfLoadError;

        log('הדילים המעודכנים: השתמשתי ב-' + sourceState.items.length +
            ' פרסומים שכבר נטענו באתר; העמוד הבא הוא ' + sourceState.page + '.');
        return sourceState;
    }

    function mergeSourceItems() {
        const orderedStates = SOURCE_ORDER
            .map(key => sourceStateByKey.get(key))
            .filter(Boolean);
        const records = [];
        const recordByKey = new Map();
        let sequence = 0;
        let duplicateDateConflicts = 0;

        for (const source of orderedStates) {
            for (const item of source.items) {
                const keys = getItemKeys(item);
                if (!keys.length) continue;

                const timestamp = getPublicationTimestamp(item);
                let existing = null;
                for (const key of keys) {
                    if (recordByKey.has(key)) {
                        existing = recordByKey.get(key);
                        break;
                    }
                }

                if (existing) {
                    // אם עותק אחד חסר תאריך, משתמשים בעותק שבו targetData.date תקין.
                    if (!existing.timestamp && timestamp) {
                        existing.item = item;
                        existing.timestamp = timestamp;
                        existing.rawDate = item.targetData.date;
                        existing.source = source.key;
                    } else if (existing.timestamp && timestamp && existing.timestamp !== timestamp) {
                        // במקרה של אי-התאמה בין עותקים, נשמר התאריך המוקדם יותר.
                        duplicateDateConflicts++;
                        if (timestamp < existing.timestamp) {
                            existing.item = item;
                            existing.timestamp = timestamp;
                            existing.rawDate = item.targetData.date;
                            existing.source = source.key;
                        }
                    }
                    keys.forEach(key => recordByKey.set(key, existing));
                    continue;
                }

                const record = {
                    item,
                    timestamp,
                    rawDate: item.targetData.date,
                    source: source.key,
                    sequence: sequence++
                };
                records.push(record);
                keys.forEach(key => recordByKey.set(key, record));
            }
        }

        records.sort((a, b) => {
            if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
            return a.sequence - b.sequence;
        });

        lastMergeRecords = records;
        const dated = records.filter(record => record.timestamp > 0).length;
        const missing = records.length - dated;
        const perSource = {};
        for (const source of orderedStates) {
            const own = records.filter(record => record.source === source.key);
            perSource[source.key] = {
                items: own.length,
                withDate: own.filter(record => record.timestamp > 0).length,
                withoutDate: own.filter(record => !record.timestamp).length
            };
        }

        log('מיון כרונולוגי הושלם: ' + records.length + ' פרסומים ייחודיים; ' +
            dated + ' עם תאריך תקין; ' + missing + ' ללא תאריך.');
        log('פירוט תאריכים לפי מדור:', perSource);
        if (duplicateDateConflicts) {
            warn('נמצאו ' + duplicateDateConflicts +
                ' כפילויות עם ערכי date שונים. במקרה של סתירה נשמר התאריך המוקדם יותר.');
        }

        if (records.length) {
            console.table(records.slice(0, 15).map((record, index) => ({
                position: index + 1,
                source: record.source,
                alphaId: record.item.targetData.alphaId || '',
                id: record.item.targetData.id || '',
                dateRaw: record.rawDate,
                dateParsed: formatTimestamp(record.timestamp),
                title: String(record.item.targetData.titleIL || record.item.targetData.title || '').slice(0, 65)
            })));
        }

        const invalidExamples = records.filter(record => !record.timestamp).slice(0, 6);
        if (invalidExamples.length) {
            console.warn('[Bee.Deals מאוחד] פרסומים ללא תאריך פרסום שניתן לפענח:',
                invalidExamples.map(record => ({
                    source: record.source,
                    alphaId: record.item.targetData.alphaId || '',
                    id: record.item.targetData.id || '',
                    dateRaw: record.rawDate,
                    title: record.item.targetData.titleIL || record.item.targetData.title || ''
                })));
        }

        return records.map(record => record.item);
    }

    function buildDisplayItems(realItems) {
        const displayItems = [];
        const isMobile = !!($rootScope && $rootScope.isMobile);
        const adEveryDeals = isMobile ? 5 : 10;

        if (firstAdPosition === null && realItems.length) {
            const firstAdMax = isMobile ? 3 : 5;
            firstAdPosition = Math.floor(Math.random() * Math.min(firstAdMax, realItems.length)) + 1;
        }

        let adCount = 0;
        let nextAdPosition = firstAdPosition;
        for (let i = 0; i < realItems.length; i++) {
            if (nextAdPosition !== null && i === nextAdPosition) {
                adCount++;
                displayItems.push({
                    action_type: 'ad',
                    highlight: 0,
                    targetData: { adId: adCount, id: 'ad_' + adCount }
                });
                nextAdPosition += adEveryDeals;
            }
            displayItems.push(realItems[i]);
        }
        return { displayItems, adCount };
    }

    function scheduleMasonryRelayout() {
        const relayout = () => {
            const container = document.querySelector('#nfItemsHolder .nfDealItems');
            if (!container || !window.angular) return;

            try {
                const element = window.angular.element(container);
                const masonryController = element.controller('masonry');
                if (masonryController) {
                    masonryController.reloadItems();
                    masonryController.layout();
                    return;
                }

                const instance = element.data('masonry');
                if (instance && typeof instance.reloadItems === 'function') {
                    instance.reloadItems();
                    instance.layout();
                }
            } catch (e) {
                warn('רענון פריסת Masonry נכשל:', e);
            }
        };

        const run = () => requestAnimationFrame(() => requestAnimationFrame(relayout));
        if ($timeout) $timeout(run, 0, false);
        else run();
        setTimeout(run, 100);
        setTimeout(run, 350);
    }

    function renderMergedFeed() {
        const realItems = mergeSourceItems();
        const { displayItems, adCount } = buildDisplayItems(realItems);

        safeApply(() => {
            $rootScope.dealsLimit = displayItems.length;
            $rootScope.deals = displayItems;

            if (!$rootScope.nfAz) {
                $rootScope.nfAz = {
                    blocked: false,
                    loaded: false,
                    adOne: { x: 0, y: 0, show: false },
                    adTwo: { x: 0, y: 0, show: false }
                };
            }
            $rootScope.nfAz.loaded = adCount > 0;

            if (controllerScope) {
                controllerScope.adsCount = adCount;
                controllerScope.eof = sourceStates.length > 0 && sourceStates.every(source => source.eof);
                controllerScope.noDeals = realItems.length === 0;
                controllerScope.nfLoadError = false;
                controllerScope.isRefreshing = false;
            }
        });

        scheduleMasonryRelayout();
        log('הפיד המאוחד עודכן: ' + realItems.length + ' פרסומים ייחודיים; ' +
            sourceStates.filter(source => !source.eof).length + ' מדורים שעוד ניתן לטעון.');
        return realItems.length;
    }

    function setNavActive(active) {
        const list = findFeedNavigationList();
        if (!list) return;

        const mergedLink = list.querySelector('a[data-bee-merged-tab="1"]');
        const mergedLi = mergedLink && mergedLink.closest('li');
        if (!mergedLi) return;

        if (navActiveObserver) {
            navActiveObserver.disconnect();
            navActiveObserver = null;
        }

        const allLinks = [...list.querySelectorAll('li > a')];
        if (active) {
            mergedLi.classList.add('active');
            mergedLink.setAttribute('aria-current', 'page');
            allLinks.forEach(anchor => {
                if (anchor !== mergedLink) anchor.removeAttribute('aria-current');
            });

            navActiveObserver = new MutationObserver(() => {
                if (!mergedActive) return;
                const currentList = findFeedNavigationList();
                if (!currentList || !currentList.contains(mergedLink)) return;
                currentList.querySelectorAll('li.active').forEach(li => {
                    if (li !== mergedLi && !li.classList.contains('hn-glide')) li.classList.remove('active');
                });
            });

            list.querySelectorAll('li').forEach(li => {
                if (li !== mergedLi && !li.classList.contains('hn-glide')) li.classList.remove('active');
            });
            navActiveObserver.observe(list, {
                subtree: true,
                attributes: true,
                attributeFilter: ['class']
            });
        } else {
            mergedLi.classList.remove('active');
            mergedLink.removeAttribute('aria-current');

            const stateName = $state && $state.current ? $state.current.name : '';
            const activePath = {
                'parent.dashboard': '/dashboard',
                'parent.dashboard.hotDeals': '/dashboard/hotDeals',
                'parent.dashboard.usersAsk': '/dashboard/usersAsk',
                'parent.dashboard.news': '/dashboard/news',
                'parent.dashboard.newDeals': '/dashboard/newDeals'
            }[stateName];

            if (activePath) {
                const nativeLink = allLinks.find(anchor => anchor !== mergedLink &&
                    pathFromAnchor(anchor) === normalizedPath(activePath));
                if (nativeLink) {
                    const nativeLi = nativeLink.closest('li');
                    if (nativeLi) nativeLi.classList.add('active');
                    nativeLink.setAttribute('aria-current', 'page');
                }
            }
        }

        window.dispatchEvent(new Event('resize'));
    }

    function addMergedTab() {
        const list = findFeedNavigationList();
        if (!list) return false;

        let link = list.querySelector('a[data-bee-merged-tab="1"]');
        if (link) {
            if (link.getAttribute('href') !== MERGED_HREF) link.setAttribute('href', MERGED_HREF);
            return true;
        }

        document.querySelectorAll('a[data-bee-merged-tab="1"]').forEach(oldLink => {
            if (!list.contains(oldLink)) oldLink.closest('li')?.remove();
        });

        const baseLink = [...list.querySelectorAll('li > a')].find(anchor =>
            pathFromAnchor(anchor) === '/dashboard'
        );
        if (!baseLink) return false;

        const li = document.createElement('li');
        li.setAttribute('data-bee-merged-tab-wrapper', '1');
        li.title = 'כל המדורים';

        link = document.createElement('a');
        link.setAttribute('href', MERGED_HREF);
        link.setAttribute('data-bee-merged-tab', '1');
        link.setAttribute('aria-label', 'הכול – פיד מאוחד מכל מדורי Bee.Deals');
        if (baseLink.className) link.className = baseLink.className;

        const label = document.createElement('strong');
        label.textContent = 'הכול';
        label.style.fontWeight = '700';
        link.appendChild(label);
        li.appendChild(link);
        list.insertBefore(li, list.firstElementChild);

        log('נוספה לשונית הכול לסרגל הניווט.');
        setNavActive(isMergedUrl() || mergedActive);
        return true;
    }

    function stateForTabPath(pathname) {
        const path = normalizedPath(pathname);
        return {
            '/dashboard': 'parent.dashboard',
            '/dashboard/hotDeals': 'parent.dashboard.hotDeals',
            '/dashboard/usersAsk': 'parent.dashboard.usersAsk',
            '/dashboard/news': 'parent.dashboard.news',
            '/dashboard/newDeals': 'parent.dashboard.newDeals'
        }[path] || null;
    }

    function removeMergedMode(clearHash) {
        restoreNativeFeedSnapshot();
        mergedActive = false;
        initialLoading = false;
        loadingMore = false;
        firstAdPosition = null;

        if (navActiveObserver) {
            navActiveObserver.disconnect();
            navActiveObserver = null;
        }

        if (clearHash && $location && $location.hash() === MERGED_HASH) {
            safeApply(() => $location.hash(''));
        }

        setNavActive(false);
        scheduleNavigationEnsure();
        log('יציאה מהפיד המאוחד.');
    }

    async function leaveForNativeTab(stateName) {
        const currentName = $state.current && $state.current.name;
        const params = { username: 'dashboard' };
        const sameBaseState = stateName === 'parent.dashboard' && currentName === 'parent.dashboard';

        removeMergedMode(true);
        if (sameBaseState) {
            setNavActive(false);
            scheduleNavigationEnsure();
            log('הפיד המעודכנים המקורי שוחזר ללא טעינת state מחדש.');
            return;
        }

        try {
            await $state.transitionTo(stateName, params, {
                inherit: false,
                reload: false,
                notify: true
            });
            setNavActive(false);
            scheduleNavigationEnsure();
            log('חזרה ללשונית המקורית: ' + stateName);
        } catch (e) {
            error('לא הצלחתי לחזור ללשונית המקורית:', e);
            scheduleNavigationEnsure();
        }
    }

    function getPrimaryItemKey(item) {
        const data = item && item.targetData;
        if (!data) return '';
        if (data.alphaId !== undefined && data.alphaId !== null && String(data.alphaId).trim()) {
            return 'alpha:' + String(data.alphaId).trim();
        }
        if (data.id !== undefined && data.id !== null && String(data.id).trim()) {
            return 'id:' + String(data.id).trim();
        }
        return '';
    }

    function findNewCardToFocus(previousKeys) {
        const cards = document.querySelectorAll(FEED_SELECTOR);
        for (const card of cards) {
            const link = card.querySelector('a.pinDealLink[href*="/deals/"]');
            if (!link) continue;
            const match = /\/deals\/([^/?#]+)/.exec(link.getAttribute('href') || '');
            if (!match) continue;
            const key = 'alpha:' + decodeURIComponent(match[1]);
            if (!previousKeys.has(key)) {
                const target = card.querySelector('a[href], button:not([disabled])');
                if (target) {
                    target.focus();
                    return;
                }
            }
        }
    }

    async function loadMoreFromAllSources() {
        if (!mergedActive || loadingMore || !controllerScope) return;

        const pendingSources = sourceStates.filter(source => !source.eof);
        if (!pendingSources.length) {
            safeApply(() => { controllerScope.eof = true; });
            return;
        }

        loadingMore = true;
        const previousKeys = new Set(mergeSourceItems().map(getPrimaryItemKey).filter(Boolean));
        safeApply(() => {
            controllerScope.nfDealsLoading = 1;
            controllerScope.nfLoadError = false;
        });
        log('מתחיל לטעון עמוד נוסף מכל המדורים שעדיין מכילים פרסומים.');

        const results = await Promise.all(pendingSources.map(async source => {
            const requestedPage = source.page;
            try {
                const response = await requestSourcePage(source, requestedPage);
                const added = addResponseToSource(source, response);
                log(source.label + ': הסתיימה טעינת עמוד ' + (requestedPage + 1) +
                    ', נוספו ' + added + ' פרסומים.');
                return { source, ok: true, added };
            } catch (e) {
                source.failed = true;
                warn('טעינת עמוד נוסף במדור "' + source.label + '" נכשלה:', e);
                return { source, ok: false, error: e };
            }
        }));

        if (!mergedActive) {
            loadingMore = false;
            return;
        }

        const failed = results.filter(result => !result.ok).length;
        renderMergedFeed();
        safeApply(() => {
            delete controllerScope.nfDealsLoading;
            controllerScope.nfLoadError = false;
            controllerScope.eof = sourceStates.every(source => source.eof);
        });
        loadingMore = false;

        setTimeout(() => findNewCardToFocus(previousKeys), 220);
        const addedSources = results.filter(result => result.ok && result.added > 0).length;
        log('טעינה נוספת הסתיימה. ' + addedSources + ' מדורים הוסיפו פרסומים; ' +
            (failed ? failed + ' מדורים נכשלו וניתן לנסות שוב.' : 'כל הבקשות הצליחו.') +
            ' סה"כ מקורות: ' + sourceStates.map(source => source.key + '=' + source.items.length).join(', '));
    }

    async function buildMergedFeed() {
        if (initialLoading || !mergedActive) return;
        initialLoading = true;

        try {
            controllerScope = await waitForDashboardFeed();
            const updated = seedUpdatedSource(controllerScope);

            if (updated.page === 0 && !updated.eof) {
                warn('הפיד הראשי לא החזיר עמוד ראשון; מנסה להביא אותו ישירות דרך אותו שירות.');
                await fetchFirstPageForSource('updated');
            }

            const otherKeys = ['hot', 'new', 'news', 'hive'];
            const firstPageResults = await Promise.all(otherKeys.map(fetchFirstPageForSource));            if (!mergedActive) return;

            const totalSourcesWithData = [...sourceStateByKey.values()]
                .filter(source => source.items.length > 0).length;
            if (!totalSourcesWithData) throw new Error('לא התקבלו פרסומים מאף אחד מחמשת המדורים.');

            sourceStates = SOURCE_ORDER
                .map(key => sourceStateByKey.get(key))
                .filter(Boolean);

            const count = renderMergedFeed();
            safeApply(() => {
                controllerScope.eof = sourceStates.every(source => source.eof);
                controllerScope.noDeals = count === 0;
                controllerScope.nfLoadError = false;
            });
            setNavActive(true);

            const failedKeys = sourceStates.filter(source => source.failed).map(source => source.key);
            log('גרסה ' + VERSION + ' מוכנה. ' + count + ' פרסומים ייחודיים. ' +
                (failedKeys.length ? 'מדורים שלא נטענו: ' + failedKeys.join(', ') : 'כל חמשת המדורים נטענו.'));

            if (firstPageResults.every(result => result === false)) {
                warn('אף אחד מארבעת המדורים הנוספים לא נטען. כרגע מוצגים רק הפרסומים מהפיד הראשי.');
            }
        } catch (e) {
            error('בניית הפיד המאוחד נכשלה:', e);
            removeMergedMode(true);
        } finally {
            initialLoading = false;
        }
    }

    async function enterMergedFeed() {
        if (!getInjector()) {
            error('Angular עדיין לא מוכן; לא ניתן לפתוח את הפיד המאוחד.');
            return;
        }

        if (mergedActive && (initialLoading || sourceStates.length)) {
            setNavActive(true);
            return;
        }

        try {
            const currentName = $state.current && $state.current.name;
            const currentParams = $state.params || {};

            if (currentName !== 'parent.dashboard' || currentParams.username !== 'dashboard') {
                log('עובר פנימית ל-parent.dashboard באמצעות Angular UI-Router.');
                await $state.transitionTo('parent.dashboard', { username: 'dashboard' }, {
                    inherit: false,
                    reload: false,
                    notify: true
                });
            }

            safeApply(() => $location.hash(MERGED_HASH));
            mergedActive = true;
            setNavActive(true);
            sourceStateByKey.clear();
            sourceStates = [];
            controllerScope = null;
            firstAdPosition = null;
            await buildMergedFeed();
        } catch (e) {
            error('המעבר לפיד המאוחד נכשל:', e);
            removeMergedMode(true);
        }
    }

    function onDocumentClick(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const mergedLink = target.closest('a[data-bee-merged-tab="1"]');
        if (mergedLink) {
            if (event.button !== 0 || event.ctrlKey || event.metaKey ||
                event.shiftKey || event.altKey) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
            enterMergedFeed();
            return;
        }

        if (mergedActive) {
            const loadMoreButton = target.closest(LOAD_MORE_SELECTOR);
            if (loadMoreButton) {
                event.preventDefault();
                event.stopPropagation();
                if (event.stopImmediatePropagation) event.stopImmediatePropagation();
                log('לחיצה על "טען עוד דילים" – טוען את העמוד הבא מכל המדורים.');
                loadMoreFromAllSources();
                return;
            }
        }

        if (!mergedActive) return;
        const nativeTabLink = target.closest('a[href]');
        const navigationList = findFeedNavigationList();
        if (!nativeTabLink || !navigationList || !navigationList.contains(nativeTabLink)) return;

        const stateName = stateForTabPath(pathFromAnchor(nativeTabLink));
        if (!stateName) return;
        if (event.button !== 0 || event.ctrlKey || event.metaKey ||
            event.shiftKey || event.altKey) return;

        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        leaveForNativeTab(stateName);
    }

    function scheduleNavigationEnsure() {
        if (navEnsureScheduled || !isDashboardRoute()) return;
        navEnsureScheduled = true;

        setTimeout(() => {
            navEnsureScheduled = false;
            if (!isDashboardRoute()) return;
            const listBefore = findFeedNavigationList();
            const hadTab = !!(listBefore && listBefore.querySelector('a[data-bee-merged-tab="1"]'));
            const added = addMergedTab();
            if (added && !hadTab) setNavActive(mergedActive || isMergedUrl());
        }, 80);
    }

    function installStateListeners() {
        if (window.__beeDealsMergedV132Listeners) return;
        window.__beeDealsMergedV132Listeners = true;

        document.addEventListener('click', onDocumentClick, true);

        $rootScope.$on('$stateChangeStart', (event, toState) => {
            const name = toState && toState.name || '';
            if (mergedActive && !(name === 'parent.dashboard' || name.indexOf('parent.dashboard.') === 0)) {
                removeMergedMode(true);
            }
        });

        $rootScope.$on('$stateChangeSuccess', () => {
            [0, 100, 300, 700].forEach(delay => setTimeout(() => {
                if (!isDashboardRoute()) return;
                const listBefore = findFeedNavigationList();
                const hadTab = !!(listBefore && listBefore.querySelector('a[data-bee-merged-tab="1"]'));
                const added = addMergedTab();
                if (mergedActive) setNavActive(true);
                else if (added && !hadTab) setNavActive(false);
            }, delay));
        });

        window.addEventListener('hashchange', () => {
            if (isMergedUrl() && !mergedActive) {
                enterMergedFeed();
                return;
            }
            if (!isMergedUrl() && mergedActive && normalizedPath(location.pathname) === '/dashboard') {
                removeMergedMode(false);
            }
        });
    }

    function watchNavigation() {
        if (navObserver) return;
        navObserver = new MutationObserver(() => {
            if (!isDashboardRoute()) return;
            const list = findFeedNavigationList();
            if (list && !list.querySelector('a[data-bee-merged-tab="1"]')) {
                scheduleNavigationEnsure();
            }
        });

        navObserver.observe(document.documentElement, { childList: true, subtree: true });

        // גיבוי בלבד למקרה שהאתר מחליף את ה-header בלי שינוי DOM שנקלט בזמן.
        // ה-MutationObserver הוא המנגנון הראשי; תדירות הגיבוי הופחתה ל-1.2 שניות.
        setInterval(() => {
            if (!isDashboardRoute()) return;
            const list = findFeedNavigationList();
            if (list && !list.querySelector('a[data-bee-merged-tab="1"]')) {
                scheduleNavigationEnsure();
            }
        }, 1200);
    }

    async function init() {
        await waitUntil(() => getInjector(), 30000, 'אתחול Angular של Bee.Deals');
        await waitUntil(() => $state && $state.current && $state.current.name &&
            $state.current.name !== 'parent', 30000, 'סיום הניווט הראשוני של האתר');

        log('הופעל, גרסה ' + VERSION + '.');
        log('המיון מבוסס על targetData.date בלבד; last_edit_date אינו נבדק.');
        installStateListeners();
        addMergedTab();
        watchNavigation();

        window.__beeMerged = {
            version: VERSION,
            inspectDates() {
                return lastMergeRecords.map((record, index) => ({
                    position: index + 1,
                    source: record.source,
                    alphaId: record.item.targetData.alphaId || '',
                    id: record.item.targetData.id || '',
                    dateRaw: record.rawDate,
                    dateParsed: formatTimestamp(record.timestamp),
                    timestamp: record.timestamp || 0,
                    title: record.item.targetData.titleIL || record.item.targetData.title || ''
                }));
            },
            inspectItem(identifier) {
                const needle = String(identifier || '').trim();
                const record = lastMergeRecords.find(entry =>
                    String(entry.item.targetData.alphaId || '') === needle ||
                    String(entry.item.targetData.id || '') === needle
                );
                if (!record) return null;
                return {
                    source: record.source,
                    alphaId: record.item.targetData.alphaId || '',
                    id: record.item.targetData.id || '',
                    dateRaw: record.rawDate,
                    dateParsed: formatTimestamp(record.timestamp),
                    timestamp: record.timestamp || 0,
                    position: lastMergeRecords.indexOf(record) + 1,
                    title: record.item.targetData.titleIL || record.item.targetData.title || ''
                };
            },
            inspectDomOrder(limit = 25) {
                const rank = new Map(lastMergeRecords.map((record, index) => [
                    String(record.item.targetData.alphaId || record.item.targetData.id || ''), index + 1
                ]));
                const cards = [...document.querySelectorAll(FEED_SELECTOR)]
                    .slice(0, Math.max(1, Number(limit) || 25));
                return cards.map((card, index) => {
                    const link = card.querySelector('a.pinDealLink[href*="/deals/"]');
                    const match = link && /\/deals\/([^/?#]+)/.exec(link.getAttribute('href') || '');
                    const alphaId = match ? decodeURIComponent(match[1]) : '';
                    return {
                        domPosition: index + 1,
                        alphaId,
                        sortedPosition: rank.get(alphaId) || null
                    };
                });
            },
            inspectSourceCounts() {
                return sourceStates.map(source => ({
                    key: source.key,
                    label: source.label,
                    items: source.items.length,
                    nextPage: source.page,
                    eof: source.eof,
                    failed: source.failed
                }));
            }
        };

        if (isMergedUrl()) {
            log('זוהתה כתובת שמורה של הפיד המאוחד; פותח אותו ללא רענון נוסף.');
            await enterMergedFeed();
        }
    }

    init().catch(e => error('שגיאה באתחול:', e));
})();