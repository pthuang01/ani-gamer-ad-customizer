// ==UserScript==
// @name         巴哈動畫瘋廣告自訂助手
// @namespace    https://github.com/pthuang01/ani-gamer-ad-customizer
// @version      1.8
// @description  限制為巴哈自帶廣告 (跳過Google Ads)，25秒結束廣告、手動/自動結束廣告、正常/靜音播放廣告，及一個隱藏的實驗性功能
// @author       DoReMi
// @match        https://ani.gamer.com.tw/animeVideo.php?sn=*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @icon         https://ani.gamer.com.tw/favicon.ico
// @homepageURL  https://github.com/pthuang01/ani-gamer-ad-customizer
// @supportURL   https://github.com/pthuang01/ani-gamer-ad-customizer/issues
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const targetDocument = targetWindow.document;

    // ==========================================
    // 1. 設定與儲存管理 (預設：正常播放 + 自動跳過)
    // ==========================================
    const CONFIG = {
        get playMode() {
            return GM_getValue('ani_play_mode', 'normal'); // 'normal' | 'muted' | 'no-download'
        },
        set playMode(val) {
            GM_setValue('ani_play_mode', val);
        },
        get skipMode() {
            // 若為「完全不下載廣告」，強制限定為自動跳過
            if (this.playMode === 'no-download') {
                return 'auto';
            }
            return GM_getValue('ani_skip_mode', 'auto'); // 'auto' | 'manual'
        },
        set skipMode(val) {
            GM_setValue('ani_skip_mode', val);
        }
    };

    // ==========================================
    // 2. 廣告生命週期與後端時間記錄
    // ==========================================
    let currentAdSession = null;
    let cishuStartTime = 0;
    let activePlayer = null;

    // 攔截 fetch 精確獲取後端 videoCastcishu 呼叫時間點
    const origFetch = targetWindow.fetch.bind(targetWindow);
    targetWindow.fetch = function (resource, init) {
        try {
            const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
            if (typeof url === 'string' && url.includes('/ajax/videoCastcishu.php')) {
                if (!url.includes('ad=end')) {
                    cishuStartTime = Date.now();
                    console.log('[動畫瘋助手] 後端廣告計數開始，基準時間:', cishuStartTime);
                } else {
                    const diff = ((Date.now() - cishuStartTime) / 1000).toFixed(2);
                    console.log(`[動畫瘋助手] 後端廣告結束信號送出，總歷時: ${diff} 秒`);
                }
            }
        } catch (e) {
            console.error('[動畫瘋助手] fetch 攔截例外:', e);
        }
        return origFetch(resource, init);
    };

    // ==========================================
    // 3. 25 秒主動完結廣告核心 (徹底杜絕 Google Ads 與重播)
    // ==========================================
    function finishAdNow(session) {
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
        const playerEl = session.player && session.player.el ? session.player.el() : targetDocument.getElementById('ani_video');
        if (playerEl) {
            playerEl.classList.remove('vjs-anigamer-ad-playing');
            playerEl.classList.remove('vjs-ad-playing');
        }

        // 3. 清理 DOM 上的遮罩與跳過按鈕
        const blocker = targetDocument.querySelector('.vast-blocker');
        if (blocker) blocker.remove();
        const skipBtn = targetDocument.getElementById('adSkipButton');
        if (skipBtn) skipBtn.remove();

        // 4. 正片開始前，徹底解除靜音狀態（修復正片靜音問題）
        const videoElem = targetDocument.getElementById('ani_video_html5_api') || targetDocument.querySelector('#ani_video video');
        if (videoElem) {
            videoElem.muted = false;
        }
        if (session.player && typeof session.player.muted === 'function') {
            session.player.muted(false);
        }

        // 5. 計算後端自 start 起經過的時間，嚴格確保達到 >= 25.3 秒（滿足後端 25.0 秒驗證門檻）
        const baseTime = cishuStartTime || session.startTime;
        const elapsedMs = Date.now() - baseTime;
        const waitMs = Math.max(0, 25300 - elapsedMs);

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

    // ==========================================
    // 4. 計時器防重疊守衛 (徹底杜絕多重計時器倍速扣減)
    // ==========================================
    let adCountdownIntervalId = null;
    let lastTickTime = 0;
    const origSetInterval = targetWindow.setInterval.bind(targetWindow);
    const origClearInterval = targetWindow.clearInterval.bind(targetWindow);

    targetWindow.setInterval = function (fn, delay, ...args) {
        if (typeof fn === 'function' && delay === 1000) {
            const fnStr = fn.toString();
            if (fnStr.includes('skipText') || fnStr.includes('#o') || fnStr.includes('#p')) {
                if (adCountdownIntervalId !== null) {
                    origClearInterval(adCountdownIntervalId);
                    adCountdownIntervalId = null;
                }

                const throttledFn = function (...fnArgs) {
                    const now = Date.now();
                    if (now - lastTickTime < 900) {
                        return;
                    }
                    lastTickTime = now;
                    return fn.apply(this, fnArgs);
                };

                const id = origSetInterval(throttledFn, delay, ...args);
                adCountdownIntervalId = id;
                return id;
            }
        }
        return origSetInterval(fn, delay, ...args);
    };

    targetWindow.clearInterval = function (id) {
        if (id === adCountdownIntervalId) {
            adCountdownIntervalId = null;
        }
        return origClearInterval(id);
    };

    // ==========================================
    // 5. 彈出設定視窗 UI (取消、套用、儲存並重整)
    // ==========================================
    function showSettingsModal() {
        const existing = targetDocument.getElementById('ani-ad-settings-modal');
        if (existing) existing.remove();

        const modalOverlay = targetDocument.createElement('div');
        modalOverlay.id = 'ani-ad-settings-modal';
        modalOverlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.7);
            display: flex; align-items: center; justify-content: center;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        `;

        const currentPlayMode = CONFIG.playMode;
        const currentSkipMode = CONFIG.skipMode;

        modalOverlay.innerHTML = `
            <div style="
                background: #1e1f22;
                color: #f2f3f5;
                width: 500px;
                max-width: 92vw;
                border-radius: 12px;
                box-shadow: 0 12px 36px rgba(0,0,0,0.5);
                border: 1px solid #35373c;
                overflow: hidden;
                animation: aniModalFadeIn 0.2s ease-out;
            ">
                <style>
                    @keyframes aniModalFadeIn {
                        from { opacity: 0; transform: scale(0.95); }
                        to { opacity: 1; transform: scale(1); }
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
                </style>

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
                        <div class="ani-modal-option" data-radio-id="playMode_no_download">
                            <input type="radio" id="playMode_no_download" name="ani_play_mode" value="no-download" ${currentPlayMode === 'no-download' ? 'checked' : ''}>
                            <label for="playMode_no_download">
                                完全不下載廣告
                                <span class="ani-modal-desc">阻擋廣告切片下載 (0 MB 流量)，25 秒虛擬計時後直接切入正片</span>
                            </label>
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
        `;

        targetDocument.body.appendChild(modalOverlay);

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

        const closeModal = () => modalOverlay.remove();
        targetDocument.getElementById('ani-btn-close').onclick = closeModal;
        modalOverlay.onclick = (e) => { if (e.target === modalOverlay) closeModal(); };
        targetDocument.getElementById('ani-btn-cancel').onclick = closeModal;

        const getSelectedValues = () => {
            const playMode = modalOverlay.querySelector('input[name="ani_play_mode"]:checked')?.value || 'normal';
            let skipMode = modalOverlay.querySelector('input[name="ani_skip_mode"]:checked')?.value || 'auto';
            if (playMode === 'no-download') skipMode = 'auto';
            return { playMode, skipMode };
        };

        targetDocument.getElementById('ani-btn-apply').onclick = () => {
            const { playMode, skipMode } = getSelectedValues();
            CONFIG.playMode = playMode;
            CONFIG.skipMode = skipMode;
            applyMutePolicy();
            showToast('已套用設定！即時生效');
            closeModal();
        };

        targetDocument.getElementById('ani-btn-save-reload').onclick = () => {
            const { playMode, skipMode } = getSelectedValues();
            CONFIG.playMode = playMode;
            CONFIG.skipMode = skipMode;
            closeModal();
            location.reload();
        };
    }

    function showToast(msg) {
        const toast = targetDocument.createElement('div');
        toast.style.cssText = `
            position: fixed;
            bottom: 40px;
            left: 50%;
            transform: translateX(-50%);
            background: #00d4c5;
            color: #111214;
            padding: 10px 22px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            z-index: 1000000;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            pointer-events: none;
        `;
        toast.textContent = msg;
        targetDocument.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    }

    GM_registerMenuCommand('⚙️ 動畫瘋廣告設定視窗 (Alt + A)', () => {
        showSettingsModal();
    });

    targetDocument.addEventListener('keydown', (e) => {
        if (e.altKey && (e.key === 'a' || e.key === 'A')) {
            showSettingsModal();
        }
    });

    // ==========================================
    // 6. 動態廣告資料讀取 (絕不寫死任何 ID)
    // ==========================================
    let capturedMajorAdFn = null;

    function getDynamicNativeAd() {
        if (typeof targetWindow.getMinorAd === 'function') {
            const ad = targetWindow.getMinorAd();
            if (ad && Array.isArray(ad) && ad.length >= 4) {
                const clone = [...ad];
                clone[3] = 'video';
                return clone;
            }
        }
        if (typeof targetWindow.getAd === 'function') {
            const ad = targetWindow.getAd();
            if (ad && Array.isArray(ad) && ad.length >= 4) {
                const clone = [...ad];
                clone[3] = 'video';
                return clone;
            }
        }
        if (typeof capturedMajorAdFn === 'function') {
            const ad = capturedMajorAdFn();
            if (ad && Array.isArray(ad) && ad.length >= 4) {
                const clone = [...ad];
                clone[3] = 'video';
                return clone;
            }
        }
        return null;
    }

    Object.defineProperty(targetWindow, 'getMajorAd', {
        get() { return getDynamicNativeAd; },
        set(fn) { capturedMajorAdFn = fn; },
        configurable: false
    });

    // ==========================================
    // 7. 廣告狀態檢測與靜音鎖定管理 (修復正片靜音問題)
    // ==========================================
    function isAdPlaying() {
        return Boolean(
            targetDocument.querySelector('.vjs-anigamer-ad-playing') ||
            targetDocument.querySelector('#adSkipButton') ||
            targetDocument.querySelector('.vast-blocker')
        );
    }

    function applyMutePolicy() {
        const videoElem = targetDocument.getElementById('ani_video_html5_api') || targetDocument.querySelector('#ani_video video');
        if (!videoElem) return;

        if (isAdPlaying()) {
            if (CONFIG.playMode === 'muted' || CONFIG.playMode === 'no-download') {
                if (!videoElem.muted) videoElem.muted = true;
                if (activePlayer && typeof activePlayer.muted === 'function' && !activePlayer.muted()) {
                    activePlayer.muted(true);
                }
            } else if (CONFIG.playMode === 'normal') {
                if (videoElem.muted) videoElem.muted = false;
                if (activePlayer && typeof activePlayer.muted === 'function' && activePlayer.muted()) {
                    activePlayer.muted(false);
                }
            }
        } else {
            // 正片播放中：無論先前是什麼模式，絕對解除靜音！
            if (videoElem.muted) {
                videoElem.muted = false;
            }
            if (activePlayer && typeof activePlayer.muted === 'function' && activePlayer.muted()) {
                activePlayer.muted(false);
            }
        }
    }

    // ==========================================
    // 8. 播放器核心掛鉤 (攔截 adHandler/animeAd 與主動控制)
    // ==========================================
    let dummyMediaStream = null;
    let dummyCanvasInterval = null;

    function getOrCreateDummyStream() {
        if (!dummyMediaStream) {
            const canvas = targetDocument.createElement('canvas');
            canvas.width = 16;
            canvas.height = 16;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, 16, 16);
            dummyMediaStream = canvas.captureStream(1);

            // 每秒微幅繪製畫布，維持 MediaStream 心跳，徹底防止瀏覽器判為 Stalled/Buffer 空乏
            let toggle = false;
            dummyCanvasInterval = setInterval(() => {
                toggle = !toggle;
                ctx.fillStyle = toggle ? '#000000' : '#010101';
                ctx.fillRect(0, 0, 16, 16);
            }, 1000);
        }
        return dummyMediaStream;
    }

    function hookPlayer(player) {
        if (!player || player.__aniHooked) return;
        player.__aniHooked = true;
        activePlayer = player;

        // 【壓制廣告期間的 player.error 彈窗】
        const origPlayerError = player.error.bind(player);
        player.error = function (err, ...args) {
            if (err && currentAdSession && !currentAdSession.ended) {
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
                        if (currentAdSession && !currentAdSession.ended) {
                            console.warn('[動畫瘋助手] 壓制廣告期間的 animeMask.showError:', errArgs);
                            return;
                        }
                        return origShowError(...errArgs);
                    };
                }
                return mask;
            };
        }

        // 【關鍵攔截一】：攔截 player.adHandler()，捕獲每次廣告的生命週期與 onComplete 回呼
        const setupAdHandlerHook = (handlerInst) => {
            if (handlerInst && !handlerInst.__playHooked) {
                handlerInst.__playHooked = true;
                const origPlay = handlerInst.play.bind(handlerInst);
                handlerInst.play = function (videoSn, adInfo, onComplete) {
                    console.log('[動畫瘋助手] 成功攔截 adHandler.play, sn:', videoSn, 'adInfo:', adInfo);
                    currentAdSession = {
                        player,
                        handlerInst,
                        videoSn,
                        adInfo,
                        onComplete,
                        startTime: Date.now(),
                        ended: false
                    };
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
                player[pluginName] = function (...args) {
                    const inst = origPlugin(...args);
                    if (inst && !inst.__ani25sHooked) {
                        inst.__ani25sHooked = true;
                        const origPlay = inst.play.bind(inst);
                        inst.play = function (options) {
                            if (options) {
                                options.skipTime = 25;
                                options.skipCountDown = 25;
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
                                finishAdNow(currentAdSession);
                                return;
                            }
                            return origTrigger(evt, ...args);
                        };
                    }
                    return inst;
                };

                try {
                    const inst = player[pluginName]();
                    if (inst && !inst.__ani25sHooked) {
                        inst.__ani25sHooked = true;
                        const origPlay = inst.play.bind(inst);
                        inst.play = function (options) {
                            if (options) {
                                options.skipTime = 25;
                                options.skipCountDown = 25;
                            }
                            return origPlay(options);
                        };
                        const origTrigger = inst.trigger.bind(inst);
                        inst.trigger = function (evt, ...args) {
                            const evtType = typeof evt === 'string' ? evt : (evt && evt.type ? evt.type : '');
                            if (evtType === 'error' || evtType === inst.AD_EVENTS?.ERROR) {
                                console.warn('[動畫瘋助手] 壓制廣告插件的 ERROR 事件，防止回退或重播');
                                return;
                            }
                            if (evtType === 'end' || evtType === inst.AD_EVENTS?.END) {
                                finishAdNow(currentAdSession);
                                return;
                            }
                            return origTrigger(evt, ...args);
                        };
                    }
                } catch (e) {}
            }
        };

        setupPluginHook('animeAd');
        setupPluginHook('nativeAd');

        // 【關鍵攔截三】：播放器 src 掛鉤 (免下載黑屏串流與正片解鎖)
        const origSrc = player.src.bind(player);

        player.src = function (source) {
            const isAd = source && (
                (typeof source === 'string' && source.includes('/ad/')) ||
                (typeof source === 'object' && source.src && source.src.includes('/ad/'))
            );

            const videoElem = targetDocument.getElementById('ani_video_html5_api') || targetDocument.querySelector('#ani_video video');

            if (isAd) {
                if (CONFIG.playMode === 'no-download') {
                    console.log('[動畫瘋助手] 模式【完全不下載廣告】：阻止 Akamai 下載，啟動 1fps 心跳虛擬串流');

                    if (videoElem) {
                        videoElem.removeAttribute('src');
                        const oldSources = videoElem.querySelectorAll('source');
                        oldSources.forEach(s => s.remove());
                    }

                    const stream = getOrCreateDummyStream();
                    if (videoElem) {
                        videoElem.srcObject = stream;
                        videoElem.muted = true;
                        videoElem.play().catch(() => {});
                    }

                    lastTickTime = 0;

                    setTimeout(() => {
                        player.trigger('loadedmetadata');
                    }, 50);

                    return;
                }

                if (CONFIG.playMode === 'muted') {
                    if (videoElem) videoElem.muted = true;
                    player.muted(true);
                }
            } else {
                // 正片串流：徹底清理虛擬串流、定時器與解除靜音
                if (dummyCanvasInterval) {
                    clearInterval(dummyCanvasInterval);
                    dummyCanvasInterval = null;
                }
                dummyMediaStream = null;

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

        const videoElem = targetDocument.getElementById('ani_video_html5_api') || targetDocument.querySelector('#ani_video video');
        if (videoElem) {
            ['volumechange', 'play', 'canplay', 'timeupdate'].forEach(evtName => {
                videoElem.addEventListener(evtName, applyMutePolicy);
            });

            // 廣告影片若自然播放至尾聲 (30秒)，攔截 ended 直接進入完結流程
            videoElem.addEventListener('ended', (e) => {
                if (currentAdSession && !currentAdSession.ended) {
                    e.stopImmediatePropagation();
                    finishAdNow(currentAdSession);
                }
            }, true);
        }
    }

    const origCreateElement = targetDocument.createElement.bind(targetDocument);
    targetDocument.createElement = function (tagName, ...args) {
        const el = origCreateElement(tagName, ...args);
        if (tagName && tagName.toLowerCase() === 'video-js') {
            let _player = null;
            Object.defineProperty(el, 'player', {
                get() { return _player; },
                set(p) {
                    _player = p;
                    if (p) hookPlayer(p);
                },
                configurable: true
            });
        }
        if (tagName && tagName.toLowerCase() === 'source') {
            const origSetAttribute = el.setAttribute.bind(el);
            el.setAttribute = function (name, value) {
                if (name === 'src' && typeof value === 'string' && value.includes('welcome_to_anigamer')) {
                    if (CONFIG.playMode === 'no-download') {
                        value = '';
                    }
                }
                return origSetAttribute(name, value);
            };
        }
        return el;
    };

    targetDocument.addEventListener('DOMContentLoaded', () => {
        const videoJsEl = targetDocument.getElementById('ani_video');
        if (videoJsEl && videoJsEl.player) {
            hookPlayer(videoJsEl.player);
        }
    });

    // ==========================================
    // 9. 跳過按鈕事件監控 (25秒倒數完結直接切正片)
    // ==========================================
    targetDocument.addEventListener('DOMContentLoaded', () => {
        const observer = new MutationObserver(() => {
            applyMutePolicy();

            const skipBtn = targetDocument.getElementById('adSkipButton');
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
                            finishAdNow(currentAdSession);
                        }
                    }, true);
                }

                // 自動跳過模式：按鈕亮起時立即觸發 finishAdNow
                if (skipBtn.classList.contains('enable') && !skipBtn.__autoHandled) {
                    if (CONFIG.skipMode === 'auto') {
                        skipBtn.__autoHandled = true;
                        finishAdNow(currentAdSession);
                    }
                }
            }
        });

        observer.observe(targetDocument.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    });

})();
