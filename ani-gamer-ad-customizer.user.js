// ==UserScript==
// @name         動畫瘋廣告自訂助手
// @namespace    https://github.com/pthuang01/ani-gamer-ad-customizer
// @version      2.0
// @description  限制為動畫瘋自帶廣告 (跳過Google Ads)，25秒結束廣告、手動/自動結束廣告、正常/靜音播放廣告，及一個隱藏的實驗性功能
// @author       DoReMi
// @match        https://ani.gamer.com.tw/animeVideo.php?sn=*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @icon         https://ani.gamer.com.tw/apple-touch-icon-144.jpg
// @homepageURL  https://github.com/pthuang01/ani-gamer-ad-customizer
// @supportURL   https://github.com/pthuang01/ani-gamer-ad-customizer/issues
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 1. 環境與全域常數定義 (ENV & CONSTANTS)
    // ==========================================
    const ENV = {
        get window() {
            return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        },
        get document() {
            return this.window.document;
        }
    };

    const CONSTANTS = {
        AD_CONFIG: {
            TARGET_SKIP_TIME: 25,          // 廣告目標倒數秒數
            MIN_BACKEND_ELAPSED_MS: 25300, // 後端驗證安全門檻 (25.3 秒)
            COUNTDOWN_THROTTLE_MS: 900     // 倒數計時器防重複觸發節流間隔
        },
        UI_CONFIG: {
            UNLOCK_HOVER_SECONDS: 1.5,     // 隱藏抽屜解鎖懸停秒數
            TOAST_DURATION_MS: 4000        // 解鎖 Toast 顯示時間
        },
        SELECTORS: {
            PLAYER_CONTAINER: '#ani_video',
            HTML5_VIDEO: '#ani_video_html5_api',
            SKIP_BUTTON: '#adSkipButton',
            VAST_BLOCKER: '.vast-blocker',
            AD_PLAYING_CLASS: 'vjs-anigamer-ad-playing',
            AD_PLAYING_GENERIC_CLASS: 'vjs-ad-playing',
            MODAL_ID: 'ani-ad-settings-modal',
            STYLES_ID: 'ani-ad-customizer-styles'
        },
        STORAGE_KEYS: {
            PLAY_MODE: 'ani_play_mode',
            SKIP_MODE: 'ani_skip_mode'
        }
    };

    // ==========================================
    // 2. 設定管理模組 (ConfigManager)
    // ==========================================
    const ConfigManager = {
        get playMode() {
            // 'normal' (正常播放) | 'muted' (靜音播放) | 'no-download' (完全不下載廣告)
            return GM_getValue(CONSTANTS.STORAGE_KEYS.PLAY_MODE, 'normal');
        },
        set playMode(val) {
            GM_setValue(CONSTANTS.STORAGE_KEYS.PLAY_MODE, val);
        },
        get skipMode() {
            // 若為「完全不下載廣告」，強制限定為自動跳過
            if (this.playMode === 'no-download') {
                return 'auto';
            }
            // 'auto' (自動跳過) | 'manual' (不跳過廣告)
            return GM_getValue(CONSTANTS.STORAGE_KEYS.SKIP_MODE, 'auto');
        },
        set skipMode(val) {
            GM_setValue(CONSTANTS.STORAGE_KEYS.SKIP_MODE, val);
        },
        save(playMode, skipMode) {
            this.playMode = playMode;
            this.skipMode = (playMode === 'no-download') ? 'auto' : skipMode;
        }
    };

    // ==========================================
    // 3. 狀態倉儲模組 (SessionStore)
    //    集中管理廣告生命週期、計時器狀態與播放器指標
    // ==========================================
    const SessionStore = (function () {
        let currentAdSession = null;
        let cishuStartTime = 0;
        let activePlayer = null;
        let adCountdownIntervalId = null;
        let lastTickTime = 0;
        let capturedMajorAdFn = null;

        return {
            get currentSession() {
                return currentAdSession;
            },
            createSession(sessionData) {
                currentAdSession = {
                    player: sessionData.player,
                    handlerInst: sessionData.handlerInst,
                    videoSn: sessionData.videoSn,
                    adInfo: sessionData.adInfo,
                    onComplete: sessionData.onComplete,
                    startTime: Date.now(),
                    ended: false
                };
                return currentAdSession;
            },
            clearSession() {
                currentAdSession = null;
            },
            get cishuStartTime() {
                return cishuStartTime;
            },
            setCishuStartTime(timestamp) {
                cishuStartTime = timestamp;
            },
            get activePlayer() {
                return activePlayer;
            },
            setActivePlayer(player) {
                activePlayer = player;
            },
            get adCountdownIntervalId() {
                return adCountdownIntervalId;
            },
            setAdCountdownIntervalId(id) {
                adCountdownIntervalId = id;
            },
            get lastTickTime() {
                return lastTickTime;
            },
            setLastTickTime(time) {
                lastTickTime = time;
            },
            get capturedMajorAdFn() {
                return capturedMajorAdFn;
            },
            setCapturedMajorAdFn(fn) {
                capturedMajorAdFn = fn;
            }
        };
    })();

    // ==========================================
    // 4. 虛擬串流服務 (VirtualStreamService)
    //    管理 16x16 記憶體 Detached Canvas 與 1fps 黑色心跳串流
    // ==========================================
    const VirtualStreamService = (function () {
        let dummyMediaStream = null;
        let dummyCanvasInterval = null;

        return {
            getStream() {
                if (!dummyMediaStream) {
                    const canvas = ENV.document.createElement('canvas');
                    canvas.width = 16;
                    canvas.height = 16;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#000000';
                    ctx.fillRect(0, 0, 16, 16);
                    dummyMediaStream = canvas.captureStream(1);

                    // 每秒微幅交替繪製畫布，維持 MediaStream 心跳，徹底防止瀏覽器判為 Stalled/Buffer 空乏
                    let toggle = false;
                    dummyCanvasInterval = setInterval(() => {
                        toggle = !toggle;
                        ctx.fillStyle = toggle ? '#000000' : '#010101';
                        ctx.fillRect(0, 0, 16, 16);
                    }, 1000);
                }
                return dummyMediaStream;
            },
            cleanup() {
                if (dummyCanvasInterval) {
                    clearInterval(dummyCanvasInterval);
                    dummyCanvasInterval = null;
                }
                dummyMediaStream = null;
            }
        };
    })();

    // ==========================================
    // 5. 音訊原則管理 (AudioPolicyManager)
    //    統籌靜音原則，確保正片播放時絕對解除靜音
    // ==========================================
    const AudioPolicyManager = {
        isAdPlaying() {
            const doc = ENV.document;
            return Boolean(
                doc.querySelector('.' + CONSTANTS.SELECTORS.AD_PLAYING_CLASS) ||
                doc.querySelector(CONSTANTS.SELECTORS.SKIP_BUTTON) ||
                doc.querySelector(CONSTANTS.SELECTORS.VAST_BLOCKER)
            );
        },
        getVideoElement() {
            return ENV.document.querySelector(CONSTANTS.SELECTORS.HTML5_VIDEO) ||
                   ENV.document.querySelector(`${CONSTANTS.SELECTORS.PLAYER_CONTAINER} video`);
        },
        applyPolicy() {
            const videoElem = this.getVideoElement();
            if (!videoElem) return;

            const player = SessionStore.activePlayer;

            if (this.isAdPlaying()) {
                // 廣告播放中：依設定決定靜音或正常
                if (ConfigManager.playMode === 'muted' || ConfigManager.playMode === 'no-download') {
                    if (!videoElem.muted) videoElem.muted = true;
                    if (player && typeof player.muted === 'function' && !player.muted()) {
                        player.muted(true);
                    }
                } else if (ConfigManager.playMode === 'normal') {
                    if (videoElem.muted) videoElem.muted = false;
                    if (player && typeof player.muted === 'function' && player.muted()) {
                        player.muted(false);
                    }
                }
            } else {
                // 正片播放中：無論先前是什麼模式，絕對強制解除靜音！
                if (videoElem.muted) {
                    videoElem.muted = false;
                }
                if (player && typeof player.muted === 'function' && player.muted()) {
                    player.muted(false);
                }
            }
        }
    };

    // ==========================================
    // 6. 廣告生命週期控制器 (AdLifecycleController)
    //    統籌 25 秒主動完結、後端驗證、銷毀與正片銜接
    // ==========================================
    const AdLifecycleController = {
        finishAdNow(session = SessionStore.currentSession) {
            if (!session || session.ended) return;
            session.ended = true;

            console.log('[動畫瘋助手] 滿 25 秒，主動終止廣告流程並載入正片！');

            // 1. 銷毀 adHandler 旗下所有廣告子實例，切斷任何 fallback 到 Google Ads (ima/rewarded/native/PAD) 的路徑
            try {
                if (session.handlerInst && typeof session.handlerInst.destroy === 'function') {
                    session.handlerInst.destroy();
                }
            } catch (e) {
                console.warn('[動畫瘋助手] handler destroy 警告:', e);
            }

            // 2. 清理 player 上的廣告 class
            const playerEl = session.player && session.player.el ? session.player.el() : ENV.document.querySelector(CONSTANTS.SELECTORS.PLAYER_CONTAINER);
            if (playerEl) {
                playerEl.classList.remove(CONSTANTS.SELECTORS.AD_PLAYING_CLASS);
                playerEl.classList.remove(CONSTANTS.SELECTORS.AD_PLAYING_GENERIC_CLASS);
            }

            // 3. 清理 DOM 上的遮罩與跳過按鈕
            const blocker = ENV.document.querySelector(CONSTANTS.SELECTORS.VAST_BLOCKER);
            if (blocker) blocker.remove();
            const skipBtn = ENV.document.querySelector(CONSTANTS.SELECTORS.SKIP_BUTTON);
            if (skipBtn) skipBtn.remove();

            // 4. 正片開始前，徹底解除靜音狀態（修復正片靜音問題）
            AudioPolicyManager.applyPolicy();
            const videoElem = AudioPolicyManager.getVideoElement();
            if (videoElem) videoElem.muted = false;
            if (session.player && typeof session.player.muted === 'function') {
                session.player.muted(false);
            }

            // 5. 計算後端自 start 起經過的時間，嚴格確保達到 >= 25.3 秒（滿足後端 25.0 秒驗證門檻）
            const baseTime = SessionStore.cishuStartTime || session.startTime;
            const elapsedMs = Date.now() - baseTime;
            const waitMs = Math.max(0, CONSTANTS.AD_CONFIG.MIN_BACKEND_ELAPSED_MS - elapsedMs);

            console.log(`[動畫瘋助手] 後端已過 ${elapsedMs}ms，等待 ${waitMs}ms 後發送 &ad=end...`);

            setTimeout(() => {
                const endUrl = `/ajax/videoCastcishu.php?s=${session.adInfo.adSid}&sn=${session.videoSn}&ad=end`;
                console.log('[動畫瘋助手] 正式發送後端完成信號:', endUrl);

                fetch(endUrl)
                    .then(res => res.text())
                    .then(data => {
                        console.log('[動畫瘋助手] 後端回報成功:', data);
                        if (typeof session.onComplete === 'function') {
                            console.log('[動畫瘋助手] 執行 onComplete() 載入正片！');
                            session.onComplete();
                        }
                    })
                    .catch(err => {
                        console.error('[動畫瘋助手] 後端請求錯誤，仍執行 onComplete():', err);
                        if (typeof session.onComplete === 'function') {
                            session.onComplete();
                        }
                    });
            }, waitMs);
        }
    };

    // ==========================================
    // 7. 攔截器群組 (Interceptors)
    // ==========================================
    const Interceptors = {
        // (1) 網路攔截：監聽後端廣告計時起始點
        initNetwork() {
            const origFetch = ENV.window.fetch.bind(ENV.window);
            ENV.window.fetch = function (resource, init) {
                try {
                    const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
                    if (typeof url === 'string' && url.includes('/ajax/videoCastcishu.php')) {
                        if (!url.includes('ad=end')) {
                            const now = Date.now();
                            SessionStore.setCishuStartTime(now);
                            console.log('[動畫瘋助手] 後端廣告計數開始，基準時間:', now);
                        } else {
                            const diff = ((Date.now() - SessionStore.cishuStartTime) / 1000).toFixed(2);
                            console.log(`[動畫瘋助手] 後端廣告結束信號送出，總歷時: ${diff} 秒`);
                        }
                    }
                } catch (e) {
                    console.error('[動畫瘋助手] fetch 攔截例外:', e);
                }
                return origFetch(resource, init);
            };
        },

        // (2) 計時器防重疊守衛：節流原生倒數計時器，杜絕雙倍速倒數
        initTimerGuard() {
            const origSetInterval = ENV.window.setInterval.bind(ENV.window);
            const origClearInterval = ENV.window.clearInterval.bind(ENV.window);

            ENV.window.setInterval = function (fn, delay, ...args) {
                if (typeof fn === 'function' && delay === 1000) {
                    const fnStr = fn.toString();
                    if (fnStr.includes('skipText') || fnStr.includes('#o') || fnStr.includes('#p')) {
                        if (SessionStore.adCountdownIntervalId !== null) {
                            origClearInterval(SessionStore.adCountdownIntervalId);
                            SessionStore.setAdCountdownIntervalId(null);
                        }

                        const throttledFn = function (...fnArgs) {
                            const now = Date.now();
                            if (now - SessionStore.lastTickTime < CONSTANTS.AD_CONFIG.COUNTDOWN_THROTTLE_MS) {
                                return;
                            }
                            SessionStore.setLastTickTime(now);
                            return fn.apply(this, fnArgs);
                        };

                        const id = origSetInterval(throttledFn, delay, ...args);
                        SessionStore.setAdCountdownIntervalId(id);
                        return id;
                    }
                }
                return origSetInterval(fn, delay, ...args);
            };

            ENV.window.clearInterval = function (id) {
                if (id === SessionStore.adCountdownIntervalId) {
                    SessionStore.setAdCountdownIntervalId(null);
                }
                return origClearInterval(id);
            };
        },

        // (3) 動態廣告資料讀取：鎖定為原生廣告資料，絕不寫死 ID
        initNativeAdData() {
            function getDynamicNativeAd() {
                const targetWin = ENV.window;
                if (typeof targetWin.getMinorAd === 'function') {
                    const ad = targetWin.getMinorAd();
                    if (ad && Array.isArray(ad) && ad.length >= 4) {
                        const clone = [...ad];
                        clone[3] = 'video';
                        return clone;
                    }
                }
                if (typeof targetWin.getAd === 'function') {
                    const ad = targetWin.getAd();
                    if (ad && Array.isArray(ad) && ad.length >= 4) {
                        const clone = [...ad];
                        clone[3] = 'video';
                        return clone;
                    }
                }
                const capturedFn = SessionStore.capturedMajorAdFn;
                if (typeof capturedFn === 'function') {
                    const ad = capturedFn();
                    if (ad && Array.isArray(ad) && ad.length >= 4) {
                        const clone = [...ad];
                        clone[3] = 'video';
                        return clone;
                    }
                }
                return null;
            }

            Object.defineProperty(ENV.window, 'getMajorAd', {
                get() { return getDynamicNativeAd; },
                set(fn) { SessionStore.setCapturedMajorAdFn(fn); },
                configurable: false
            });
        },

        // (4) 播放器核心掛鉤 (Video.js, adHandler, 廣告插件, 虛擬串流)
        hookPlayer(player) {
            if (!player || player.__aniHooked) return;
            player.__aniHooked = true;
            SessionStore.setActivePlayer(player);

            // 【壓制廣告期間的 player.error 彈窗】
            const origPlayerError = player.error.bind(player);
            player.error = function (err, ...args) {
                const session = SessionStore.currentSession;
                if (err && session && !session.ended) {
                    console.warn('[動畫瘋助手] 壓制廣告期間的 player.error 報錯彈窗:', err);
                    return null;
                }
                return origPlayerError(err, ...args);
            };

            // 【壓制廣告期間的 animeMask.showError】
            if (typeof player.animeMask === 'function') {
                const origMask = player.animeMask.bind(player);
                player.animeMask = function (...args) {
                    const mask = origMask(...args);
                    if (mask && !mask.__hooked) {
                        mask.__hooked = true;
                        const origShowError = mask.showError.bind(mask);
                        mask.showError = function (...errArgs) {
                            const session = SessionStore.currentSession;
                            if (session && !session.ended) {
                                console.warn('[動畫瘋助手] 壓制廣告期間的 animeMask.showError:', errArgs);
                                return;
                            }
                            return origShowError(...errArgs);
                        };
                    }
                    return mask;
                };
            }

            // 【關鍵攔截一】：攔截 player.adHandler()，捕獲每次廣告生命週期與 onComplete 回呼
            const setupAdHandlerHook = (handlerInst) => {
                if (handlerInst && !handlerInst.__playHooked) {
                    handlerInst.__playHooked = true;
                    const origPlay = handlerInst.play.bind(handlerInst);
                    handlerInst.play = function (videoSn, adInfo, onComplete) {
                        console.log('[動畫瘋助手] 成功攔截 adHandler.play, sn:', videoSn, 'adInfo:', adInfo);
                        SessionStore.createSession({
                            player,
                            handlerInst,
                            videoSn,
                            adInfo,
                            onComplete
                        });
                        return origPlay(videoSn, adInfo, onComplete);
                    };
                }
            };

            if (typeof player.adHandler === 'function') {
                const origAdHandler = player.adHandler.bind(player);
                player.adHandler = function (...args) {
                    const inst = origAdHandler(...args);
                    setupAdHandlerHook(inst);
                    return inst;
                };
                try {
                    setupAdHandlerHook(player.adHandler());
                } catch (e) {}
            }

            // 【關鍵攔截二】：縮短廣告插件內部倒數參數為 25 秒，並壓制 AD_EVENTS.ERROR
            const setupPluginHook = (pluginName) => {
                if (typeof player[pluginName] === 'function') {
                    const origPlugin = player[pluginName].bind(player);
                    const wrapPluginInstance = (inst) => {
                        if (inst && !inst.__ani25sHooked) {
                            inst.__ani25sHooked = true;
                            const origPlay = inst.play.bind(inst);
                            inst.play = function (options) {
                                if (options) {
                                    options.skipTime = CONSTANTS.AD_CONFIG.TARGET_SKIP_TIME;
                                    options.skipCountDown = CONSTANTS.AD_CONFIG.TARGET_SKIP_TIME;
                                }
                                return origPlay(options);
                            };

                            // 壓制廣告插件內部的 trigger('error')，絕不回退到 Google 廣告或 PAD 重播！
                            const origTrigger = inst.trigger.bind(inst);
                            inst.trigger = function (evt, ...args) {
                                const evtType = typeof evt === 'string' ? evt : (evt && evt.type ? evt.type : '');
                                if (evtType === 'error' || evtType === inst.AD_EVENTS?.ERROR) {
                                    console.warn('[動畫瘋助手] 壓制廣告插件的 ERROR 事件，防止回退或重播');
                                    return;
                                }
                                if (evtType === 'end' || evtType === inst.AD_EVENTS?.END) {
                                    AdLifecycleController.finishAdNow(SessionStore.currentSession);
                                    return;
                                }
                                return origTrigger(evt, ...args);
                            };
                        }
                        return inst;
                    };

                    player[pluginName] = function (...args) {
                        const inst = origPlugin(...args);
                        return wrapPluginInstance(inst);
                    };

                    try {
                        wrapPluginInstance(player[pluginName]());
                    } catch (e) {}
                }
            };

            setupPluginHook('animeAd');
            setupPluginHook('nativeAd');

            // 【關鍵攔截三】：播放器 src 掛鉤 (完全不下載虛擬串流與正片銜接)
            const origSrc = player.src.bind(player);
            player.src = function (source) {
                const isAd = source && (
                    (typeof source === 'string' && source.includes('/ad/')) ||
                    (typeof source === 'object' && source.src && source.src.includes('/ad/'))
                );

                const videoElem = AudioPolicyManager.getVideoElement();

                if (isAd) {
                    if (ConfigManager.playMode === 'no-download') {
                        console.log('[動畫瘋助手] 模式【完全不下載廣告】：阻止 Akamai 下載，啟動 1fps 心跳虛擬串流');

                        if (videoElem) {
                            videoElem.removeAttribute('src');
                            const oldSources = videoElem.querySelectorAll('source');
                            oldSources.forEach(s => s.remove());
                        }

                        const stream = VirtualStreamService.getStream();
                        if (videoElem) {
                            videoElem.srcObject = stream;
                            videoElem.muted = true;
                            videoElem.play().catch(() => {});
                        }

                        SessionStore.setLastTickTime(0);

                        setTimeout(() => {
                            player.trigger('loadedmetadata');
                        }, 50);

                        return;
                    }

                    if (ConfigManager.playMode === 'muted') {
                        if (videoElem) videoElem.muted = true;
                        player.muted(true);
                    }
                } else {
                    // 正片串流：徹底清理虛擬串流、解除靜音
                    VirtualStreamService.cleanup();

                    if (videoElem && videoElem.srcObject) {
                        videoElem.srcObject = null;
                    }
                    if (videoElem) {
                        videoElem.muted = false;
                    }
                    player.muted(false);
                }

                return origSrc(source);
            };

            const videoElem = AudioPolicyManager.getVideoElement();
            if (videoElem) {
                ['volumechange', 'play', 'canplay', 'timeupdate'].forEach(evtName => {
                    videoElem.addEventListener(evtName, () => AudioPolicyManager.applyPolicy());
                });

                // 廣告影片若自然播放至尾聲 (30秒)，攔截 ended 直接進入完結流程
                videoElem.addEventListener('ended', (e) => {
                    const session = SessionStore.currentSession;
                    if (session && !session.ended) {
                        e.stopImmediatePropagation();
                        AdLifecycleController.finishAdNow(session);
                    }
                }, true);
            }
        },

        // (5) DOM 攔截與觀察者：攔截標籤生成與監聽跳過按鈕
        initDOM() {
            const origCreateElement = ENV.document.createElement.bind(ENV.document);
            ENV.document.createElement = function (tagName, ...args) {
                const el = origCreateElement(tagName, ...args);
                if (tagName && tagName.toLowerCase() === 'video-js') {
                    let _player = null;
                    Object.defineProperty(el, 'player', {
                        get() { return _player; },
                        set(p) {
                            _player = p;
                            if (p) Interceptors.hookPlayer(p);
                        },
                        configurable: true
                    });
                }
                if (tagName && tagName.toLowerCase() === 'source') {
                    const origSetAttribute = el.setAttribute.bind(el);
                    el.setAttribute = function (name, value) {
                        if (name === 'src' && typeof value === 'string' && value.includes('welcome_to_anigamer')) {
                            if (ConfigManager.playMode === 'no-download') {
                                value = '';
                            }
                        }
                        return origSetAttribute(name, value);
                    };
                }
                return el;
            };

            ENV.document.addEventListener('DOMContentLoaded', () => {
                const videoJsEl = ENV.document.querySelector(CONSTANTS.SELECTORS.PLAYER_CONTAINER);
                if (videoJsEl && videoJsEl.player) {
                    Interceptors.hookPlayer(videoJsEl.player);
                }

                // 監控廣告跳過按鈕狀態與自動觸發
                const observer = new MutationObserver(() => {
                    AudioPolicyManager.applyPolicy();

                    const skipBtn = ENV.document.querySelector(CONSTANTS.SELECTORS.SKIP_BUTTON);
                    if (skipBtn) {
                        // 初次顯示時，校正 30 秒為 25 秒
                        if (skipBtn.textContent && skipBtn.textContent.includes('30 秒')) {
                            skipBtn.innerHTML = skipBtn.innerHTML.replace('30 秒', '25 秒');
                        }

                        // 攔截手動點擊事件
                        if (!skipBtn.__hookedClick) {
                            skipBtn.__hookedClick = true;
                            skipBtn.addEventListener('click', (e) => {
                                if (skipBtn.classList.contains('enable')) {
                                    e.stopImmediatePropagation();
                                    e.preventDefault();
                                    AdLifecycleController.finishAdNow(SessionStore.currentSession);
                                }
                            }, true);
                        }

                        // 自動跳過模式：按鈕亮起時立即觸發 finishAdNow
                        if (skipBtn.classList.contains('enable') && !skipBtn.__autoHandled) {
                            if (ConfigManager.skipMode === 'auto') {
                                skipBtn.__autoHandled = true;
                                AdLifecycleController.finishAdNow(SessionStore.currentSession);
                            }
                        }
                    }
                });

                observer.observe(ENV.document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'style']
                });
            });
        }
    };

    // ==========================================
    // 8. 視圖與 UI 模組 (UIModule)
    // ==========================================
    const UIModule = (function () {
        const CSS_STYLES = `
            @keyframes aniModalFadeIn {
                from { opacity: 0; transform: scale(0.95); }
                to { opacity: 1; transform: scale(1); }
            }
            @keyframes aniToastRainbowIn {
                0% { opacity: 0; transform: translate(-50%, 15px) scale(0.95); }
                100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
            }

            /* 圍繞視窗的七彩霓虹流光動畫 */
            @keyframes aniRainbowSpin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            /* 緩慢浮現 1 秒 ➔ 圍繞流動 2 秒 ➔ 柔和淡出 1 秒消失 (總長 4.0s) */
            @keyframes aniRainbowFade {
                0% { opacity: 0; }
                25% { opacity: 1; }
                75% { opacity: 1; }
                100% { opacity: 0; }
            }
            .ani-rainbow-layer {
                position: absolute;
                pointer-events: none;
                opacity: 0;
                overflow: hidden;
            }
            .ani-rainbow-blur {
                inset: -6px;
                border-radius: 18px;
                filter: blur(14px);
                z-index: 0;
            }
            .ani-rainbow-spinner {
                position: absolute;
                width: 300%;
                height: 300%;
                top: -100%;
                left: -100%;
                background: conic-gradient(
                    from 0deg,
                    #ff0055 0deg,
                    #ff7700 45deg,
                    #ffee00 90deg,
                    #00ff88 135deg,
                    #00ffff 180deg,
                    #0077ff 225deg,
                    #aa00ff 270deg,
                    #ff00aa 315deg,
                    #ff0055 360deg
                );
                animation: aniRainbowSpin 3.5s linear infinite;
                transform-origin: center center;
            }
            .ani-rainbow-active {
                animation: aniRainbowFade 4.0s ease-in-out forwards !important;
            }
            .ani-modal-section { margin-bottom: 20px; }
            .ani-modal-title {
                font-size: 14px;
                font-weight: 600;
                color: #00d4c5;
                margin-bottom: 10px;
                letter-spacing: 0.5px;
            }
            .ani-modal-option {
                display: flex;
                align-items: center;
                padding: 10px 14px;
                margin-bottom: 6px;
                border-radius: 6px;
                background: #2b2d31;
                cursor: pointer;
                user-select: none;
                transition: background 0.15s, opacity 0.15s;
            }
            .ani-modal-option:hover { background: #35373c; }
            .ani-modal-option.disabled {
                cursor: not-allowed !important;
                opacity: 0.45;
                background: #232428 !important;
                pointer-events: none;
            }
            .ani-modal-option input[type="radio"] {
                margin-right: 12px;
                cursor: pointer;
                accent-color: #00d4c5;
                width: 16px;
                height: 16px;
            }
            .ani-modal-option label {
                cursor: pointer;
                flex: 1;
                font-size: 14px;
            }
            .ani-modal-desc {
                display: block;
                font-size: 12px;
                color: #949ba4;
                margin-top: 2px;
            }
            .ani-btn {
                padding: 8px 16px;
                border-radius: 6px;
                border: none;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.15s;
            }
            .ani-btn-cancel { background: #313338; color: #dbdee1; }
            .ani-btn-cancel:hover { background: #3d4047; }
            .ani-btn-apply { background: #008f85; color: #ffffff; }
            .ani-btn-apply:hover { background: #00a89c; }
            .ani-btn-save-reload { background: #00d4c5; color: #111214; font-weight: 600; }
            .ani-btn-save-reload:hover { background: #1affec; }

            /* 隱藏選項平滑抽屜容器 */
            .ani-hidden-container {
                max-height: 0;
                opacity: 0;
                overflow: hidden;
                transition: max-height 0.4s cubic-bezier(0.16, 1, 0.3, 1),
                            opacity 0.35s ease,
                            margin 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                margin-bottom: 0;
            }
            .ani-hidden-container.expanded {
                max-height: 110px;
                opacity: 1;
                margin-bottom: 6px;
                overflow: visible;
            }

            /* 讓「完全不下載廣告」選項從左側往右 fade-in 2s 到定點 */
            @keyframes aniOptionSlideInLeft {
                0% {
                    opacity: 0;
                    transform: translateX(-32px);
                }
                100% {
                    opacity: 1;
                    transform: translateX(0);
                }
            }
            .ani-hidden-container.unlock-slide .ani-modal-option {
                animation: aniOptionSlideInLeft 2.0s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }

            /* 現代感極簡開合分隔線 */
            .ani-collapse-divider {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 6px 0 2px 0;
                cursor: default;
                user-select: none;
            }
            .ani-collapse-divider .ani-divider-line {
                flex: 1;
                height: 1px;
                position: relative;
                background: linear-gradient(90deg, rgba(53, 55, 60, 0.2), #35373c 30%, #35373c 70%, rgba(53, 55, 60, 0.2));
            }
            .ani-collapse-divider .ani-divider-line::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: linear-gradient(90deg, rgba(0, 212, 197, 0.1), #00d4c5 30%, #00d4c5 70%, rgba(0, 212, 197, 0.1));
                box-shadow: 0 0 8px rgba(0, 212, 197, 0.5);
                opacity: 0;
                transition: opacity 0.4s ease 0s;
                pointer-events: none;
            }
            .ani-collapse-divider .ani-divider-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 20px;
                margin: 0 8px;
                color: #5a5e67;
                cursor: default;
                transition: color 0.4s ease 0s, filter 0.4s ease 0s;
            }
            .ani-collapse-divider .ani-divider-icon svg {
                transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }

            /* 閉合狀態：滑鼠懸浮指定秒數後觸發青色霓虹微光特效，分隔線與箭頭嚴格同步延遲 */
            .ani-collapse-divider:not(.expanded):hover .ani-divider-line::after {
                opacity: 1;
                transition: opacity 0.4s ease ${CONSTANTS.UI_CONFIG.UNLOCK_HOVER_SECONDS}s;
            }
            .ani-collapse-divider:not(.expanded):hover .ani-divider-icon {
                color: #00d4c5;
                filter: drop-shadow(0 0 6px rgba(0, 212, 197, 0.7));
                transition: color 0.4s ease ${CONSTANTS.UI_CONFIG.UNLOCK_HOVER_SECONDS}s, filter 0.4s ease ${CONSTANTS.UI_CONFIG.UNLOCK_HOVER_SECONDS}s;
            }

            /* 展開後狀態：箭頭翻轉 180 度 */
            .ani-collapse-divider.expanded .ani-divider-icon svg {
                transform: rotate(180deg);
            }

            /* 展開後狀態：Hover 不發生任何特效 */
            .ani-collapse-divider.expanded:hover .ani-divider-line::after {
                opacity: 0;
                transition: none;
            }
            .ani-collapse-divider.expanded:hover .ani-divider-icon {
                color: #5a5e67;
                filter: none;
                transition: none;
            }
        `;

        function injectStyles() {
            if (!ENV.document.getElementById(CONSTANTS.SELECTORS.STYLES_ID)) {
                const styleEl = ENV.document.createElement('style');
                styleEl.id = CONSTANTS.SELECTORS.STYLES_ID;
                styleEl.textContent = CSS_STYLES;
                (ENV.document.head || ENV.document.documentElement).appendChild(styleEl);
            }
        }

        function showToast(msg, durationMs = 2500) {
            injectStyles();
            const toast = ENV.document.createElement('div');
            toast.style.cssText = `
                position: fixed;
                bottom: 40px;
                left: 50%;
                transform: translateX(-50%);
                background: #00d4c5;
                color: #111214;
                padding: 11px 24px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                z-index: 1000000;
                box-shadow: 0 4px 18px rgba(0, 212, 197, 0.45);
                pointer-events: none;
                letter-spacing: 0.5px;
                animation: aniToastRainbowIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                transition: opacity 0.8s ease, transform 0.8s ease;
            `;
            toast.textContent = msg;
            ENV.document.body.appendChild(toast);

            // 在最後 0.8 秒隨同七彩流光柔和淡出
            const fadeDelay = Math.max(0, durationMs - 800);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translate(-50%, 8px)';
                setTimeout(() => toast.remove(), 800);
            }, fadeDelay);
        }

        function showSettingsModal() {
            injectStyles();
            const existing = ENV.document.getElementById(CONSTANTS.SELECTORS.MODAL_ID);
            if (existing) existing.remove();

            const modalOverlay = ENV.document.createElement('div');
            modalOverlay.id = CONSTANTS.SELECTORS.MODAL_ID;
            modalOverlay.style.cssText = `
                position: fixed;
                top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(0, 0, 0, 0.7);
                display: flex; align-items: center; justify-content: center;
                z-index: 999999;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            `;

            const currentPlayMode = ConfigManager.playMode;
            const currentSkipMode = ConfigManager.skipMode;
            const isExpanded = currentPlayMode === 'no-download';

            modalOverlay.innerHTML = `
                <div class="ani-modal-wrapper" style="position: relative; border-radius: 14px; max-width: 92vw;">
                    <!-- 七彩霓虹流光層 (外光暈) -->
                    <div id="ani-rainbow-glow" class="ani-rainbow-layer ani-rainbow-blur">
                        <div class="ani-rainbow-spinner"></div>
                    </div>

                    <!-- 設定視窗主體 -->
                    <div style="
                        position: relative;
                        z-index: 2;
                        background: #1e1f22;
                        color: #f2f3f5;
                        width: 500px;
                        max-width: 100%;
                        border-radius: 12px;
                        box-shadow: 0 12px 36px rgba(0,0,0,0.5);
                        border: 1px solid #35373c;
                        overflow: hidden;
                        animation: aniModalFadeIn 0.2s ease-out;
                    ">
                        <!-- Header -->
                        <div style="padding: 16px 20px; border-bottom: 1px solid #313338; display: flex; justify-content: space-between; align-items: center;">
                            <h3 style="margin: 0; font-size: 17px; font-weight: 600; color: #ffffff;">動畫瘋廣告自訂設定</h3>
                            <span id="ani-btn-close" style="font-size: 22px; color: #949ba4; cursor: pointer; line-height: 1;">&times;</span>
                        </div>

                        <!-- Body -->
                        <div style="padding: 20px;">
                            <!-- 選項一：播放模式 -->
                            <div class="ani-modal-section">
                                <div class="ani-modal-title">廣告播放模式</div>
                                <div class="ani-modal-option" data-radio-id="playMode_normal">
                                    <input type="radio" id="playMode_normal" name="ani_play_mode" value="normal" ${currentPlayMode === 'normal' ? 'checked' : ''}>
                                    <label for="playMode_normal">
                                        正常播放 (預設)
                                        <span class="ani-modal-desc">播放自帶開頭廣告，倒數 25 秒後即時跳過切入正片</span>
                                    </label>
                                </div>
                                <div class="ani-modal-option" data-radio-id="playMode_muted">
                                    <input type="radio" id="playMode_muted" name="ani_play_mode" value="muted" ${currentPlayMode === 'muted' ? 'checked' : ''}>
                                    <label for="playMode_muted">
                                        靜音播放
                                        <span class="ani-modal-desc">廣告期間全程強力靜音 (25 秒)，進入正片時自動恢復聲音</span>
                                    </label>
                                </div>
                                <!-- 隱藏抽屜：完全不下載廣告 -->
                                <div id="ani-hidden-container" class="ani-hidden-container ${isExpanded ? 'expanded' : ''}">
                                    <div class="ani-modal-option" data-radio-id="playMode_no_download">
                                        <input type="radio" id="playMode_no_download" name="ani_play_mode" value="no-download" ${currentPlayMode === 'no-download' ? 'checked' : ''}>
                                        <label for="playMode_no_download">
                                            完全不下載廣告
                                            <span class="ani-modal-desc">阻擋廣告切片下載 (0 MB 流量)，25 秒虛擬計時後直接切入正片</span>
                                        </label>
                                    </div>
                                </div>
                                <!-- 現代感開合分隔線 -->
                                <div id="ani-collapse-divider" class="ani-collapse-divider ${isExpanded ? 'expanded' : ''}">
                                    <div class="ani-divider-line"></div>
                                    <div class="ani-divider-icon">
                                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                                            <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </div>
                                    <div class="ani-divider-line"></div>
                                </div>
                            </div>

                            <!-- 選項二：跳過模式 -->
                            <div class="ani-modal-section" style="margin-bottom: 0;">
                                <div class="ani-modal-title">廣告跳過設定</div>
                                <div class="ani-modal-option" data-radio-id="skipMode_auto">
                                    <input type="radio" id="skipMode_auto" name="ani_skip_mode" value="auto" ${currentSkipMode === 'auto' ? 'checked' : ''}>
                                    <label for="skipMode_auto">
                                        倒數結束自動點擊跳過 (預設)
                                        <span class="ani-modal-desc">滿 25 秒按鈕亮起時自動模擬點擊切入正片</span>
                                    </label>
                                </div>
                                <div class="ani-modal-option" id="skipMode_manual_wrapper" data-radio-id="skipMode_manual">
                                    <input type="radio" id="skipMode_manual" name="ani_skip_mode" value="manual" ${currentSkipMode === 'manual' ? 'checked' : ''}>
                                    <label for="skipMode_manual">
                                        不跳過廣告
                                        <span class="ani-modal-desc" id="skipMode_manual_desc">不自動點擊，由您自行決定手動點擊跳過或看完廣告</span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        <!-- Footer -->
                        <div style="padding: 14px 20px; border-top: 1px solid #313338; display: flex; justify-content: flex-end; gap: 10px; background: #232428;">
                            <button class="ani-btn ani-btn-cancel" id="ani-btn-cancel">取消</button>
                            <button class="ani-btn ani-btn-apply" id="ani-btn-apply">套用</button>
                            <button class="ani-btn ani-btn-save-reload" id="ani-btn-save-reload">儲存並重整</button>
                        </div>
                    </div>
                </div>
            `;

            ENV.document.body.appendChild(modalOverlay);

            // 開合分隔線切換邏輯 (閉合狀態下：在發亮前按它不會展開)
            const collapseDivider = modalOverlay.querySelector('#ani-collapse-divider');
            const hiddenContainer = modalOverlay.querySelector('#ani-hidden-container');

            let hoverTimer = null;
            let isGlowActive = false;

            collapseDivider.addEventListener('mouseenter', () => {
                if (!collapseDivider.classList.contains('expanded')) {
                    clearTimeout(hoverTimer);
                    hoverTimer = setTimeout(() => {
                        isGlowActive = true;
                    }, CONSTANTS.UI_CONFIG.UNLOCK_HOVER_SECONDS * 1000);
                }
            });

            collapseDivider.addEventListener('mouseleave', () => {
                clearTimeout(hoverTimer);
                hoverTimer = null;
                isGlowActive = false;
            });

            collapseDivider.addEventListener('click', () => {
                const isCurrentlyExpanded = hiddenContainer.classList.contains('expanded');
                if (!isCurrentlyExpanded) {
                    // 閉合狀態：在發亮前點擊不會展開
                    if (!isGlowActive) return;

                    // 1. 觸發設定視窗邊框的七彩霓虹流光特效
                    const rainbowGlow = modalOverlay.querySelector('#ani-rainbow-glow');
                    if (rainbowGlow) {
                        rainbowGlow.classList.remove('ani-rainbow-active');
                        void rainbowGlow.offsetWidth; // 強制重繪
                        rainbowGlow.classList.add('ani-rainbow-active');
                    }

                    // 2. 發生霓虹特效的同時彈出專屬 Toast
                    showToast('已解鎖實驗性隱藏功能！', CONSTANTS.UI_CONFIG.TOAST_DURATION_MS);

                    // 3. 「完全不下載廣告」選項從左側往右 fade-in 2s 到定點展開
                    hiddenContainer.classList.remove('unlock-slide');
                    void hiddenContainer.offsetWidth; // 強制重繪觸發動畫
                    hiddenContainer.classList.add('unlock-slide');
                    hiddenContainer.classList.add('expanded');
                    collapseDivider.classList.add('expanded');

                    isGlowActive = false;
                    clearTimeout(hoverTimer);
                } else {
                    // 展開狀態：可隨時點擊收合
                    hiddenContainer.classList.remove('expanded');
                    hiddenContainer.classList.remove('unlock-slide');
                    collapseDivider.classList.remove('expanded');
                    isGlowActive = false;
                    clearTimeout(hoverTimer);
                }
            });

            // 點擊選項整列皆可選取
            modalOverlay.querySelectorAll('.ani-modal-option').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    if (opt.classList.contains('disabled')) return;
                    const radio = opt.querySelector('input[type="radio"]');
                    if (radio && !radio.disabled && e.target !== radio) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
            });

            // 聯動邏輯：選擇「完全不下載廣告」時，強制鎖定為自動跳過並禁用「不跳過廣告」
            const radioNoDownload = modalOverlay.querySelector('#playMode_no_download');
            const radioNormal = modalOverlay.querySelector('#playMode_normal');
            const radioMuted = modalOverlay.querySelector('#playMode_muted');
            const radioSkipAuto = modalOverlay.querySelector('#skipMode_auto');
            const radioSkipManual = modalOverlay.querySelector('#skipMode_manual');
            const manualWrapper = modalOverlay.querySelector('#skipMode_manual_wrapper');
            const manualDesc = modalOverlay.querySelector('#skipMode_manual_desc');

            function updateSkipOptionState() {
                if (radioNoDownload.checked) {
                    radioSkipAuto.checked = true;
                    radioSkipManual.disabled = true;
                    manualWrapper.classList.add('disabled');
                    manualDesc.textContent = '完全不下載模式無廣告可看，已強制鎖定為自動跳過';
                } else {
                    radioSkipManual.disabled = false;
                    manualWrapper.classList.remove('disabled');
                    manualDesc.textContent = '不自動點擊，由您自行決定手動點擊跳過或看完廣告';
                }
            }

            radioNoDownload.addEventListener('change', updateSkipOptionState);
            radioNormal.addEventListener('change', updateSkipOptionState);
            radioMuted.addEventListener('change', updateSkipOptionState);
            updateSkipOptionState();

            const closeModal = () => {
                clearTimeout(hoverTimer);
                modalOverlay.remove();
            };
            ENV.document.getElementById('ani-btn-close').onclick = closeModal;
            modalOverlay.onclick = (e) => { if (e.target === modalOverlay) closeModal(); };
            ENV.document.getElementById('ani-btn-cancel').onclick = closeModal;

            const getSelectedValues = () => {
                const playMode = modalOverlay.querySelector('input[name="ani_play_mode"]:checked')?.value || 'normal';
                let skipMode = modalOverlay.querySelector('input[name="ani_skip_mode"]:checked')?.value || 'auto';
                if (playMode === 'no-download') skipMode = 'auto';
                return { playMode, skipMode };
            };

            ENV.document.getElementById('ani-btn-apply').onclick = () => {
                const { playMode, skipMode } = getSelectedValues();
                ConfigManager.save(playMode, skipMode);
                AudioPolicyManager.applyPolicy();
                showToast('已套用設定！即時生效');
                closeModal();
            };

            ENV.document.getElementById('ani-btn-save-reload').onclick = () => {
                const { playMode, skipMode } = getSelectedValues();
                ConfigManager.save(playMode, skipMode);
                closeModal();
                location.reload();
            };
        }

        function initShortcuts() {
            GM_registerMenuCommand('⚙️ 動畫瘋廣告設定視窗 (Alt + A)', () => {
                showSettingsModal();
            });

            ENV.document.addEventListener('keydown', (e) => {
                if (e.altKey && (e.key === 'a' || e.key === 'A')) {
                    showSettingsModal();
                }
            });
        }

        return {
            showModal: showSettingsModal,
            showToast: showToast,
            initShortcuts: initShortcuts
        };
    })();

    // ==========================================
    // 9. 應用啟動器 (AppBootstrap)
    // ==========================================
    const AppBootstrap = {
        init() {
            Interceptors.initNetwork();
            Interceptors.initTimerGuard();
            Interceptors.initNativeAdData();
            Interceptors.initDOM();
            UIModule.initShortcuts();
            console.log('[動畫瘋助手] 模組初始化完成 (v2.0)');
        }
    };

    // 啟動腳本
    AppBootstrap.init();

})();
