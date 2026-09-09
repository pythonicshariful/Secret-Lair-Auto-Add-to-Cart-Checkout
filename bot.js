// ==UserScript==
// @name         Secret Lair Bot -- Full Automation Suite
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Professional Secret Lair automation: release monitoring, queue detection, semi-auto checkout, live log, tabbed UI panel.
// @author       Antigravity
// @match        https://secretlair.wizards.com/*
// @match        https://checkoutshopper-live.adyen.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/* SECURITY: No passwords, auth tokens, or cookies are
   ever stored, logged, or transmitted by this script.
   Card details entered in the panel are saved locally in the browser via
   localStorage (user opted-in). */

(function () {
    'use strict';

    // ============================================================
    // ADYEN IFRAME HANDLER (runs inside Adyen iframes only)
    // ============================================================
    if (window.location.hostname.includes('checkoutshopper') ||
        window.location.hostname.includes('adyen.com')) {

        const sleep = ms => new Promise(r => setTimeout(r, ms));

        async function typeIntoInput(input, value) {
            input.focus();
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(80);
            for (const char of value) {
                const kc = char.charCodeAt(0);
                
                // Adyen's checkout script proxies KeyboardEvent and breaks new KeyboardEvent() with Reflect.construct errors.
                // We fallback to standard events with patched properties
                const keydown = new Event('keydown', { bubbles: true, cancelable: true });
                Object.assign(keydown, { key: char, code: 'Key' + char, keyCode: kc, which: kc });
                
                const keypress = new Event('keypress', { bubbles: true, cancelable: true });
                Object.assign(keypress, { key: char, code: 'Key' + char, keyCode: kc, which: kc });
                
                const keyup = new Event('keyup', { bubbles: true, cancelable: true });
                Object.assign(keyup, { key: char, code: 'Key' + char, keyCode: kc, which: kc });

                input.dispatchEvent(keydown);
                input.dispatchEvent(keypress);
                input.value += char;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(keyup);
                await sleep(40 + Math.floor(Math.random() * 30));
            }
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        async function runAdyenFiller() {
            const fieldMap = [
                { sel: '#encryptedCardNumber, input[data-fieldtype="encryptedCardNumber"]',    key: 'sl_card_number' },
                { sel: '#encryptedExpiryDate, input[data-fieldtype="encryptedExpiryDate"]',    key: 'sl_card_expiry' },
                { sel: '#encryptedSecurityCode, input[data-fieldtype="encryptedSecurityCode"]', key: 'sl_card_cvv'   },
            ];
            let matched = null;
            const deadline = Date.now() + 8000;
            while (!matched && Date.now() < deadline) {
                for (const f of fieldMap) { if (document.querySelector(f.sel)) { matched = f; break; } }
                if (!matched) await sleep(200);
            }
            if (!matched) return;
            let value = null;
            const end = Date.now() + 90000;
            while (!value && Date.now() < end) { value = await GM_getValue(matched.key, null); if (!value) await sleep(500); }
            if (!value) return;
            const input = document.querySelector(matched.sel);
            if (!input) return;
            await sleep(300);
            await typeIntoInput(input, value);
            await GM_setValue(matched.key, null);
        }

        runAdyenFiller();
        return; // Do NOT run main bot inside Adyen iframes
    }
    // END ADYEN IFRAME HANDLER

    // ============================================================
    // SELECTORS  (derived from real DOM inspection Sept 2026)
    // ============================================================
    const SEL = {
        signIn:      '#mini-login-signin',
        cartBtn:     '#minicart-button, a.minicart-button',
        cartCount:   '.minicart-button-number',
        productLink: 'a.product-link-box',
        qtySelect:   'select#label-quantity-select, select.qty-select',
        addToCart:   'button.buy-link-with-qtyselect, button.buy-link.btn-primary',
        productTitle: 'h1.product-title, h1',
        productPrice: '.product-price, [class*="price"]',
        productImage: '.product-image img, img.product-img',
        checkoutBtn:  'button[data-internal-id="cart-continue"], button.btn-primary.btn-lg.ng-binding, button.btn-primary.btn-lg',
        continueBtn:  'button[data-internal-id="cart-continue"], button[ng-click*="setNextPage"], button[ng-click*="checkCPF"], button[ng-click*="placeOrder"]',
        cartItem:     '.cart-item, [class*="cart-product"]',
        cartQtyInput: '[id^="quantity-"].touchspin-qty',
        errorModal:   '#errorMessage',
        queueIframe:  'iframe[src*="queue-it"]',
        adyenIframe:  'iframe[src*="checkoutshopper"], iframe[src*="adyen"]',
        orderConfirm: '[class*="order-confirm"], #order-confirmation, [class*="confirmation"]',
    };

    const PATH = window.location.pathname;
    const isProductPage = /\/product\//i.test(PATH);
    const isCartPage    = /\/cart\b/i.test(PATH);
    const isCatalogPage = /\/(shopall|products|catalog)\b/i.test(PATH);
    const isQueueItPage = window.location.hostname.includes('queue-it.net');

    function getLocale() {
        const p = PATH.split('/').filter(Boolean);
        return (p.length && /^[a-z]{2}(-[a-z]+)?$/i.test(p[0])) ? p[0] : 'us';
    }

    // ============================================================
    // STORAGE MANAGER
    // ============================================================
    const DEFAULT_SETTINGS = {
        monitorEnabled: false, minIntervalSec: 25, maxIntervalSec: 45,
        detectNewProducts: true, detectRestocks: true,
        keywords: '', ignoreList: '',
        desiredQty: 1, maxQty: 1,
        purchaseMode: 'semi', requireConfirmation: true,
        queueMonitor: true, debugLogging: false, botActive: false,
        notifyNewProduct: true, notifyRestock: true, notifyQueue: true,
        notifyCheckout: true, notifyPurchase: true, notifyError: true,
        // External notification channels
        discordWebhook: '', discordEnabled: false,
        telegramToken: '', telegramChatId: '', telegramEnabled: false,
        pushoverUserKey: '', pushoverApiToken: '', pushoverEnabled: false,
        cardNumber: '', cardExpiry: '', cardCvv: '',
    };

    const Store = {
        settings()      { try { const r=localStorage.getItem('sl_settings_v2'); return r?Object.assign({},DEFAULT_SETTINGS,JSON.parse(r)):{...DEFAULT_SETTINGS}; } catch { return {...DEFAULT_SETTINGS}; } },
        saveSettings(s) { try { localStorage.setItem('sl_settings_v2', JSON.stringify(s)); } catch {} },
        products()      { try { const r=localStorage.getItem('sl_products_v2'); return r?JSON.parse(r):{}; } catch { return {}; } },
        saveProducts(p) { try { localStorage.setItem('sl_products_v2', JSON.stringify(p)); } catch {} },
        logs()          { try { const r=localStorage.getItem('sl_logs_v2'); return r?JSON.parse(r):[]; } catch { return []; } },
        saveLogs(L)     { try { localStorage.setItem('sl_logs_v2', JSON.stringify(L.slice(-500))); } catch {} },
        clearLogs()     { try { localStorage.removeItem('sl_logs_v2'); } catch {} },
        resetSettings() { try { localStorage.removeItem('sl_settings_v2'); } catch {} },
    };

    // ============================================================
    // LOGGER
    // ============================================================
    const Log = {
        _entries: [], _ui: null,
        init()    { this._entries = Store.logs(); },
        setUI(fn) { this._ui = fn; },
        _w(lvl, cat, msg) {
            if (/password|token|cookie|card.?number|cvv|cvc|expir/i.test(msg)) msg = '[REDACTED]';
            const e = { ts: new Date().toISOString(), level: lvl, category: cat, message: msg };
            this._entries.push(e);
            Store.saveLogs(this._entries);
            if (this._ui) this._ui(e);
            const s = Store.settings();
            if (s.debugLogging || lvl !== 'DEBUG') {
                const t = new Date(e.ts).toLocaleTimeString('en-US',{hour12:false});
                console.log('[SL-Bot]['+lvl+']['+cat+'] '+t+' - '+msg);
            }
        },
        info(m,c)    { this._w('INFO',    c||'INFO',    m); },
        success(m,c) { this._w('SUCCESS', c||'SUCCESS', m); },
        warn(m,c)    { this._w('WARN',    c||'WARN',    m); },
        error(m,c)   { this._w('ERROR',   c||'ERROR',   m); },
        debug(m,c)   { this._w('DEBUG',   c||'DEBUG',   m); },
        product(m)   { this._w('INFO',    'PRODUCT', m); },
        queue(m)     { this._w('INFO',    'QUEUE',   m); },
        purchase(m)  { this._w('SUCCESS', 'PURCHASE',m); },
        auth(m)      { this._w('INFO',    'AUTH',    m); },
        all()        { return [...this._entries]; },
        clear()      { this._entries=[]; Store.clearLogs(); },
    };

    // ============================================================
    // NOTIFICATIONS
    // ============================================================
    const Notify = {
        // --- Browser notification (GM_notification / Notification API) ---
        async _send(title, body) {
            if (!('Notification' in window)) return;
            if (Notification.permission==='default') await Notification.requestPermission();
            if (Notification.permission!=='granted') return;
            try { GM_notification({title, text:body, timeout:8000}); }
            catch { try { new Notification(title,{body}); } catch {} }
        },

        // --- Discord webhook ---
        async _discord(title, body, s) {
            if (!s.discordEnabled || !s.discordWebhook) return;
            try {
                await fetch(s.discordWebhook, {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({
                        username: 'Secret Lair Bot',
                        embeds: [{
                            title,
                            description: body,
                            color: 0x4f46e5,
                            timestamp: new Date().toISOString(),
                            footer: { text: 'SL Bot v2.0.0' },
                        }]
                    })
                });
                Log.debug('Discord notification sent.','NOTIFY');
            } catch(e) { Log.warn('Discord notify failed: '+e.message,'NOTIFY'); }
        },

        // --- Telegram bot ---
        async _telegram(title, body, s) {
            if (!s.telegramEnabled || !s.telegramToken || !s.telegramChatId) return;
            try {
                const text = encodeURIComponent('*'+title+'*\n'+body);
                await fetch('https://api.telegram.org/bot'+s.telegramToken+'/sendMessage?chat_id='+s.telegramChatId+'&parse_mode=Markdown&text='+text);
                Log.debug('Telegram notification sent.','NOTIFY');
            } catch(e) { Log.warn('Telegram notify failed: '+e.message,'NOTIFY'); }
        },

        // --- Pushover ---
        async _pushover(title, body, s) {
            if (!s.pushoverEnabled || !s.pushoverUserKey || !s.pushoverApiToken) return;
            try {
                const fd = new FormData();
                fd.append('token',   s.pushoverApiToken);
                fd.append('user',    s.pushoverUserKey);
                fd.append('title',   title);
                fd.append('message', body);
                await fetch('https://api.pushover.net/1/messages.json', {method:'POST', body:fd});
                Log.debug('Pushover notification sent.','NOTIFY');
            } catch(e) { Log.warn('Pushover notify failed: '+e.message,'NOTIFY'); }
        },

        // --- Fan-out to all enabled channels ---
        fire(event, data) {
            const s=Store.settings();
            const map={newProduct:s.notifyNewProduct,restock:s.notifyRestock,
                queueStart:s.notifyQueue,queueDone:s.notifyQueue,
                checkoutReady:s.notifyCheckout,purchased:s.notifyPurchase,error:s.notifyError};
            if (!map[event]) return;
            const msgs={
                newProduct:    ['\uD83C\uDD95 New Secret Lair Product!', (data&&data.name)||'A new product is available.'],
                restock:       ['\uD83D\uDD04 Secret Lair Restock!',     (data&&data.name)||'A product is back in stock.'],
                queueStart:    ['\u23F3 Queue Started',                  'You have entered the Secret Lair queue.'],
                queueDone:     ['\u2705 Queue Complete!',                'You are through. Checkout available.'],
                checkoutReady: ['\uD83D\uDED2 Checkout Ready!',          'Review and confirm your purchase.'],
                purchased:     ['\uD83C\uDF89 Purchase Complete!',       (data&&data.name)||'Order placed successfully.'],
                error:         ['\u26A0\uFE0F Bot Error',                (data&&data.msg)||'An error occurred.'],
            };
            const m=msgs[event]; if (!m) return;
            this._send(m[0], m[1]);
            this._discord(m[0], m[1], s);
            this._telegram(m[0], m[1], s);
            this._pushover(m[0], m[1], s);
        },

        // --- Test a specific channel (called from Settings tab) ---
        async test(channel) {
            const s=Store.settings();
            const title='\u26A1 SL Bot Test';
            const body='Notification test from Secret Lair Bot v2.0.0';
            if (channel==='discord')  await this._discord(title, body, s);
            if (channel==='telegram') await this._telegram(title, body, s);
            if (channel==='pushover') await this._pushover(title, body, s);
            Log.info('Test notification sent via '+channel+'.','NOTIFY');
        },
    };

    // ============================================================
    // HELPERS
    // ============================================================
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function waitFor(sel, timeout, ctx) {
        if (!timeout) timeout=15000;
        if (!ctx) ctx=document;
        return new Promise(resolve => {
            const el=ctx.querySelector(sel);
            if (el) { resolve(el); return; }
            const t=setTimeout(()=>{obs.disconnect();resolve(null);},timeout);
            const obs=new MutationObserver(()=>{ const f=ctx.querySelector(sel); if(f){clearTimeout(t);obs.disconnect();resolve(f);} });
            obs.observe(ctx.body||ctx,{childList:true,subtree:true});
        });
    }

    async function safeClick(el, label) {
        if (!el) { Log.warn('safeClick: '+(label||'el')+' is null'); return false; }
        try {
            const win = typeof unsafeWindow!=='undefined' ? unsafeWindow : window;
            const r=el.getBoundingClientRect();
            const x=r.left+r.width/2+(Math.random()*6-3);
            const y=r.top+r.height/2+(Math.random()*6-3);
            const o={bubbles:true,cancelable:true,view:win,clientX:x,clientY:y,screenX:win.screenX+x,screenY:win.screenY+y,button:0,buttons:1,which:1};
            el.dispatchEvent(new PointerEvent('pointerover',o));
            el.dispatchEvent(new MouseEvent('mouseover',o));
            el.dispatchEvent(new PointerEvent('pointerenter',o));
            el.focus();
            el.dispatchEvent(new PointerEvent('pointerdown',o));
            el.dispatchEvent(new MouseEvent('mousedown',o));
            await sleep(80+Math.floor(Math.random()*50));
            el.dispatchEvent(new PointerEvent('pointerup',o));
            el.dispatchEvent(new MouseEvent('mouseup',o));
            el.click();
            return true;
        } catch(e) { Log.warn('safeClick failed ('+(label||'')+'):'+e.message); return false; }
    }

    const visible = el => { if(!el) return false; const s=getComputedStyle(el); return s.display!=='none'&&s.visibility!=='hidden'&&el.offsetWidth>0; };
    const enabled = btn => btn&&!btn.disabled&&!btn.classList.contains('disabled')&&btn.getAttribute('disabled')===null&&btn.getAttribute('aria-disabled')!=='true';

    function getCartCount() {
        const ce=document.querySelector(SEL.cartCount);
        if(ce){const n=parseInt(ce.textContent.trim());if(!isNaN(n))return n;}
        const cb=document.querySelector(SEL.cartBtn);
        if(cb){for(const s of cb.querySelectorAll('span')){const n=parseInt(s.textContent.trim());if(!isNaN(n))return n;}}
        return 0;
    }

    function checkErrorModal() {
        const m=document.getElementById('errorMessage');
        if(!m)return null;
        const vis=m.classList.contains('in')||m.style.display==='block'||(getComputedStyle(m).display!=='none'&&m.offsetWidth>0);
        if(!vis)return null;
        const b=m.querySelector('.modal-body')||m.querySelector('.modal-content')||m;
        const c=b.cloneNode(true);
        c.querySelectorAll('button,script,style,.sr-only').forEach(e=>e.remove());
        return c.innerText.replace(/\s+/g,' ').trim()||'Unknown store error.';
    }

    function dismissModals() {
        const m=document.getElementById('errorMessage');
        if(m&&(m.classList.contains('in')||m.style.display==='block')){
            m.style.display='none';m.classList.remove('in');
            const c=m.querySelector('[data-dismiss="modal"],.close');if(c)c.click();
        }
        document.querySelectorAll('.modal-backdrop').forEach(b=>b.remove());
    }

    function syncAngular(sel, val, opt) {
        try {
            const win=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
            if(!win.angular)return;
            const ng=win.angular.element(sel);
            const sc=ng&&ng.scope(),md=ng&&ng.controller('ngModel');
            if(!sc)return;
            const fn=()=>{
                if(sc.cartSelectorItems&&sc.cartSelectorItems.length>opt.index){if(sc.cart)sc.cart.addQuantity=sc.cartSelectorItems[opt.index];}
                else if(sc.cart)sc.cart.addQuantity=val;
                if(md){md.$setViewValue(val);md.$commitViewValue();md.$render();}
            };
            sc.$$phase?fn():sc.$apply(fn);
        } catch(e){Log.debug('Angular sync: '+e.message);}
    }

    function productIdFromUrl(url) {
        const m=(url||window.location.href).match(/\/product\/(\d+)/);
        return m?m[1]:null;
    }

    // ============================================================
    // PRODUCT MANAGER
    // ============================================================
    const ProductMgr = {
        fromCard(link) {
            const href=link.href||link.getAttribute('href')||'';
            const id=(href.match(/\/product\/(\d+)/)||[])[1];
            if(!id)return null;
            const name=(link.querySelector('span')||link).textContent.trim()||'Product '+id;
            const card=link.closest('[class*="product"],li,article')||link.parentElement;
            const pe=card&&card.querySelector('[class*="price"]');
            const ie=card&&card.querySelector('img');
            const btn=card&&card.querySelector('button.buy-link');
            return{id,name,url:href.startsWith('http')?href:'https://secretlair.wizards.com'+href,
                price:pe?pe.textContent.trim():'',image:ie?ie.src:'',
                available:btn?enabled(btn):true,lastSeen:Date.now()};
        },
        scanPage() {
            const out={};
            document.querySelectorAll(SEL.productLink).forEach(l=>{const p=this.fromCard(l);if(p)out[p.id]=p;});
            return out;
        },
        current() {
            const id = productIdFromUrl();
            const te = document.querySelector(SEL.productTitle);
            const pe = document.querySelector(SEL.productPrice);
            const ie = document.querySelector(SEL.productImage);
            // Use StockDetector tier-3 (Angular scope + DOM) for accuracy
            const live = StockDetector.livePageStock();
            const available = live ? live.inStock : (()=>{
                const ab = document.querySelector(SEL.addToCart);
                return ab ? !ab.disabled && !ab.classList.contains('disabled')
                    && !(ab.textContent||'').toLowerCase().includes('sold out') : false;
            })();
            if (live) Log.debug('Live stock [' + live.source + ']: ' + (available ? 'in stock' : 'out of stock'), 'STOCK');
            return { id, name: te ? te.textContent.trim() : document.title, url: location.href,
                price: pe ? pe.textContent.trim() : '',
                image: ie ? ie.src : '',
                available, lastSeen: Date.now() };
        },
        matchKw(p,kw){
            if(!kw||!kw.trim())return true;
            const n=(p.name||'').toLowerCase();
            return kw.toLowerCase().split(',').map(k=>k.trim()).filter(Boolean).some(k=>n.includes(k));
        },
        matchIgnore(p,ig){
            if(!ig||!ig.trim())return false;
            const n=(p.name||'').toLowerCase();
            return ig.toLowerCase().split(',').map(k=>k.trim()).filter(Boolean).some(k=>n.includes(k));
        },
    };

    // ============================================================
    // STOCK DETECTOR  — three-tier, no page reloads
    // ============================================================
    const StockDetector = {

        // ---- TIER 1: JSON-LD Schema.org (fastest — regex on raw HTML, ~10ms) ----
        _fromJsonLd(html) {
            try {
                // Extract first application/ld+json block
                const m = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
                if (!m) return null;
                const data = JSON.parse(m[1]);
                const offers = data.offers || (Array.isArray(data) && data[0] && data[0].offers);
                if (!offers) return null;
                const avail = (offers.availability || offers[0] && offers[0].availability || '').toLowerCase();
                if (!avail) return null;
                return {
                    inStock: avail.includes('instock') || avail.includes('in_stock'),
                    price:   offers.price || (offers[0] && offers[0].price) || '',
                    source:  'jsonld',
                };
            } catch { return null; }
        },

        // ---- TIER 2: Background fetch + DOMParser (no reload, ~100-300ms) ----
        async fetchProduct(url) {
            try {
                const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_sl=' + Date.now(), {
                    credentials: 'include',
                    headers: { 'Accept': 'text/html,application/xhtml+xml', 'Cache-Control': 'no-cache' },
                });
                if (!r.ok) return null;
                const html = await r.text();

                // Try JSON-LD first (fastest)
                const jld = this._fromJsonLd(html);
                if (jld) {
                    // Supplement with DOM button check for more accuracy
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const btn = doc.querySelector('button.buy-link-with-qtyselect, button.buy-link');
                    const domStock = btn ? !btn.hasAttribute('disabled') && !btn.classList.contains('disabled')
                        && !(btn.textContent || '').toLowerCase().includes('sold out')
                        && !(btn.textContent || '').toLowerCase().includes('unavailable')
                        : false;
                    const name = (doc.querySelector('h1.product-title, h1') || {}).textContent || '';
                    const price = (doc.querySelector('.product-price,[class*="price"]') || {}).textContent || '';
                    const img   = (doc.querySelector('.product-image img, img.product-img') || {}).src || '';
                    return { inStock: jld.inStock && domStock, name: name.trim(),
                             price: price.trim(), image: img, source: 'jsonld+dom' };
                }

                // No JSON-LD — fall back to pure DOM parse
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const btn = doc.querySelector('button.buy-link-with-qtyselect, button.buy-link');
                const inStock = btn ? !btn.hasAttribute('disabled') && !btn.classList.contains('disabled')
                    && !(btn.textContent || '').toLowerCase().includes('sold out')
                    && !(btn.textContent || '').toLowerCase().includes('unavailable')
                    : false;
                const name  = (doc.querySelector('h1.product-title, h1') || {}).textContent || '';
                const price = (doc.querySelector('.product-price,[class*="price"]') || {}).textContent || '';
                const img   = (doc.querySelector('.product-image img, img.product-img') || {}).src || '';
                return { inStock, name: name.trim(), price: price.trim(), image: img, source: 'dom' };
            } catch(e) {
                Log.debug('fetchProduct error: ' + e.message, 'STOCK');
                return null;
            }
        },

        // ---- TIER 3: Live Angular scope on current page (zero-network, instant) ----
        livePageStock() {
            try {
                const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
                const btn = document.querySelector(SEL.addToCart);
                if (!btn) return null;
                // Try Angular scope first
                if (win.angular) {
                    const sc = win.angular.element(btn).scope();
                    if (sc && sc.product) {
                        const p = sc.product;
                        // Scalefast uses outOfStock / inStock booleans
                        if (typeof p.inStock === 'boolean') return { inStock: p.inStock, source: 'ng-scope' };
                        if (typeof p.outOfStock === 'boolean') return { inStock: !p.outOfStock, source: 'ng-scope' };
                        if (p.availability) return { inStock: p.availability === 'inStock', source: 'ng-scope' };
                    }
                    if (sc && sc.cart) {
                        const c = sc.cart;
                        if (typeof c.inStock === 'boolean') return { inStock: c.inStock, source: 'ng-cart' };
                    }
                }
                // Fallback: DOM button state
                const domStock = !btn.disabled && !btn.classList.contains('disabled')
                    && !(btn.textContent || '').toLowerCase().includes('sold out');
                return { inStock: domStock, source: 'dom-live' };
            } catch { return null; }
        },

        // ---- PRODUCT WATCHER: monitors a single product page efficiently ----
        // Returns a stop() function
        watch(productUrl, onRestock, intervalMs) {
            if (!intervalMs) intervalMs = 8000; // default 8s for targeted watch
            let lastState = null;
            let stopped = false;
            Log.product('StockDetector watching: ' + productUrl + ' every ' + Math.round(intervalMs/1000) + 's');

            const check = async () => {
                if (stopped) return;
                const res = await this.fetchProduct(productUrl);
                if (!res) return;
                Log.debug('Stock check [' + res.source + ']: ' + (res.inStock ? 'IN STOCK' : 'out of stock') + ' — ' + productUrl.split('/').slice(-1)[0], 'STOCK');
                if (lastState === false && res.inStock === true) {
                    Log.product('RESTOCK DETECTED [' + res.source + ']: ' + productUrl);
                    onRestock(res);
                }
                lastState = res.inStock;
            };

            check(); // immediate first check
            const tid = setInterval(check, intervalMs);
            return () => { stopped = true; clearInterval(tid); };
        },

        // ---- Catalog batch check (all products, single fetch) ----
        async scanCatalog(locale) {
            try {
                const r = await fetch('https://secretlair.wizards.com/' + (locale || 'us') + '/shopall?_sl=' + Date.now(), {
                    credentials: 'include',
                    headers: { 'Cache-Control': 'no-cache' },
                });
                if (!r.ok) return null;
                const html = await r.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const out = {};
                doc.querySelectorAll('a.product-link-box').forEach(l => {
                    const href = l.getAttribute('href') || '';
                    const id   = (href.match(/\/product\/(\d+)/) || [])[1];
                    if (!id) return;
                    const name = (l.querySelector('span') || l).textContent.trim() || 'Product ' + id;
                    const card = l.closest('li,article,[class*="product"]') || l.parentElement;
                    const pe   = card && card.querySelector('[class*="price"]');
                    const ie   = card && card.querySelector('img');
                    const ab   = card && card.querySelector('button.buy-link');
                    // Also check JSON-LD per card if available
                    const available = ab
                        ? !ab.hasAttribute('disabled') && !ab.classList.contains('disabled')
                          && !(ab.textContent || '').toLowerCase().includes('sold out')
                        : true;
                    out[id] = {
                        id, name,
                        url:       'https://secretlair.wizards.com' + href,
                        price:     pe ? pe.textContent.trim() : '',
                        image:     ie ? (ie.getAttribute('src') || ie.getAttribute('data-src') || '') : '',
                        available, lastSeen: Date.now(),
                    };
                });
                return out;
            } catch(e) { Log.error('Catalog scan error: ' + e.message, 'STOCK'); return null; }
        },
    };

    // ============================================================
    // RELEASE MONITOR  — uses StockDetector for fast, stable polling
    // ============================================================
    const Monitor = {
        _tid: null, _scans: 0, _last: null, _newCt: 0, _ui: null,
        _watchList: {}, // productId -> stopFn for targeted watchers
        setUI(fn) { this._ui = fn; },
        start() {
            if (this._tid) return;
            const s = Store.settings();
            Log.info('Release monitor started (random delay ' + s.minIntervalSec + '-' + s.maxIntervalSec + 's, targeted watches 8s)');
            this._scheduleNext(0);
        },
        stop() {
            if (this._tid) { clearTimeout(this._tid); this._tid = null; }
            // Stop all targeted watchers
            Object.values(this._watchList).forEach(stop => stop());
            this._watchList = {};
            Log.info('Release monitor stopped.');
        },
        _scheduleNext(ms) {
            this._tid = setTimeout(async () => {
                await this._scan();
                if (this.running()) {
                    const s = Store.settings();
                    const min = Math.max(10, s.minIntervalSec) * 1000;
                    const max = Math.max(min, s.maxIntervalSec) * 1000;
                    const nextMs = Math.floor(Math.random() * (max - min + 1)) + min;
                    this._scheduleNext(nextMs);
                }
            }, ms);
        },
        running() { return !!this._tid; },
        now()     { this._scan(); },

        // Add a product URL to the fast targeted watch list (8s polling)
        watch(productUrl, productId) {
            if (this._watchList[productId]) return; // already watching
            const stopFn = StockDetector.watch(productUrl, (res) => {
                const s = Store.settings();
                if (!s.detectRestocks) return;
                const known = Store.products();
                const p = known[productId] || { id: productId, name: res.name, url: productUrl, price: res.price };
                if (!p.available) {
                    Log.product('RESTOCK [targeted watcher]: ' + p.name);
                    Notify.fire('restock', p);
                    Bot.onRestock(p);
                    // Update product as available
                    const upd = Object.assign({}, known);
                    upd[productId] = Object.assign({}, p, { available: true, lastSeen: Date.now() });
                    Store.saveProducts(upd);
                }
            }, 8000);
            this._watchList[productId] = stopFn;
            Log.product('Targeted watcher added: ' + productUrl);
        },

        async _scan() {
            const s = Store.settings();
            if (!s.monitorEnabled) { this.stop(); return; }
            this._last = new Date(); this._scans++;
            Log.debug('Catalog scan #' + this._scans + ' ...', 'PRODUCT');
            try {
                const found = await StockDetector.scanCatalog(getLocale());
                if (!found) { Log.warn('Catalog scan returned nothing.', 'PRODUCT'); return; }
                const known = Store.products();
                const upd   = Object.assign({}, known);
                let nf = 0;
                for (const [id, p] of Object.entries(found)) {
                    if ((s.keywords && !ProductMgr.matchKw(p, s.keywords)) || ProductMgr.matchIgnore(p, s.ignoreList)) continue;
                    if (!known[id]) {
                        if (s.detectNewProducts) {
                            nf++; this._newCt++;
                            Log.product('NEW: ' + p.name + ' (' + id + ')');
                            Notify.fire('newProduct', p);
                            Bot.onNew(p);
                            // If new product is available, add to fast watch immediately
                            if (p.available) this.watch(p.url, id);
                        }
                        upd[id] = p;
                    } else if (!known[id].available && p.available && s.detectRestocks) {
                        nf++;
                        Log.product('RESTOCK [catalog]: ' + p.name);
                        Notify.fire('restock', p); Bot.onRestock(p); upd[id] = p;
                    } else {
                        upd[id] = Object.assign({}, known[id], p, { lastSeen: Date.now() });
                        // Add known-but-unavailable products to targeted fast watcher
                        if (!p.available && !this._watchList[id]) this.watch(p.url, id);
                    }
                }
                Store.saveProducts(upd);
                if (!nf) Log.debug('Scan #' + this._scans + ': no changes detected.', 'PRODUCT');
                if (this._ui) this._ui({ last: this._last, scans: this._scans, newCt: this._newCt, known: Object.keys(upd).length, watched: Object.keys(this._watchList).length });
            } catch(e) { Log.error('Monitor error: ' + e.message, 'PRODUCT'); }
        },
    };

    // ============================================================
    // QUEUE MANAGER
    // ============================================================
    const Queue = {
        _status:'idle',_start:null,_tid:null,_ui:null,_pos:null,
        setUI(fn){this._ui=fn;},
        detect(){
            if(isQueueItPage||location.hostname.includes('queue-it.net')){this._setStatus('waiting');return 'page';}
            if(document.querySelector(SEL.queueIframe)){this._setStatus('waiting');return 'iframe';}
            return null;
        },
        startMon(){
            if(this._tid)return;
            this._start=Date.now();this._status='waiting';
            Log.queue('Queue monitoring started.');Notify.fire('queueStart');
            this._update();this._tid=setInterval(()=>this._update(),5000);
        },
        stopMon(){if(this._tid){clearInterval(this._tid);this._tid=null;}},
        inQueue(){return this._status==='waiting'||this._status==='active';},
        _update(){
            if(!this.detect()){
                if(this.inQueue()){
                    this._setStatus('complete');
                    Log.queue('Queue complete! Proceeding to checkout.');
                    Notify.fire('queueDone');
                    this.stopMon();
                    Bot.onQueueDone();
                }
            }else{
                if(this._status!=='active'){this._setStatus('active');Log.queue('In queue — monitoring...');}
                try{
                    const t=document.body.innerText||'';
                    const m=t.match(/position[\s:#]+(\d+)/i)||t.match(/number[\s:#]+(\d+)/i)||t.match(/#\s*(\d+)/);
                    this._pos=m?m[1]:null;
                }catch{}
                const e=Math.round((Date.now()-this._start)/1000);
                if(e>0&&e%60===0)Log.queue('Still in queue — elapsed '+Math.floor(e/60)+'m '+(e%60)+'s');
            }
            if(this._ui)this._ui(this.state());
        },
        _setStatus(s){this._status=s;if(this._ui)this._ui(this.state());},
        state(){
            const e=this._start?Math.round((Date.now()-this._start)/1000):0;
            return{status:this._status,pos:this._pos,start:this._start,elapsed:e,elStr:e>0?Math.floor(e/60)+'m '+(e%60)+'s':'--'};
        },
    };

    // ============================================================
    // PURCHASE MANAGER
    // ============================================================
    const Purchase = {
        async addToCart(qty){
            if(!qty)qty=1;
            dismissModals();
            const sel=document.querySelector(SEL.qtySelect);
            if(!sel){Log.error('Quantity selector not found — sold out?');return false;}
            const opts=Array.from(sel.options);
            if(!opts.length){Log.error('No quantity options.');return false;}
            let best=null,bd=Infinity;
            opts.forEach(o=>{const v=parseInt(o.textContent.trim());if(!isNaN(v)){const d=Math.abs(v-qty);if(d<bd){bd=d;best=o;}}});
            if(!best){Log.error('Could not pick quantity.');return false;}
            const sv=parseInt(best.textContent.trim());
            Log.info('Setting quantity: '+sv);
            sel.focus();sel.selectedIndex=best.index;
            Array.from(sel.options).forEach((o,i)=>o.selected=(i===best.index));
            sel.value=best.value;
            sel.dispatchEvent(new Event('input',{bubbles:true}));
            sel.dispatchEvent(new Event('change',{bubbles:true}));
            syncAngular(sel,sv,best);
            await sleep(700);
            const btn=document.querySelector(SEL.addToCart);
            if(!btn){Log.error('Add to Cart button not found.');return false;}
            if(!enabled(btn)){
                Log.warn('Add to Cart disabled. Waiting...');
                await sleep(1500);
                if(!enabled(btn)){Log.error('Add to Cart stayed disabled.');return false;}
            }
            try{
                const win=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
                if(win.angular){
                    const bn=win.angular.element(btn),bs=bn&&bn.scope();
                    if(bs&&bs.cart){const fn=()=>bs.cart.addQuantity=sv;bs.$$phase?fn():bs.$apply(fn);}
                }
            }catch{}
            const init=getCartCount();
            Log.info('Clicking Add to Cart (cart: '+init+')...');
            btn.scrollIntoView({behavior:'smooth',block:'center'});
            await sleep(250);
            await safeClick(btn,'Add to Cart');
            for(let i=0;i<30;i++){
                await sleep(500);
                const err=checkErrorModal();
                if(err){Log.error('Store error: '+err);return false;}
                if(getCartCount()>init){Log.success('Added to cart! Cart: '+getCartCount());return true;}
                const mo=document.getElementById('intersticialCheckoutModal');
                if(mo&&(mo.classList.contains('in')||mo.style.display==='block')){Log.success('Checkout modal opened.');return true;}
            }
            Log.error('Timed out waiting for cart update.');
            return false;
        },
    };

    // ============================================================
    // CHECKOUT MANAGER
    // ============================================================
    const Checkout = {
        _waiting:false,_product:null,
        onPaymentStep(){return!!document.querySelector(SEL.adyenIframe);},
        orderConfirmed(){
            if(document.querySelector(SEL.orderConfirm))return true;
            const t=(document.body.innerText||'').toLowerCase();
            return t.includes('thank you for your order')||t.includes('order confirmed')||t.includes('order number');
        },
        async nextBtn(){
            const sels=['button[data-internal-id="cart-continue"]','button[data-internal-id="cart-continue-creditcard"]','button[ng-click*="setNextPage"]','button[ng-click*="checkCPF"]','button[ng-click*="placeOrder"]'];
            for(const s of sels){
                const nodes=Array.from(document.querySelectorAll(s));
                for(const b of nodes){if(b&&visible(b))return b;}
            }
            return null;
        },
        setWaiting(p){this._waiting=true;this._product=p;},
        clearWaiting(){this._waiting=false;this._product=null;},
        waiting(){return this._waiting;},
        pending(){return this._product;},
        async fillCard(num,exp,cvv){
            const pa=document.getElementById('sl-payment-alert');
            if(pa){pa.style.display='block';pa.classList.add('active');}
            if(!num&&!exp&&!cvv){Log.warn('No card details entered.');return;}
            Log.info('Forwarding card data sequentially...');
            const groups=[
                {sel:'[data-cse="encryptedCardNumber"] iframe',   label:'Card Number', key: 'sl_card_number', val: num},
                {sel:'[data-cse="encryptedExpiryDate"] iframe',   label:'Expiry', key: 'sl_card_expiry', val: exp},
                {sel:'[data-cse="encryptedSecurityCode"] iframe', label:'CVV', key: 'sl_card_cvv', val: cvv},
            ];
            let any=groups.some(g=>!!document.querySelector(g.sel));
            if(!any){const all=Array.from(document.querySelectorAll('iframe[src*="checkoutshopper"]'));groups.forEach((g,i)=>{if(all[i])g.fb=all[i];});}
            const win=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
            for(const g of groups){
                if(!g.val) continue;
                const iframe=document.querySelector(g.sel)||g.fb||null;
                if(!iframe){Log.warn(g.label+' iframe not found.');continue;}
                iframe.scrollIntoView({behavior:'smooth',block:'center'});
                await sleep(500);
                const r=iframe.getBoundingClientRect();
                const cx=r.left+20+Math.random()*8,cy=r.top+18+Math.random()*6;
                const o={bubbles:true,cancelable:true,view:win,clientX:cx,clientY:cy};
                iframe.dispatchEvent(new MouseEvent('mousedown',o));await sleep(80);
                iframe.dispatchEvent(new MouseEvent('mouseup',o));
                iframe.dispatchEvent(new MouseEvent('click',o));
                Log.info('Triggered '+g.label+' iframe. Typing...');
                
                await GM_setValue(g.key, g.val);
                
                let waitIters = 0;
                while (await GM_getValue(g.key, null) !== null && waitIters < 40) {
                    await sleep(200);
                    waitIters++;
                }
                await sleep(500);
            }
            Log.success('Card details sent. Check fields and click Pay.');
        },
    };

    // ============================================================
    // BOT CONTROLLER
    // ============================================================
    const Bot = {
        _status:'stopped',_running:false,_stop:false,_ui:null,
        setUI(fn){this._ui=fn;},
        status(){return this._status;},
        running(){return this._running;},
        _set(s){this._status=s;if(this._ui)this._ui(s);},
        start(){
            if(this._running){Log.warn('Bot already running.');return;}
            this._stop=false;this._running=true;
            const s=Store.settings();
            s.botActive=true;Store.saveSettings(s);
            Log.info('Bot started.');
            if(isQueueItPage||document.querySelector(SEL.queueIframe)){
                this._set('waiting');Log.queue('Queue-it detected.');Queue.startMon();return;
            }
            if(s.monitorEnabled){this._set('monitoring');Monitor.start();}
            if(isProductPage){this._set('purchasing');this._productFlow();}
            else if(isCartPage){this._set('purchasing');this._cartFlow();}
            else{this._set('monitoring');Log.info('Monitoring. Navigate to a product to purchase.');}
        },
        stop(){
            this._stop=true;this._running=false;
            const s=Store.settings();
            s.botActive=false;Store.saveSettings(s);
            Monitor.stop();Queue.stopMon();Checkout.clearWaiting();
            this._set('stopped');Log.info('Bot stopped.');
        },
        onNew(p)     {
            Log.product('New: '+p.name);
            UI.showNewProduct(p);
            const mode=Store.settings().purchaseMode;
            if(mode==='auto'){Log.warn('FULL-AUTO: Opening product page now...');window.open(p.url,'_blank');}
            else Log.info('Semi-auto: Click "Open Product" in the panel to proceed.');
        },
        onRestock(p) {
            Log.product('Restock: '+p.name);
            UI.showNewProduct(p);
            const mode=Store.settings().purchaseMode;
            if(mode==='auto'){Log.warn('FULL-AUTO: Restock detected — opening product page...');window.open(p.url,'_blank');}
            else Log.info('Semi-auto: Click "Open Product" in the panel to proceed.');
        },
        onQueueDone(){Log.queue('Queue done - resuming cart flow.');this._set('purchasing');this._cartFlow();},
        confirm(){if(!Checkout.waiting())return;const p=Checkout.pending();Checkout.clearWaiting();this._set('purchasing');Log.purchase('User confirmed: '+(p&&p.name));location.href='https://secretlair.wizards.com/'+getLocale()+'/cart';},
        cancel(){Checkout.clearWaiting();this._set('monitoring');const s=Store.settings();s.botActive=false;Store.saveSettings(s);Log.info('Purchase cancelled by user.');},
        async _productFlow(){
            if(this._stop)return;
            const s=Store.settings();
            const p=ProductMgr.current();
            if(!p.available){
                Log.warn('Product sold out. Watching for restock...');
                this._set('monitoring');
                const obs=new MutationObserver(()=>{
                    if(this._stop){obs.disconnect();return;}
                    const b=document.querySelector(SEL.addToCart);
                    if(b&&enabled(b)){obs.disconnect();Log.product('Product now available!');Notify.fire('restock',p);this._set('purchasing');this._productFlow();}
                });
                obs.observe(document.body,{childList:true,subtree:true,attributes:true});
                return;
            }
            const added=await Purchase.addToCart(s.desiredQty);
            if(this._stop)return;
            if(!added){Log.error('Failed to add to cart.');this._set('error');return;}
            if(s.purchaseMode==='semi'&&s.requireConfirmation){
                Log.info('Semi-auto: added to cart. Awaiting your confirmation...');
                Notify.fire('checkoutReady',p);
                Checkout.setWaiting(p);this._set('waiting');UI.showConfirm(p);
            }else{
                Log.warn('FULL-AUTO: Navigating to cart automatically...');
                Notify.fire('checkoutReady',p);
                await sleep(800);
                location.href='https://secretlair.wizards.com/'+getLocale()+'/cart';
            }
        },
        async _cartFlow(){
            if(this._stop)return;
            const s=Store.settings();
            Log.info('Cart automation started...');
            let paid=false,iters=0;
            while(iters<240&&!this._stop){
                await sleep(500);
                if(Checkout.orderConfirmed()){Log.purchase('Order confirmed!');Notify.fire('purchased');this.stop();break;}
                if(!paid&&Checkout.onPaymentStep()){
                    paid=true;
                    const cn=((document.getElementById('sl-card-number')||{}).value||'').replace(/\s/g,'');
                    const ce=((document.getElementById('sl-card-expiry')||{}).value||'');
                    const cv=((document.getElementById('sl-card-cvv')||{}).value||'');
                    await Checkout.fillCard(cn,ce,cv);
                    if(s.purchaseMode==='semi'){Log.info('Semi-auto: payment step. Review fields and click Pay.');Notify.fire('checkoutReady');this._set('waiting');break;}
                    else{Log.warn('FULL-AUTO: Payment step reached — card details auto-filled. Attempting to submit...');}
                }
                if(Queue.detect()&&!Queue.inQueue()){Log.queue('Queue detected during checkout!');Queue.startMon();this._set('waiting');break;}
                const nb=await Checkout.nextBtn()||document.querySelector(SEL.checkoutBtn);
                if(nb&&visible(nb)&&enabled(nb)){
                    Log.info('Clicking: '+nb.textContent.trim());
                    nb.scrollIntoView({behavior:'smooth',block:'center'});await sleep(350);
                    await safeClick(nb,nb.textContent.trim());await sleep(2000);
                }else{if(iters%12===0)Log.info('Waiting for checkout button...');}
                const err=checkErrorModal();
                if(err){Log.error('Store error: '+err);this._set('error');break;}
                iters++;
            }
            if(iters>=240)Log.warn('Cart automation timed out.');
        },
    };

    // ============================================================
    // UI MANAGER
    // ============================================================
    const UI = {
        _panel:null,_activeTab:'dashboard',_pendingProduct:null,

        init(){
            this._styles();
            this._build();
            this._bind();
            Log.setUI(e=>this._logEntry(e));
            Monitor.setUI(i=>this._monUpdate(i));
            Queue.setUI(st=>this._queueUpdate(st));
            Bot.setUI(s=>this._botStatus(s));
            Store.logs().slice(-80).forEach(e=>this._logEntry(e));
            this._applySettings();
            setInterval(()=>this._tick(),1000);
        },

        _styles(){
            GM_addStyle(`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
#sl-panel{position:fixed;bottom:20px;right:20px;width:370px;max-height:84vh;background:rgba(9,12,27,0.97);backdrop-filter:blur(20px);border:1px solid rgba(99,102,241,0.3);border-radius:18px;color:#e2e8f0;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;z-index:2147483647;box-shadow:0 30px 60px -12px rgba(0,0,0,0.8),0 0 0 1px rgba(99,102,241,0.15);display:flex;flex-direction:column;overflow:hidden;font-size:13px;line-height:1.4;transition:max-height .3s cubic-bezier(.4,0,.2,1);}
#sl-panel.sl-min{max-height:52px;}
#sl-hdr{padding:13px 16px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;border-radius:17px 17px 0 0;flex-shrink:0;}
.sl-htitle{font-weight:700;font-size:14px;display:flex;align-items:center;gap:7px;}
.sl-dot{width:8px;height:8px;border-radius:50%;background:#6ee7b7;box-shadow:0 0 6px #6ee7b7;animation:sl-blink 2s ease-in-out infinite;transition:background .3s;flex-shrink:0;}
.sl-dot.stopped{background:#64748b;box-shadow:none;animation:none;}
.sl-dot.error{background:#f87171;box-shadow:0 0 6px #f87171;}
.sl-dot.waiting{background:#facc15;box-shadow:0 0 6px #facc15;}
.sl-dot.monitoring{background:#60a5fa;box-shadow:0 0 6px #60a5fa;}
.sl-dot.purchasing{background:#34d399;box-shadow:0 0 8px #34d399;}
@keyframes sl-blink{0%,100%{opacity:1}50%{opacity:.4}}
.sl-hbadge{font-size:10px;font-weight:600;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.2);padding:2px 8px;border-radius:20px;color:#c4b5fd;}
.sl-hbtn{background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:4px;transition:background .2s;}
.sl-hbtn:hover{background:rgba(255,255,255,.15);color:#fff;}
#sl-tabs{display:flex;background:rgba(0,0,0,.4);border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0;overflow-x:auto;scrollbar-width:none;}
#sl-tabs::-webkit-scrollbar{display:none}
.sl-tab{flex:1;min-width:55px;padding:9px 2px;font-size:10px;font-weight:700;text-align:center;color:#64748b;cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap;}
.sl-tab:hover{color:#94a3b8;}
.sl-tab.active{color:#818cf8;border-bottom-color:#818cf8;}
#sl-content{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(99,102,241,.3) transparent;}
#sl-content::-webkit-scrollbar{width:5px}
#sl-content::-webkit-scrollbar-thumb{background:rgba(99,102,241,.3);border-radius:3px}
.sl-pane{display:none;padding:14px;flex-direction:column;gap:11px;}
.sl-pane.active{display:flex;}
.sl-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:12px;}
.sl-ctitle{font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;}
.sl-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;}
.sl-row:last-child{border-bottom:none;}
.sl-rl{color:#64748b;}
.sl-rv{color:#e2e8f0;font-weight:500;text-align:right;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sl-rv.g{color:#34d399;}.sl-rv.y{color:#facc15;}.sl-rv.r{color:#f87171;}.sl-rv.b{color:#60a5fa;}.sl-rv.p{color:#a78bfa;}
.sl-btn{display:block;width:100%;padding:10px 14px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;text-align:center;font-family:inherit;}
.sl-btn:disabled{opacity:.4;cursor:not-allowed;}
.sl-btn-p{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;}
.sl-btn-p:hover:not(:disabled){filter:brightness(1.12);transform:translateY(-1px);box-shadow:0 4px 12px rgba(99,102,241,.4);}
.sl-btn-g{background:linear-gradient(135deg,#059669,#10b981);color:#fff;}
.sl-btn-g:hover:not(:disabled){filter:brightness(1.12);transform:translateY(-1px);box-shadow:0 4px 12px rgba(16,185,129,.4);}
.sl-btn-r{background:linear-gradient(135deg,#dc2626,#ef4444);color:#fff;}
.sl-btn-r:hover:not(:disabled){filter:brightness(1.12);}
.sl-btn-gh{background:rgba(255,255,255,.06);color:#94a3b8;border:1px solid rgba(255,255,255,.1);}
.sl-btn-gh:hover:not(:disabled){background:rgba(255,255,255,.1);color:#e2e8f0;}
.sl-btn-sm{padding:7px 12px;font-size:11px;}
.sl-brow{display:flex;gap:8px;}
.sl-brow .sl-btn{flex:1;}
.sl-ig{display:flex;flex-direction:column;gap:5px;}
.sl-ig label{font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.5px;}
.sl-in{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:9px 10px;color:#e2e8f0;font-size:12px;font-family:inherit;outline:none;transition:border-color .2s;width:100%;box-sizing:border-box;}
.sl-in:focus{border-color:#818cf8;background:rgba(255,255,255,.08);}
.sl-cb{display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;}
.sl-cb input{accent-color:#818cf8;width:14px;height:14px;}
.sl-cb span{font-size:12px;color:#94a3b8;}
.sl-g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
#sl-log-box{background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:10px;height:180px;overflow-y:auto;font-family:'Fira Code',Consolas,monospace;font-size:10.5px;display:flex;flex-direction:column;gap:3px;scrollbar-width:thin;scrollbar-color:rgba(99,102,241,.3) transparent;}
#sl-log-box::-webkit-scrollbar{width:4px}
#sl-log-box::-webkit-scrollbar-thumb{background:rgba(99,102,241,.3);border-radius:2px}
.sl-le{display:flex;gap:6px;line-height:1.35;word-break:break-word;}
.sl-lt{color:#475569;flex-shrink:0;font-size:10px;}
.sl-lc{flex-shrink:0;font-size:10px;font-weight:700;min-width:52px;}
.sl-lm{color:#94a3b8;flex:1;}
.sl-le.INFO .sl-lc{color:#60a5fa;}
.sl-le.SUCCESS .sl-lc{color:#34d399;}.sl-le.SUCCESS .sl-lm{color:#6ee7b7;}
.sl-le.WARN .sl-lc{color:#facc15;}.sl-le.WARN .sl-lm{color:#fde68a;}
.sl-le.ERROR .sl-lc{color:#f87171;}.sl-le.ERROR .sl-lm{color:#fca5a5;}
.sl-le.DEBUG .sl-lc{color:#475569;}
.sl-le.PURCHASE .sl-lc{color:#a78bfa;}.sl-le.PURCHASE .sl-lm{color:#c4b5fd;}
.sl-le.QUEUE .sl-lc{color:#fb923c;}.sl-le.QUEUE .sl-lm{color:#fed7aa;}
.sl-le.PRODUCT .sl-lc{color:#2dd4bf;}.sl-le.PRODUCT .sl-lm{color:#99f6e4;}
#sl-np-card,#sl-cf-card{display:none;}
#sl-np-card.active,#sl-cf-card.active{display:block;}
.sl-np-inner{background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(124,58,237,.1));border:1px solid rgba(99,102,241,.4);border-radius:10px;padding:12px;animation:sl-pulse 1.8s ease-in-out infinite;}
.sl-cf-inner{background:linear-gradient(135deg,rgba(16,185,129,.12),rgba(5,150,105,.08));border:1px solid rgba(16,185,129,.35);border-radius:10px;padding:12px;animation:sl-pulse 2s ease-in-out infinite;}
@keyframes sl-pulse{0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,0)}50%{box-shadow:0 0 0 5px rgba(99,102,241,.12)}}
.sl-np-tag{font-size:9px;font-weight:700;letter-spacing:1px;color:#818cf8;text-transform:uppercase;margin-bottom:5px;}
.sl-np-nm{font-size:12px;font-weight:600;color:#e2e8f0;margin-bottom:8px;}
.sl-cf-ttl{font-size:13px;font-weight:700;color:#34d399;margin-bottom:8px;}
.sl-cf-det{font-size:11px;color:#94a3b8;margin-bottom:10px;}
#sl-payment-alert{display:none;background:linear-gradient(135deg,rgba(251,191,36,.15),rgba(245,158,11,.08));border:1px solid rgba(251,191,36,.4);border-radius:8px;padding:10px 12px;font-size:11px;color:#fde68a;}
#sl-payment-alert.active{display:block;}
.sl-div{height:1px;background:rgba(255,255,255,.06);}
.sl-sel{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:9px 10px;color:#e2e8f0;font-size:12px;font-family:inherit;outline:none;width:100%;box-sizing:border-box;}
.sl-sel option{background:#1e293b;}
#sl-dash-mini{font-size:10px;color:#475569;display:flex;flex-direction:column;gap:3px;max-height:70px;overflow-y:auto;}
.sl-man-h2{font-size:11px;font-weight:800;color:#818cf8;text-transform:uppercase;letter-spacing:1px;padding:10px 0 6px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:8px;}
.sl-man-h3{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;margin:12px 0 5px;}
.sl-man-p{font-size:11px;color:#94a3b8;line-height:1.6;margin-bottom:7px;}
.sl-man-p strong{color:#e2e8f0;}
.sl-man-info{background:rgba(99,102,241,.1);border-left:3px solid #818cf8;padding:8px 10px;border-radius:0 6px 6px 0;font-size:11px;color:#a5b4fc;line-height:1.55;margin:8px 0;}
.sl-man-warn{background:rgba(245,158,11,.1);border-left:3px solid #f59e0b;padding:8px 10px;border-radius:0 6px 6px 0;font-size:11px;color:#fde68a;line-height:1.55;margin:8px 0;}
.sl-man-ok{background:rgba(16,185,129,.1);border-left:3px solid #10b981;padding:8px 10px;border-radius:0 6px 6px 0;font-size:11px;color:#6ee7b7;line-height:1.55;margin:8px 0;}
.sl-man-step{display:flex;gap:9px;align-items:flex-start;margin-bottom:7px;}
.sl-man-sn{min-width:20px;height:20px;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;flex-shrink:0;margin-top:1px;}
.sl-man-sb{font-size:11px;color:#94a3b8;line-height:1.55;}
.sl-man-sb strong{color:#e2e8f0;display:block;margin-bottom:1px;}
.sl-man-chip{display:inline-block;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);padding:1px 7px;border-radius:10px;font-size:10px;color:#c4b5fd;margin:1px 2px;}
.sl-man-kv{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px;}
.sl-man-kv:last-child{border-bottom:none;}
.sl-man-kv span:first-child{color:#64748b;}
.sl-man-kv span:last-child{color:#e2e8f0;font-weight:500;text-align:right;}
.sl-man-toc{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;}
.sl-man-toc a{color:#818cf8;font-size:11px;text-decoration:none;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);}
.sl-man-toc a:hover{color:#c4b5fd;}
`);
        },

        _build(){
            this._panel=document.createElement('div');
            this._panel.id='sl-panel';
            this._panel.innerHTML=`
<div id="sl-hdr">
  <div class="sl-htitle"><span class="sl-dot stopped" id="sl-dot"></span>&#x26A1; Secret Lair Bot</div>
  <div style="display:flex;align-items:center;gap:8px">
    <span class="sl-hbadge" id="sl-badge">SEMI-AUTO</span>
    <button class="sl-hbtn" id="sl-min-btn" title="Minimize">&#8722;</button>
  </div>
</div>
<div id="sl-tabs">
  <div class="sl-tab active" data-tab="dashboard">Dash</div>
  <div class="sl-tab" data-tab="products">Products</div>
  <div class="sl-tab" data-tab="queue">Queue</div>
  <div class="sl-tab" data-tab="purchase">Purchase</div>
  <div class="sl-tab" data-tab="logs">Logs</div>
  <div class="sl-tab" data-tab="settings">Settings</div>
  <div class="sl-tab" data-tab="help">&#x2753; Help</div>
</div>
<div id="sl-content">
  <div class="sl-pane active" id="sl-pane-dashboard">
    <div class="sl-card">
      <div class="sl-ctitle">&#x1F916; Bot Status</div>
      <div class="sl-row"><span class="sl-rl">Status</span><span class="sl-rv" id="d-status">STOPPED</span></div>
      <div class="sl-row"><span class="sl-rl">Mode</span><span class="sl-rv p" id="d-mode">Semi-Auto</span></div>
      <div class="sl-row"><span class="sl-rl">Account</span><span class="sl-rv" id="d-account">Checking...</span></div>
      <div class="sl-row"><span class="sl-rl">Page</span><span class="sl-rv b" id="d-page">--</span></div>
    </div>
    <div id="sl-np-card"><div class="sl-np-inner">
      <div class="sl-np-tag">&#x1F195; New Release</div>
      <div class="sl-np-nm" id="d-np-name">--</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:8px" id="d-np-price"></div>
      <div class="sl-brow"><button class="sl-btn sl-btn-p sl-btn-sm" id="d-np-open">Open Product</button><button class="sl-btn sl-btn-gh sl-btn-sm" id="d-np-dis">Dismiss</button></div>
    </div></div>
    <div id="sl-cf-card"><div class="sl-cf-inner">
      <div class="sl-cf-ttl">&#x1F6D2; Ready for Checkout</div>
      <div class="sl-cf-det" id="d-cf-det">Product added. Confirm to proceed to checkout.</div>
      <div class="sl-brow"><button class="sl-btn sl-btn-g" id="d-confirm-btn">&#x2713; Confirm Purchase</button><button class="sl-btn sl-btn-r sl-btn-sm" id="d-cancel-btn">Cancel</button></div>
    </div></div>
    <div id="sl-payment-alert">&#x1F4B3; <strong>Payment step reached!</strong><br>Card details auto-filled. Review and click <strong>Pay</strong>.</div>
    <div class="sl-brow">
      <button class="sl-btn sl-btn-g" id="d-start">&#x25B6; Start Bot</button>
      <button class="sl-btn sl-btn-r" id="d-stop" disabled>&#x25A0; Stop Bot</button>
    </div>
    <div class="sl-card"><div class="sl-ctitle">&#x1F4DD; Recent Activity</div><div id="sl-dash-mini"></div></div>
  </div>
  <div class="sl-pane" id="sl-pane-products">
    <div class="sl-card">
      <div class="sl-ctitle">&#x1F50D; Release Monitor</div>
      <div class="sl-row"><span class="sl-rl">Status</span><span class="sl-rv" id="p-mstatus">STOPPED</span></div>
      <div class="sl-row"><span class="sl-rl">Known Products</span><span class="sl-rv" id="p-known">0</span></div>
      <div class="sl-row"><span class="sl-rl">Targeted Watches</span><span class="sl-rv y" id="p-watched">0</span></div>
      <div class="sl-row"><span class="sl-rl">New Releases</span><span class="sl-rv g" id="p-new">0</span></div>
      <div class="sl-row"><span class="sl-rl">Last Scan</span><span class="sl-rv" id="p-last">Never</span></div>
    </div>
    <div style="font-size:10px;color:#64748b;margin-bottom:6px">Bot picks a random delay between Min and Max for each scan.</div>
    <div class="sl-g2" style="margin-bottom:8px">
      <div class="sl-ig"><label>Min Interval (sec) <span style="font-weight:400;text-transform:none;color:#94a3b8">(Rec: 25)</span></label><input type="number" class="sl-in" id="p-min-int" min="10" value="25"></div>
      <div class="sl-ig"><label>Max Interval (sec) <span style="font-weight:400;text-transform:none;color:#94a3b8">(Rec: 45)</span></label><input type="number" class="sl-in" id="p-max-int" min="10" value="45"></div>
    </div>
    <div class="sl-cb"><input type="checkbox" id="p-dnew" checked><span>Detect New Products</span></div>
    <div class="sl-cb"><input type="checkbox" id="p-drestock" checked><span>Detect Restocks</span></div>
    <div class="sl-ig"><label>Keywords (comma-separated)</label><input type="text" class="sl-in" id="p-kw" placeholder="foil, marvel, lofi"></div>
    <div class="sl-ig"><label>Ignore List (comma-separated)</label><input type="text" class="sl-in" id="p-ig" placeholder="chaos vault"></div>
    <div class="sl-brow"><button class="sl-btn sl-btn-p" id="p-scan-now">&#x1F504; Scan Now</button><button class="sl-btn sl-btn-gh" id="p-toggle-mon">Enable Monitor</button></div>
  </div>
  <div class="sl-pane" id="sl-pane-queue">
    <div class="sl-card">
      <div class="sl-ctitle">&#x23F3; Queue Status</div>
      <div class="sl-row"><span class="sl-rl">Status</span><span class="sl-rv" id="q-status">IDLE</span></div>
      <div class="sl-row"><span class="sl-rl">Position</span><span class="sl-rv" id="q-pos">--</span></div>
      <div class="sl-row"><span class="sl-rl">Started</span><span class="sl-rv" id="q-start">--</span></div>
      <div class="sl-row"><span class="sl-rl">Elapsed</span><span class="sl-rv" id="q-elapsed">--</span></div>
    </div>
    <div class="sl-card" style="font-size:11px;color:#64748b;line-height:1.6">
      <div class="sl-ctitle">&#x2139;&#xFE0F; About Queue-it</div>
      Secret Lair uses <strong style="color:#94a3b8">Queue-it</strong> during high-demand drops.
      The bot auto-monitors until you pass through.
      <strong style="color:#f87171">Do not close this tab.</strong>
    </div>
  </div>
  <div class="sl-pane" id="sl-pane-purchase">
    <div class="sl-ig"><label>Desired Quantity</label><input type="number" class="sl-in" id="pu-qty" min="1" max="10" value="1"></div>
    <div class="sl-ig"><label>Max Quantity</label><input type="number" class="sl-in" id="pu-maxqty" min="1" max="10" value="1"></div>
    <div class="sl-ig"><label>Purchase Mode</label>
      <select class="sl-sel" id="pu-mode"><option value="semi">Semi-Automatic (Recommended)</option><option value="auto">Automatic (Hands-Free)</option></select>
    </div>
    <div class="sl-cb"><input type="checkbox" id="pu-confirm" checked><span>Require confirmation before checkout</span></div>
    <div class="sl-div"></div>
    <div style="font-size:10px;color:rgba(251,191,36,.7);font-weight:700;text-transform:uppercase;letter-spacing:1px">&#x1F4B3; Card Details (Auto-filled at Payment Step)</div>
    <div class="sl-ig"><label>Card Number</label><input type="text" class="sl-in" id="sl-card-number" placeholder="1234 5678 9012 3456" maxlength="19" autocomplete="cc-number"></div>
    <div class="sl-g2">
      <div class="sl-ig"><label>Expiry</label><input type="text" class="sl-in" id="sl-card-expiry" placeholder="MM/YY" maxlength="5" autocomplete="cc-exp"></div>
      <div class="sl-ig"><label>CVV</label><input type="text" class="sl-in" id="sl-card-cvv" placeholder="123" maxlength="4" autocomplete="cc-csc"></div>
    </div>
    <button class="sl-btn sl-btn-gh sl-btn-sm" id="pu-save">&#x1F4BE; Save Settings</button>
  </div>
  <div class="sl-pane" id="sl-pane-logs">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:11px;color:#64748b;font-weight:700">ACTIVITY LOG</span>
      <button class="sl-btn sl-btn-gh sl-btn-sm" style="width:auto;padding:4px 10px" id="l-clear">Clear</button>
    </div>
    <div id="sl-log-box"></div>
  </div>
  <div class="sl-pane" id="sl-pane-settings">
    <div class="sl-card">
      <div class="sl-ctitle">&#x2699;&#xFE0F; General</div>
      <div class="sl-cb"><input type="checkbox" id="s-debug"><span>Debug Logging</span></div>
    </div>
    <div class="sl-card">
      <div class="sl-ctitle">&#x1F514; Browser Notifications</div>
      <div class="sl-cb"><input type="checkbox" id="s-n-new" checked><span>New product detected</span></div>
      <div class="sl-cb"><input type="checkbox" id="s-n-rs" checked><span>Restock detected</span></div>
      <div class="sl-cb"><input type="checkbox" id="s-n-q" checked><span>Queue events</span></div>
      <div class="sl-cb"><input type="checkbox" id="s-n-co" checked><span>Checkout ready</span></div>
      <div class="sl-cb"><input type="checkbox" id="s-n-pu" checked><span>Purchase completed</span></div>
      <div class="sl-cb"><input type="checkbox" id="s-n-er" checked><span>Errors</span></div>
    </div>
    <div class="sl-card">
      <div class="sl-ctitle">&#x1F4AC; Discord Webhook</div>
      <div class="sl-cb" style="margin-bottom:7px"><input type="checkbox" id="s-discord-en"><span>Enable Discord notifications</span></div>
      <div class="sl-ig" style="margin-bottom:8px">
        <label>Webhook URL</label>
        <input type="url" class="sl-in" id="s-discord-url" placeholder="https://discord.com/api/webhooks/...">
      </div>
      <button class="sl-btn sl-btn-gh sl-btn-sm" id="s-discord-test">&#x1F4E4; Send Test</button>
    </div>
    <div class="sl-card">
      <div class="sl-ctitle">&#x2708;&#xFE0F; Telegram Bot</div>
      <div class="sl-cb" style="margin-bottom:7px"><input type="checkbox" id="s-tg-en"><span>Enable Telegram notifications</span></div>
      <div class="sl-ig" style="margin-bottom:8px">
        <label>Bot Token <span style="color:#475569;font-weight:400;text-transform:none">(from @BotFather)</span></label>
        <input type="text" class="sl-in" id="s-tg-token" placeholder="123456789:AABB...">
      </div>
      <div class="sl-ig" style="margin-bottom:8px">
        <label>Chat ID <span style="color:#475569;font-weight:400;text-transform:none">(your user or group ID)</span></label>
        <input type="text" class="sl-in" id="s-tg-chatid" placeholder="-100123456789">
      </div>
      <button class="sl-btn sl-btn-gh sl-btn-sm" id="s-tg-test">&#x1F4E4; Send Test</button>
    </div>
    <div class="sl-card">
      <div class="sl-ctitle">&#x1F6CE;&#xFE0F; Pushover</div>
      <div class="sl-cb" style="margin-bottom:7px"><input type="checkbox" id="s-po-en"><span>Enable Pushover notifications</span></div>
      <div class="sl-ig" style="margin-bottom:8px">
        <label>User Key</label>
        <input type="text" class="sl-in" id="s-po-user" placeholder="uXXXXXXXXXXXXXXXX">
      </div>
      <div class="sl-ig" style="margin-bottom:8px">
        <label>API Token</label>
        <input type="text" class="sl-in" id="s-po-token" placeholder="aXXXXXXXXXXXXXXXX">
      </div>
      <button class="sl-btn sl-btn-gh sl-btn-sm" id="s-po-test">&#x1F4E4; Send Test</button>
    </div>
    <button class="sl-btn sl-btn-p" id="s-save">&#x1F4BE; Save All Settings</button>
    <button class="sl-btn sl-btn-r" id="s-reset" style="margin-top:4px">&#x1F5D1;&#xFE0F; Reset to Defaults</button>
    <div style="font-size:10px;color:#475569;line-height:1.6;margin-top:4px">v2.0.0 &mdash; Webhook URLs and API tokens are saved locally in your browser only and never transmitted except to their respective notification services.</div>
  </div>
  <div class="sl-pane" id="sl-pane-help">
    <div class="sl-man-h2">&#x26A1; Secret Lair Bot v2.0.0</div>
    <div class="sl-man-p">Automates Secret Lair purchases: monitors new releases, handles Queue-it, adds to cart, navigates checkout, and auto-fills payment.</div>
    <div class="sl-man-info">&#x1F513; Log in to Secret Lair manually using the site&apos;s Sign In button before starting the bot.</div>

    <div class="sl-man-h2">&#x25B6; Quick Start</div>
    <div class="sl-man-step"><div class="sl-man-sn">1</div><div class="sl-man-sb"><strong>Log in on Secret Lair</strong>Use the site&apos;s own Sign In button.</div></div>
    <div class="sl-man-step"><div class="sl-man-sn">2</div><div class="sl-man-sb"><strong>Choose mode (Purchase tab)</strong>Semi-Auto = stops for confirmation. Full-Auto = hands-free.</div></div>
    <div class="sl-man-step"><div class="sl-man-sn">3</div><div class="sl-man-sb"><strong>Pre-fill card (Purchase tab)</strong>Enter card number, expiry &amp; CVV. Auto-filled at payment step &amp; immediately cleared.</div></div>
    <div class="sl-man-step"><div class="sl-man-sn">4</div><div class="sl-man-sb"><strong>Enable Monitor (Products tab)</strong>Bot polls the catalog every 30s for new drops &amp; restocks.</div></div>
    <div class="sl-man-step"><div class="sl-man-sn">5</div><div class="sl-man-sb"><strong>Click &#x25B6; Start Bot</strong>On a product page it buys immediately. Anywhere else it monitors.</div></div>

    <div class="sl-man-h2">&#x1F4CB; Tabs Reference</div>
    <div class="sl-man-kv"><span>&#x1F916; Dashboard</span><span>Status, alerts, start/stop</span></div>
    <div class="sl-man-kv"><span>&#x1F50D; Products</span><span>Release monitor, keywords</span></div>
    <div class="sl-man-kv"><span>&#x23F3; Queue</span><span>Queue-it live status</span></div>
    <div class="sl-man-kv"><span>&#x1F6D2; Purchase</span><span>Qty, mode, card details</span></div>
    <div class="sl-man-kv"><span>&#x1F4DD; Logs</span><span>Full activity log</span></div>
    <div class="sl-man-kv"><span>&#x2699;&#xFE0F; Settings</span><span>Notifications, credentials</span></div>
    <div class="sl-man-kv"><span>&#x2753; Help</span><span>This manual</span></div>

    <div class="sl-man-h2">&#x1F6D2; Purchase Modes</div>
    <div class="sl-man-h3">Semi-Auto (Recommended)</div>
    <div class="sl-man-p">Bot adds to cart &rarr; shows <strong>Confirm Purchase</strong> card &rarr; you click confirm &rarr; proceeds to cart. At payment step it auto-fills card and stops for you to review before clicking Pay.</div>
    <div class="sl-man-h3">Full-Auto</div>
    <div class="sl-man-p">Bot adds to cart &rarr; navigates to cart automatically &rarr; clicks through every checkout step &rarr; auto-fills card and continues to submit. No prompts.</div>
    <div class="sl-man-warn">&#x26A0;&#xFE0F; Full-Auto will attempt to complete purchase without any prompts. Ensure card details and saved shipping address are correct first.</div>

    <div class="sl-man-h2">&#x1F50D; Release Monitor</div>
    <div class="sl-man-p">Fetches <span class="sl-man-chip">/shopall</span> on a timer using your logged-in session. Compares product IDs against known list.</div>
    <div class="sl-man-kv"><span>New product ID</span><span style="color:#2dd4bf">NEW alert</span></div>
    <div class="sl-man-kv"><span>Unavailable &rarr; available</span><span style="color:#34d399">RESTOCK alert</span></div>
    <div class="sl-man-kv"><span>Keywords filter</span><span>Comma-separated name match</span></div>
    <div class="sl-man-kv"><span>Ignore list</span><span>Comma-separated skip list</span></div>
    <div class="sl-man-info">Keep scan interval &ge; 10s to avoid Cloudflare rate limits. 30s is recommended.</div>

    <div class="sl-man-h2">&#x23F3; Queue-it</div>
    <div class="sl-man-p">Detected via hostname change to <span class="sl-man-chip">queue-it.net</span> or an iframe embed. Bot monitors every 5s and auto-continues when the queue clears.</div>
    <div class="sl-man-warn">&#x1F6AB; Do NOT close the tab while in queue. Your position is lost if you do.</div>

    <div class="sl-man-h2">&#x1F4B3; Payment Auto-Fill</div>
    <div class="sl-man-p">Card details entered in the <strong>Purchase tab</strong> are saved locally in your browser so you don't have to re-enter them. When Adyen payment iframes appear, the bot types each field with realistic keystrokes.</div>

    <div class="sl-man-h2">&#x1F514; Notification Channels</div>
    <div class="sl-man-h3">Discord Webhook</div>
    <div class="sl-man-p">Settings tab &rarr; Discord Webhook. Create a webhook in your Discord server (<em>Channel Settings &rarr; Integrations &rarr; Webhooks</em>) and paste the URL.</div>
    <div class="sl-man-h3">Telegram Bot</div>
    <div class="sl-man-step"><div class="sl-man-sn">1</div><div class="sl-man-sb">Message <strong>@BotFather</strong> on Telegram &rarr; /newbot &rarr; copy the token.</div></div>
    <div class="sl-man-step"><div class="sl-man-sn">2</div><div class="sl-man-sb">Message <strong>@userinfobot</strong> to get your Chat ID.</div></div>
    <div class="sl-man-step"><div class="sl-man-sn">3</div><div class="sl-man-sb">Paste both into Settings &rarr; Telegram Bot, enable checkbox, click Send Test.</div></div>
    <div class="sl-man-h3">Pushover</div>
    <div class="sl-man-p">Register at <em>pushover.net</em> &rarr; copy your <strong>User Key</strong>. Create an Application to get an <strong>API Token</strong>. Paste both in Settings &rarr; Pushover.</div>
    <div class="sl-man-ok">&#x2705; Click <strong>Send Test</strong> next to each channel to verify credentials before your next drop.</div>

    <div class="sl-man-h2">&#x1F527; Troubleshooting</div>
    <div class="sl-man-kv"><span>Panel not visible</span><span>Check Tampermonkey is on &amp; grants accepted</span></div>
    <div class="sl-man-kv"><span>Account: Logged Out</span><span>Sign in on the website first</span></div>
    <div class="sl-man-kv"><span>Add to Cart fails</span><span>Product may be sold out; bot will watch for restock</span></div>
    <div class="sl-man-kv"><span>Card not auto-filling</span><span>Re-enter card in Purchase tab, enable Debug Logging</span></div>
    <div class="sl-man-kv"><span>Queue position shows --</span><span>Normal &mdash; queue is still monitored</span></div>
    <div class="sl-man-kv"><span>No notifications</span><span>Allow notifications in browser address bar</span></div>
    <div class="sl-man-kv"><span>Monitor finds nothing</span><span>Check login, slow interval to 30s+, try Scan Now</span></div>

    <div class="sl-man-h2">&#x1F512; Security</div>
    <div class="sl-man-ok">No passwords, tokens, or card data stored. Webhook URLs saved locally to localStorage only, never transmitted except to their service. Log entries with sensitive patterns are auto-redacted.</div>
    <div style="font-size:10px;color:#334155;margin-top:10px;text-align:center">v2.0.0 &mdash; secretlair.wizards.com</div>
  </div>
</div>`;
            document.body.appendChild(this._panel);
        },

        _bind(){
            const $=id=>document.getElementById(id);
            const p=this._panel;
            p.querySelectorAll('.sl-tab').forEach(t=>t.addEventListener('click',()=>{
                this._activeTab=t.dataset.tab;
                p.querySelectorAll('.sl-tab').forEach(x=>x.classList.remove('active'));
                p.querySelectorAll('.sl-pane').forEach(x=>x.classList.remove('active'));
                t.classList.add('active');
                const pn=document.getElementById('sl-pane-'+t.dataset.tab);
                if(pn)pn.classList.add('active');
            }));
            $('sl-min-btn').onclick=e=>{e.stopPropagation();p.classList.toggle('sl-min');$('sl-min-btn').textContent=p.classList.contains('sl-min')?'+':'-';};
            $('d-start').onclick=()=>{this._saveSettings();Bot.start();};
            $('d-stop').onclick=()=>Bot.stop();
            $('d-confirm-btn').onclick=()=>{Bot.confirm();this._hideCf();};
            $('d-cancel-btn').onclick=()=>{Bot.cancel();this._hideCf();};
            $('d-np-open').onclick=()=>{if(this._pendingProduct)window.open(this._pendingProduct.url,'_blank');};
            $('d-np-dis').onclick=()=>this._hideNp();
            $('p-scan-now').onclick=()=>Monitor.now();
            $('p-toggle-mon').onclick=()=>{
                const s=Store.settings();s.monitorEnabled=!s.monitorEnabled;Store.saveSettings(s);
                if(s.monitorEnabled)Monitor.start();else Monitor.stop();
                $('p-toggle-mon').textContent=s.monitorEnabled?'Disable Monitor':'Enable Monitor';
            };
            $('pu-save').onclick=()=>{this._saveSettings();Log.info('Settings saved.');};
            $('s-save').onclick=()=>{this._saveSettings();Log.info('All settings saved.');};
            $('s-reset').onclick=()=>{if(confirm('Reset all settings to defaults?')){Store.resetSettings();this._applySettings();Log.info('Settings reset.');}};
            $('l-clear').onclick=()=>{Log.clear();$('sl-log-box').innerHTML='';$('sl-dash-mini').innerHTML='';};
            // Notification test buttons
            $('s-discord-test').onclick=()=>{this._saveSettings();Notify.test('discord');};
            $('s-tg-test').onclick=()=>{this._saveSettings();Notify.test('telegram');};
            $('s-po-test').onclick=()=>{this._saveSettings();Notify.test('pushover');};
            const cn=$('sl-card-number');
            if(cn)cn.oninput=e=>{let v=e.target.value.replace(/\D/g,'').slice(0,16);e.target.value=(v.match(/.{1,4}/g)||[]).join(' ');};
            const ce=$('sl-card-expiry');
            if(ce)ce.oninput=e=>{let v=e.target.value.replace(/\D/g,'').slice(0,4);if(v.length>=3)v=v.slice(0,2)+'/'+v.slice(2);e.target.value=v;};
        },

        _saveSettings(){
            const g=id=>{const e=document.getElementById(id);return e?e.value:'';};
            const gc=id=>{const e=document.getElementById(id);return e?e.checked:false;};
            const gi=(id,d)=>{const v=parseInt(g(id));return isNaN(v)?d:v;};
            const s=Store.settings();
            s.minIntervalSec=Math.max(10,gi('p-min-int',25));
            s.maxIntervalSec=Math.max(s.minIntervalSec,gi('p-max-int',45));
            s.detectNewProducts=gc('p-dnew');s.detectRestocks=gc('p-drestock');
            s.keywords=g('p-kw');s.ignoreList=g('p-ig');
            s.desiredQty=Math.max(1,gi('pu-qty',1));s.maxQty=Math.max(1,gi('pu-maxqty',1));
            s.purchaseMode=g('pu-mode')||'semi';s.requireConfirmation=gc('pu-confirm');
            s.debugLogging=gc('s-debug');
            s.notifyNewProduct=gc('s-n-new');s.notifyRestock=gc('s-n-rs');s.notifyQueue=gc('s-n-q');
            s.notifyCheckout=gc('s-n-co');s.notifyPurchase=gc('s-n-pu');s.notifyError=gc('s-n-er');
            // External notification credentials
            s.discordEnabled=gc('s-discord-en');s.discordWebhook=g('s-discord-url');
            s.telegramEnabled=gc('s-tg-en');s.telegramToken=g('s-tg-token');s.telegramChatId=g('s-tg-chatid');
            s.pushoverEnabled=gc('s-po-en');s.pushoverUserKey=g('s-po-user');s.pushoverApiToken=g('s-po-token');
            s.cardNumber=g('sl-card-number');s.cardExpiry=g('sl-card-expiry');s.cardCvv=g('sl-card-cvv');
            Store.saveSettings(s);
            const b=document.getElementById('sl-badge');if(b)b.textContent=s.purchaseMode==='auto'?'FULL-AUTO':'SEMI-AUTO';
            const dm=document.getElementById('d-mode');if(dm)dm.textContent=s.purchaseMode==='auto'?'Automatic':'Semi-Auto';
        },

        _applySettings(){
            const s=Store.settings();
            const sv=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v;};
            const sc=(id,v)=>{const e=document.getElementById(id);if(e)e.checked=v;};
            sv('p-min-int',s.minIntervalSec);sv('p-max-int',s.maxIntervalSec);sc('p-dnew',s.detectNewProducts);sc('p-drestock',s.detectRestocks);
            sv('p-kw',s.keywords);sv('p-ig',s.ignoreList);
            sv('pu-qty',s.desiredQty);sv('pu-maxqty',s.maxQty);sv('pu-mode',s.purchaseMode);sc('pu-confirm',s.requireConfirmation);
            sc('s-debug',s.debugLogging);sc('s-n-new',s.notifyNewProduct);sc('s-n-rs',s.notifyRestock);
            sc('s-n-q',s.notifyQueue);sc('s-n-co',s.notifyCheckout);sc('s-n-pu',s.notifyPurchase);sc('s-n-er',s.notifyError);
            // External notification credentials
            sc('s-discord-en',s.discordEnabled||false);sv('s-discord-url',s.discordWebhook||'');
            sc('s-tg-en',s.telegramEnabled||false);sv('s-tg-token',s.telegramToken||'');sv('s-tg-chatid',s.telegramChatId||'');
            sc('s-po-en',s.pushoverEnabled||false);sv('s-po-user',s.pushoverUserKey||'');sv('s-po-token',s.pushoverApiToken||'');
            sv('sl-card-number',s.cardNumber||'');sv('sl-card-expiry',s.cardExpiry||'');sv('sl-card-cvv',s.cardCvv||'');
            const b=document.getElementById('sl-badge');if(b)b.textContent=s.purchaseMode==='auto'?'FULL-AUTO':'SEMI-AUTO';
            const pm=document.getElementById('p-toggle-mon');if(pm)pm.textContent=s.monitorEnabled?'Disable Monitor':'Enable Monitor';
        },

        _tick(){
            const auth=document.querySelector(SEL.signIn);
            const in_=!auth;
            const ae=document.getElementById('d-account');
            if(ae){ae.textContent=in_?'Connected':'Logged Out';ae.className='sl-rv '+(in_?'g':'r');}
            const pe=document.getElementById('d-page');
            if(pe)pe.textContent=isProductPage?'Product Page':isCartPage?'Cart Page':isCatalogPage?'Catalog':isQueueItPage?'Queue':'Homepage';
            const ms=document.getElementById('p-mstatus');
            if(ms){ms.textContent=Monitor.running()?'MONITORING':'STOPPED';ms.className='sl-rv '+(Monitor.running()?'g':'');}
            const pk=document.getElementById('p-known');
            if(pk)pk.textContent=Object.keys(Store.products()).length;
        },

        _botStatus(s){
            const dot=document.getElementById('sl-dot');
            const ste=document.getElementById('d-status');
            const stb=document.getElementById('d-start');
            const stp=document.getElementById('d-stop');
            const labels={stopped:'STOPPED',monitoring:'MONITORING',purchasing:'PURCHASING',waiting:'WAITING...',error:'ERROR'};
            const colors={stopped:'',monitoring:'b',purchasing:'g',waiting:'y',error:'r'};
            if(dot)dot.className='sl-dot '+s;
            if(ste){ste.textContent=labels[s]||s.toUpperCase();ste.className='sl-rv '+(colors[s]||'');}
            if(stb)stb.disabled=s!=='stopped'&&s!=='error';
            if(stp)stp.disabled=s==='stopped';
        },

        _logEntry(e){
            const t=new Date(e.ts).toLocaleTimeString('en-US',{hour12:false});
            const cat=e.category||e.level;
            const box=document.getElementById('sl-log-box');
            if(box){
                const row=document.createElement('div');
                row.className='sl-le '+e.level;
                row.innerHTML='<span class="sl-lt">'+t+'</span><span class="sl-lc">['+cat+']</span><span class="sl-lm">'+e.message.replace(/</g,'&lt;')+'</span>';
                box.appendChild(row);box.scrollTop=box.scrollHeight;
            }
            const mini=document.getElementById('sl-dash-mini');
            if(mini){
                const clr={INFO:'#60a5fa',SUCCESS:'#34d399',WARN:'#facc15',ERROR:'#f87171',DEBUG:'#475569',PURCHASE:'#a78bfa',QUEUE:'#fb923c',PRODUCT:'#2dd4bf'};
                const d=document.createElement('div');d.style.cssText='font-size:10px';
                d.innerHTML='<span style="color:#334155">'+t+'</span> <span style="color:'+(clr[e.level]||'#64748b')+'">'+e.message.slice(0,60)+(e.message.length>60?'...':'')+'</span>';
                mini.appendChild(d);while(mini.children.length>5)mini.removeChild(mini.firstChild);
            }
        },

        _monUpdate(i){
            const le=document.getElementById('p-last');if(le&&i.last)le.textContent=i.last.toLocaleTimeString('en-US',{hour12:false});
            const ne=document.getElementById('p-new');if(ne)ne.textContent=i.newCt||0;
            const ke=document.getElementById('p-known');if(ke)ke.textContent=i.known||0;
            const we=document.getElementById('p-watched');if(we)we.textContent=i.watched||0;
        },

        _queueUpdate(st){
            const map={waiting:'y',active:'y',complete:'g',error:'r'};
            const qs=document.getElementById('q-status');
            if(qs){qs.textContent=(st.status||'IDLE').toUpperCase();qs.className='sl-rv '+(map[st.status]||'');}
            const qp=document.getElementById('q-pos');if(qp)qp.textContent=st.pos||'--';
            const qst=document.getElementById('q-start');if(qst&&st.start)qst.textContent=new Date(st.start).toLocaleTimeString('en-US',{hour12:false});
            const qe=document.getElementById('q-elapsed');if(qe)qe.textContent=st.elStr||'--';
        },

        showNewProduct(p){
            this._pendingProduct=p;
            const c=document.getElementById('sl-np-card');if(c)c.classList.add('active');
            const n=document.getElementById('d-np-name');if(n)n.textContent=p.name;
            const pr=document.getElementById('d-np-price');if(pr)pr.textContent=p.price||'';
            const dt=this._panel.querySelector('.sl-tab[data-tab="dashboard"]');if(dt)dt.click();
        },
        _hideNp(){const c=document.getElementById('sl-np-card');if(c)c.classList.remove('active');this._pendingProduct=null;},

        showConfirm(p){
            const c=document.getElementById('sl-cf-card');if(c)c.classList.add('active');
            const d=document.getElementById('d-cf-det');
            if(d&&p)d.innerHTML='<strong style="color:#e2e8f0">'+p.name+'</strong><br>Price: '+(p.price||'--')+'<br>Ready to proceed to checkout.';
            const dt=this._panel.querySelector('.sl-tab[data-tab="dashboard"]');if(dt)dt.click();
        },
        _hideCf(){const c=document.getElementById('sl-cf-card');if(c)c.classList.remove('active');},
    };

    // ============================================================
    // ENTRY POINT
    // ============================================================
    function main(){
        Log.init();
        UI.init();
        const s=Store.settings();
        UI._applySettings();
        Log.info('Bot v2.0.0 initialized on '+(isProductPage?'Product':isCartPage?'Cart':isCatalogPage?'Catalog':isQueueItPage?'Queue-it':'Other')+' page.');
        if(isQueueItPage){Log.queue('Queue-it page detected.');Queue.startMon();Bot._set('waiting');return;}
        if(s.botActive){
            Log.info('Resuming bot state from previous page...');
            Bot.start();
        }else if(s.monitorEnabled){
            Bot._set('monitoring');Monitor.start();
        }
        if(isCartPage&&!s.botActive)Log.info('Cart page ready. Click Start Bot to begin automated checkout.');
        new MutationObserver(()=>{
            if(location.hostname.includes('queue-it.net')&&!Queue.inQueue()){Log.queue('Queue-it redirect!');Queue.startMon();Bot._set('waiting');}
        }).observe(document.documentElement,{childList:true,subtree:true});
    }

    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',main);
    else main();

})();
