// ==UserScript==
// @name         Notion 提词器模式
// @namespace    https://viayoo.com/
// @version      3.2.0
// @description  Notion 正文与格式同步、富文本提词、左右镜像、字号滑块、防误触、防息屏
// @author       You
// @run-at       document-start
// @match        https://app.notion.com/*
// @match        https://notion.com/*
// @match        https://www.notion.com/*
// @match        https://notion.so/*
// @match        https://www.notion.so/*
// @match        https://*.notion.so/*
// @match        https://notion.site/*
// @match        https://www.notion.site/*
// @match        https://*.notion.site/*
// @grant        none
// @noframes
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;
    const HOST_ID = 'via-notion-teleprompter-v3';
    const ACTIVE_ATTR = 'data-via-teleprompter-v3';
    const FONT_KEY = 'via-notion-teleprompter-font-size';
    const HIDE_AFTER = 4000;

    function mount() {
        if (!document.documentElement) {
            setTimeout(mount, 30);
            return;
        }
        if (document.getElementById(HOST_ID)) return;

        let active = false, session = 0, saved = null;
        let hideTimer = 0, dragging = false, fontSize = 32;
        let wakeLock = null, pendingWake = null;
        let source = null, syncObserver = null, syncTimer = 0;
        let visibleRoots = [];
        try {
            const stored = Number(localStorage.getItem(FONT_KEY));
            if (stored >= 16 && stored <= 96) fontSize = Math.round(stored);
        } catch (_) {}

        const host = document.createElement('div');
        host.id = HOST_ID;
        host.contentEditable = 'false';
        host.style.cssText =
            'all:initial!important;position:fixed!important;inset:0!important;' +
            'z-index:2147483647!important;pointer-events:none!important;' +
            'display:block!important;transform:none!important;';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { --font-size: 32px; color-scheme: dark; }
                * { box-sizing: border-box; }
                [hidden] { display: none !important; }
                button, input { font: 16px system-ui, sans-serif; }
                button {
                    border: 1px solid #666; border-radius: 9px;
                    padding: 10px 13px; background: #222; color: #fff;
                    cursor: pointer; touch-action: manipulation;
                }
                #enter {
                    position: fixed; right: 18px; bottom: 80px;
                    pointer-events: auto; border-radius: 50%;
                    width: 58px; height: 58px; padding: 0;
                    background: #111; box-shadow: 0 2px 12px #0006;
                }
                #screen {
                    position: fixed; inset: 0; background: #000;
                    color: #fff; pointer-events: auto;
                    font-family: Arial, "Noto Sans SC", sans-serif;
                }
                #reader {
                    width: 100%; height: 100%; overflow: auto;
                    overscroll-behavior: contain; touch-action: pan-y;
                    scrollbar-width: none; outline: none;
                    user-select: none; -webkit-user-select: none;
                    -webkit-touch-callout: none; cursor: default;
                }
                #reader::-webkit-scrollbar { display: none; }
                #text {
                    margin: 0 auto; max-width: 1200px;
                    padding: max(28px, env(safe-area-inset-top))
                             max(24px, env(safe-area-inset-left), env(safe-area-inset-right))
                             55vh;
                    white-space: pre-wrap; overflow-wrap: anywhere;
                    font-size: var(--font-size); line-height: 1.65;
                    font-weight: 400; color: #fff; background: #000;
                    transform: scaleX(-1); transform-origin: center;
                }
                #controls {
                    position: absolute; left: 12px; right: 12px;
                    bottom: max(12px, env(safe-area-inset-bottom));
                    margin: auto; max-width: 720px;
                    padding: 12px; border: 1px solid #555;
                    border-radius: 12px; background: #151515;
                    color: #fff; font: 14px/1.5 system-ui, sans-serif;
                    user-select: none; -webkit-user-select: none;
                    -webkit-touch-callout: none;
                }
                #row { display: flex; align-items: center; gap: 10px; }
                #size { flex: 1; min-width: 40px; height: 36px; accent-color: #fff; }
                #size-value { min-width: 42px; text-align: center; }
                #actions {
                    display: flex; align-items: center; gap: 8px;
                    margin-top: 8px;
                }
                #wake-status { flex: 1; color: #bbb; font-size: 12px; }
                #hint { margin-top: 9px; color: #bbb; font-size: 12px; }
            </style>
            <button id="enter" type="button" aria-label="进入提词模式">提词</button>
            <section id="screen" hidden aria-label="提词模式">
                <div id="reader" tabindex="0" role="document">
                    <div id="text"></div>
                </div>
                <section id="controls" aria-label="提词控制">
                    <div id="row">
                        <label for="size">字号</label>
                        <input id="size" type="range" min="16" max="96" step="1">
                        <output id="size-value" for="size"></output>
                    </div>
                    <div id="actions">
                        <span id="wake-status"></span>
                        <button id="hide" type="button">隐藏</button>
                        <button id="exit" type="button">退出</button>
                    </div>
                    <div id="hint">闲置 4 秒后隐藏。双击正文，再显示控制条。</div>
                </section>
            </section>
        `;
        const get = id => shadow.getElementById(id);
        const enterButton = get('enter'), screen = get('screen');
        const reader = get('reader'), text = get('text');
        const controls = get('controls'), size = get('size');
        const value = get('size-value'), wakeStatus = get('wake-status');
        size.value = String(fontSize);
        value.textContent = fontSize + 'px';
        host.style.setProperty('--font-size', fontSize + 'px');

        const isolation = document.createElement('style');
        // 保留 Notion 渲染和远程同步，使用不透明提词层隔离其界面。
        isolation.textContent =
            'html[' + ACTIVE_ATTR + '] {overflow:hidden!important;background:#000!important;}' +
            'html[' + ACTIVE_ATTR + '] > body {' +
                'pointer-events:none!important;user-select:none!important;' +
                '-webkit-user-select:none!important;' +
            '}';
        document.documentElement.append(isolation, host);

        const rootSelector = '.notion-page-content';
        const skipSelector = 'script,style,template,noscript,svg,canvas,iframe,' +
            'img,video,audio,button,input,select,textarea';

        function findSource() {
            const roots = Array.from(document.querySelectorAll(rootSelector))
                .filter(el => {
                    const rect = el.getBoundingClientRect();
                    return !el.closest('[aria-hidden="true"],[hidden]') &&
                        rect.width > 0 && rect.height > 0 &&
                        getComputedStyle(el).visibility === 'visible';
                });
            const added = roots.filter(el => !visibleRoots.includes(el));
            visibleRoots = roots;
            return roots.find(el => el.contains(document.activeElement)) ||
                added[added.length - 1] || (roots.includes(source) && source) ||
                roots[roots.length - 1] || null;
        }

        // 只复制文字、换行和文字样式，链接与编辑控件留在原页。
        function readContent(root) {
            const fragment = document.createDocumentFragment();
            function copyElement(el, parent, parentUnderline, parentStrike) {
                if (el.matches(skipSelector) || el.hidden) return;
                const css = getComputedStyle(el);
                if (css.display === 'none' || css.visibility !== 'visible' ||
                    css.contentVisibility === 'hidden') return;
                if (el.tagName === 'BR') {
                    parent.append(document.createElement('br'));
                    return;
                }

                const block = el !== root &&
                    /^(block|flow-root|flex|grid|list-item|table|table-row)$/.test(css.display);
                if (css.display === 'table-cell' && el.previousElementSibling) {
                    parent.append('\t');
                }
                const target = block ? document.createElement('div') : parent;
                const underline = parentUnderline || css.textDecorationLine.includes('underline') ||
                    (css.display === 'inline' && parseFloat(css.borderBottomWidth) > 0);
                const strike = parentStrike || css.textDecorationLine.includes('line-through');
                const lines = [underline && 'underline', strike && 'line-through']
                    .filter(Boolean).join(' ');
                const bold = Number(css.fontWeight) >= 600;
                const italic = /^(italic|oblique)/.test(css.fontStyle);
                for (const node of el.childNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        copyElement(node, target, underline, strike);
                    } else if (node.nodeType === Node.TEXT_NODE && node.data) {
                        let value = node.data;
                        if (css.whiteSpace === 'normal' || css.whiteSpace === 'nowrap') {
                            value = value.replace(/[ \t\r\n\f]+/g, ' ');
                        }
                        if (bold || italic || lines) {
                            const span = document.createElement('span');
                            if (bold) span.style.fontWeight = '700';
                            if (italic) span.style.fontStyle = 'italic';
                            if (lines) span.style.textDecorationLine = lines;
                            span.textContent = value;
                            target.append(span);
                        } else {
                            target.append(value);
                        }
                    }
                }
                if (!el.hasChildNodes() && el.matches('[contenteditable="true"],[data-content-editable-leaf]')) {
                    target.append(document.createElement('br'));
                }
                if (block && target.hasChildNodes()) parent.append(target);
            }
            if (root) copyElement(root, fragment, false, false);
            return fragment;
        }

        function syncFromNotion() {
            syncTimer = 0;
            if (!active) return;
            source = findSource();
            const content = readContent(source);
            if (text.childNodes.length === content.childNodes.length &&
                Array.from(content.childNodes).every((node, i) =>
                    node.isEqualNode(text.childNodes[i]))) return;
            const top = reader.scrollTop;
            text.replaceChildren(content);
            reader.scrollTop = top;
        }

        function scheduleSync() {
            if (active && !syncTimer) syncTimer = setTimeout(syncFromNotion, 150);
        }

        function startSync() {
            // Notion 切页时可能保留旧正文，也可能替换整个容器。
            syncObserver = new MutationObserver(records => {
                if (syncTimer) return;
                for (const record of records) {
                    const target = record.target;
                    const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
                    if (el?.closest(rootSelector) || (source && el?.contains(source))) {
                        scheduleSync();
                        return;
                    }
                    if (record.type === 'characterData') continue;
                    if (record.type === 'attributes') {
                        if (visibleRoots.includes(target) || target.querySelector(rootSelector)) {
                            scheduleSync();
                            return;
                        }
                    } else {
                        const nodes = [...record.addedNodes, ...record.removedNodes];
                        if (!source?.isConnected || nodes.some(node =>
                            node.nodeType === Node.ELEMENT_NODE &&
                            (node.matches(rootSelector) || node.querySelector(rootSelector)))) {
                            scheduleSync();
                            return;
                        }
                    }
                }
            });
            syncObserver.observe(document.documentElement, {
                childList: true, characterData: true, attributes: true, subtree: true
            });
        }

        function stopSync() {
            clearTimeout(syncTimer);
            syncTimer = 0;
            syncObserver?.disconnect();
            syncObserver = source = null;
            visibleRoots = [];
        }

        function scheduleHide() {
            clearTimeout(hideTimer);
            if (active && !dragging) {
                hideTimer = setTimeout(hideControls, HIDE_AFTER);
            }
        }
        function hideControls() {
            if (dragging) return;
            clearTimeout(hideTimer);
            controls.hidden = true;
            if (active) reader.focus({ preventScroll: true });
        }
        function showControls() {
            if (!active) return;
            controls.hidden = false;
            scheduleHide();
        }

        async function requestWakeLock() {
            if (!active || wakeLock || pendingWake !== null ||
                document.visibilityState !== 'visible') return;
            if (!navigator.wakeLock) {
                wakeStatus.textContent = '常亮：浏览器不支持';
                return;
            }
            const token = session;
            pendingWake = token;
            try {
                const lock = await navigator.wakeLock.request('screen');
                if (!active || session !== token) {
                    await lock.release();
                    return;
                }
                wakeLock = lock;
                wakeStatus.textContent = '常亮：已开启';
                lock.addEventListener('release', () => {
                    if (wakeLock !== lock) return;
                    wakeLock = null;
                    wakeStatus.textContent = '常亮：已释放，点正文重试';
                });
            } catch (_) {
                if (active && session === token) {
                    wakeStatus.textContent = '常亮：申请失败，点正文重试';
                }
            } finally {
                if (pendingWake === token) pendingWake = null;
            }
        }

        function enter() {
            if (active || !document.body) return;
            source = findSource();
            const content = readContent(source);
            if (!content.textContent.trim()) {
                alert('未找到正文。等笔记加载后，再点“提词”。');
                return;
            }
            const scrolls = [];
            for (let el = source; el; el = el.parentElement) {
                if (el.scrollTop || el.scrollLeft) {
                    scrolls.push([el, el.scrollLeft, el.scrollTop]);
                }
            }
            saved = {
                body: document.body,
                inert: document.body.getAttribute('inert'),
                attr: document.documentElement.getAttribute(ACTIVE_ATTR),
                scrolls, x: window.scrollX, y: window.scrollY
            };
            document.activeElement?.blur?.();
            window.getSelection()?.removeAllRanges();
            text.replaceChildren(content);
            active = true;
            session += 1;
            saved.body.setAttribute('inert', '');
            startSync();
            document.documentElement.setAttribute(ACTIVE_ATTR, '');
            enterButton.hidden = true;
            screen.hidden = false;
            reader.scrollTop = 0;
            reader.focus({ preventScroll: true });
            wakeStatus.textContent = '常亮：正在申请';
            showControls();
            requestWakeLock();
        }

        function exit() {
            if (!active) return;
            active = false;
            session += 1;
            pendingWake = null;
            clearTimeout(hideTimer);
            stopSync();
            dragging = false;
            screen.hidden = true;
            enterButton.hidden = false;
            text.textContent = '';
            const old = saved;
            saved = null;
            if (old.inert === null) old.body.removeAttribute('inert');
            else old.body.setAttribute('inert', old.inert);
            if (old.attr === null) document.documentElement.removeAttribute(ACTIVE_ATTR);
            else document.documentElement.setAttribute(ACTIVE_ATTR, old.attr);
            const lock = wakeLock;
            wakeLock = null;
            if (lock) lock.release().catch(() => {});
            const restoreToken = session;
            requestAnimationFrame(() => {
                if (active || session !== restoreToken) return;
                window.scrollTo(old.x, old.y);
                old.scrolls.forEach(([el, x, y]) => el.scrollTo(x, y));
            });
        }

        enterButton.addEventListener('click', enter);
        get('exit').addEventListener('click', exit);
        get('hide').addEventListener('click', hideControls);
        size.addEventListener('input', () => {
            const range = reader.scrollHeight - reader.clientHeight;
            const ratio = range > 0 ? reader.scrollTop / range : 0;
            fontSize = Number(size.value);
            host.style.setProperty('--font-size', fontSize + 'px');
            value.textContent = fontSize + 'px';
            reader.scrollTop = ratio * (reader.scrollHeight - reader.clientHeight);
            try { localStorage.setItem(FONT_KEY, String(fontSize)); } catch (_) {}
            scheduleHide();
        });
        controls.addEventListener('pointerdown', () => {
            dragging = true;
            clearTimeout(hideTimer);
        });
        const endDrag = () => {
            dragging = false;
            scheduleHide();
        };
        window.addEventListener('pointerup', endDrag, true);
        window.addEventListener('pointercancel', endDrag, true);
        controls.addEventListener('keydown', scheduleHide);

        // 普通触摸只滚动正文。双击才显示控制条。
        let press = null, lastTap = null;
        reader.addEventListener('pointerdown', e => {
            requestWakeLock();
            press = { id: e.pointerId, x: e.clientX, y: e.clientY,
                time: performance.now(), scroll: reader.scrollTop };
        });
        reader.addEventListener('pointercancel', () => {
            press = lastTap = null;
        });
        reader.addEventListener('pointerup', e => {
            const down = press;
            press = null;
            const now = performance.now();
            if (!down || down.id !== e.pointerId || e.pointerType === 'mouse' ||
                now - down.time > 350 ||
                Math.hypot(e.clientX - down.x, e.clientY - down.y) > 16 ||
                Math.abs(reader.scrollTop - down.scroll) > 8) {
                lastTap = null;
                return;
            }
            if (lastTap && now - lastTap.time < 350 &&
                Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 32) {
                showControls();
                lastTap = null;
            } else {
                lastTap = { time: now, x: e.clientX, y: e.clientY };
            }
        });
        reader.addEventListener('dblclick', e => {
            e.preventDefault();
            showControls();
        });
        ['contextmenu', 'selectstart', 'dragstart'].forEach(type => {
            reader.addEventListener(type, e => {
                e.preventDefault();
                e.stopPropagation();
            });
        });
        ['click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu'].forEach(type => {
            shadow.addEventListener(type, e => e.stopPropagation());
        });

        // 提词模式拦截 Notion 快捷键，保留滚动和滑块按键。
        ['keydown', 'keypress', 'keyup', 'beforeinput', 'paste'].forEach(type => {
            window.addEventListener(type, e => {
                if (!active) return;
                const path = e.composedPath();
                if (path.includes(controls)) scheduleHide();
                e.stopImmediatePropagation();
                if (e.key === 'Escape') {
                    e.preventDefault();
                    exit();
                } else if (e.ctrlKey || e.metaKey || type === 'beforeinput' ||
                    type === 'paste') {
                    e.preventDefault();
                }
            }, true);
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                requestWakeLock();
                scheduleSync();
            }
        });
        window.addEventListener('focus', scheduleSync);
        window.addEventListener('resize', scheduleSync);
        window.addEventListener('pagehide', exit);
        window.addEventListener('popstate', exit);
    }
    mount();
})();
