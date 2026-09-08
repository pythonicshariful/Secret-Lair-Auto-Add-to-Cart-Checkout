// ==UserScript==
// @name         Secret Lair Auto Add to Cart & Checkout
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Auto select quantity, add to cart, and proceed to checkout for Secret Lair with a beautiful UI.
// @author       Antigravity
// @match        https://secretlair.wizards.com/*/product/*
// @match        https://secretlair.wizards.com/*/cart*
// @match        https://checkoutshopper-live.adyen.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // --- ADYEN IFRAME HANDLER (runs inside each Adyen iframe) ---
    // ============================================================
    if (window.location.hostname.includes('checkoutshopper') || window.location.hostname.includes('adyen.com')) {
        const urlParams = new URLSearchParams(window.location.search);
        const fieldType = urlParams.get('type') || '';

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // Type a string character by character into a real input element
        async function typeIntoInput(input, value) {
            input.focus();
            // Clear existing value
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(80);

            for (const char of value) {
                const keyCode = char.charCodeAt(0);
                const keyInit = { key: char, code: `Digit${char}`, keyCode, which: keyCode, bubbles: true, cancelable: true };
                input.dispatchEvent(new KeyboardEvent('keydown',  keyInit));
                input.dispatchEvent(new KeyboardEvent('keypress', keyInit));
                input.value += char;
                input.dispatchEvent(new Event('input',  { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keyup',    keyInit));
                await sleep(40 + Math.floor(Math.random() * 30));
            }
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        async function waitForInput(selector, timeout = 10000) {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                const el = document.querySelector(selector);
                if (el) return el;
                await sleep(200);
            }
            return null;
        }

        async function runAdyenFiller() {
            // All Adyen iframes share type=card in the URL.
            // Detect which field this iframe hosts by checking what input is in the DOM.
            const fieldMap = [
                {
                    inputSel: '#encryptedCardNumber, input[data-fieldtype="encryptedCardNumber"]',
                    storedKey: 'sl_card_number'
                },
                {
                    inputSel: '#encryptedExpiryDate, input[data-fieldtype="encryptedExpiryDate"]',
                    storedKey: 'sl_card_expiry'
                },
                {
                    inputSel: '#encryptedSecurityCode, input[data-fieldtype="encryptedSecurityCode"]',
                    storedKey: 'sl_card_cvv'
                },
            ];

            // Wait for any of the known inputs to appear in this iframe
            let matched = null;
            const detectDeadline = Date.now() + 8000;
            while (!matched && Date.now() < detectDeadline) {
                for (const entry of fieldMap) {
                    if (document.querySelector(entry.inputSel)) {
                        matched = entry;
                        break;
                    }
                }
                if (!matched) await sleep(200);
            }
            if (!matched) return; // not a known field iframe

            // Poll for the stored value — parent sets it when payment step is reached
            let value = null;
            const deadline = Date.now() + 90000; // wait up to 90 seconds
            while (!value && Date.now() < deadline) {
                value = await GM_getValue(matched.storedKey, null);
                if (!value) await sleep(500);
            }
            if (!value) return;

            // Get the input (should already be there since we detected it above)
            const input = document.querySelector(matched.inputSel);
            if (!input) return;

            await sleep(300);
            await typeIntoInput(input, value);

            // Clear the stored value so it doesn't re-fill on future page loads
            await GM_setValue(matched.storedKey, null);
        }

        runAdyenFiller();
        return; // Don't run the main bot UI inside Adyen iframes
    }
    // ============================================================

    const isCartPage = /\/cart\b/i.test(window.location.pathname);
    const isProductPage = /\/product\//i.test(window.location.pathname);

    // --- Styles for Beautiful UI ---
    GM_addStyle(`
        #sl-bot-container {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 340px;
            background: rgba(15, 23, 42, 0.92);
            backdrop-filter: blur(14px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 16px;
            color: #f8fafc;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            z-index: 999999;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            transition: all 0.3s ease;
        }
        #sl-bot-header {
            padding: 14px 16px;
            background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
            font-weight: 700;
            font-size: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        #sl-bot-body {
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .sl-input-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .sl-input-group label {
            font-size: 12px;
            color: #94a3b8;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .sl-input-group input {
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            padding: 10px;
            color: white;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
        }
        .sl-input-group input:focus {
            border-color: #3b82f6;
        }
        #sl-bot-start {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
            border: none;
            border-radius: 8px;
            padding: 12px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            transition: transform 0.1s, opacity 0.2s;
            margin-top: 2px;
        }
        #sl-bot-start:hover {
            opacity: 0.92;
        }
        #sl-bot-start:active {
            transform: scale(0.98);
        }
        #sl-bot-start:disabled {
            background: #475569;
            cursor: not-allowed;
            transform: none;
        }
        #sl-bot-console {
            background: rgba(0, 0, 0, 0.45);
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            padding: 12px;
            height: 130px;
            overflow-y: auto;
            font-family: 'Fira Code', Consolas, Monaco, monospace;
            font-size: 11px;
            color: #a7f3d0;
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .log-error { color: #f87171; font-weight: 600; }
        .log-success { color: #34d399; font-weight: 600; }
        .log-info { color: #93c5fd; }
        .log-warn { color: #facc15; }
        
        #sl-bot-console::-webkit-scrollbar { width: 5px; }
        #sl-bot-console::-webkit-scrollbar-track { background: transparent; }
        #sl-bot-console::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 3px; }
        #sl-payment-alert {
            display: none;
            margin: 0 16px 14px;
            background: linear-gradient(135deg, rgba(251,191,36,0.18) 0%, rgba(245,158,11,0.1) 100%);
            border: 1px solid rgba(251,191,36,0.45);
            border-radius: 10px;
            padding: 11px 14px;
            font-size: 12px;
            color: #fde68a;
            line-height: 1.5;
            animation: sl-pulse 1.6s ease-in-out infinite;
        }
        @keyframes sl-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(251,191,36,0.0); }
            50% { box-shadow: 0 0 0 6px rgba(251,191,36,0.15); }
        }
        .sl-card-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }
        .sl-input-group input[type="text"] {
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            padding: 10px;
            color: white;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
            width: 100%;
            box-sizing: border-box;
            letter-spacing: 0.5px;
        }
        .sl-input-group input[type="text"]:focus {
            border-color: #f59e0b;
        }
        .sl-section-label {
            font-size: 10px;
            color: rgba(251,191,36,0.7);
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: -4px;
        }
    `);

    // --- Build UI ---
    const container = document.createElement('div');
    container.id = 'sl-bot-container';
    container.innerHTML = `
        <div id="sl-bot-header">
            <span>⚡ Secret Lair Bot</span>
            <span style="font-size: 10px; background: rgba(0,0,0,0.25); padding: 2px 7px; border-radius: 10px;">
                ${isCartPage ? 'Cart Mode' : 'Product Mode'}
            </span>
        </div>
        <div id="sl-bot-body">
            ${isProductPage ? `
            <div class="sl-input-group">
                <label>Desired Quantity</label>
                <input type="number" id="sl-target-qty" min="1" value="1">
            </div>
            <button id="sl-bot-start">Start Auto-Checkout</button>
            ` : `
            <div class="sl-input-group">
                <label>Cart Automation</label>
                <div style="font-size: 13px; color: #93c5fd;">Automatic checkout in progress...</div>
            </div>
            <div class="sl-section-label">💳 Card Details (auto-filled at payment)</div>
            <div class="sl-input-group">
                <label>Card Number</label>
                <input type="text" id="sl-card-number" placeholder="1234 5678 9012 3456" maxlength="19" autocomplete="cc-number">
            </div>
            <div class="sl-card-row">
                <div class="sl-input-group">
                    <label>Expiry (MM/YY)</label>
                    <input type="text" id="sl-card-expiry" placeholder="MM/YY" maxlength="5" autocomplete="cc-exp">
                </div>
                <div class="sl-input-group">
                    <label>CVV</label>
                    <input type="text" id="sl-card-cvv" placeholder="123" maxlength="4" autocomplete="cc-csc">
                </div>
            </div>
            <button id="sl-bot-start">Start Auto-Checkout</button>
            `}
        </div>
        <div id="sl-bot-console">
            <span class="log-info">[Ready] Initialized on ${isCartPage ? 'Cart' : 'Product'} page.</span>
        </div>
        <div id="sl-payment-alert">💳 <strong>Payment step reached!</strong><br>Your browser autofill should activate. Click the card number field and select your saved card, then hit <strong>Pay</strong>.</div>
    `;
    document.body.appendChild(container);

    // --- UI Elements ---
    const startBtn = document.getElementById('sl-bot-start');
    const qtyInput = document.getElementById('sl-target-qty');
    const consoleBox = document.getElementById('sl-bot-console');

    // --- Logger ---
    function log(message, type = 'info') {
        const span = document.createElement('span');
        span.className = `log-${type}`;
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        span.textContent = `[${time}] ${message}`;
        consoleBox.appendChild(span);
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }

    // --- Helpers ---
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function getCartCount() {
        const countSpan = document.querySelector('.minicart-button-number');
        if (countSpan && countSpan.textContent.trim()) {
            const count = parseInt(countSpan.textContent.trim(), 10);
            if (!isNaN(count)) return count;
        }
        return 0;
    }

    function checkErrorMessageModal() {
        const modal = document.getElementById('errorMessage');
        if (!modal) return null;
        
        const isShown = modal.classList.contains('in') || 
                        modal.style.display === 'block' || 
                        (window.getComputedStyle(modal).display !== 'none' && modal.offsetWidth > 0);
        
        if (isShown) {
            const body = modal.querySelector('.modal-body') || modal.querySelector('.modal-content') || modal;
            const clone = body.cloneNode(true);
            clone.querySelectorAll('button, script, style, .sr-only').forEach(el => el.remove());
            const text = clone.innerText.replace(/\s+/g, ' ').trim();
            return text || 'Unknown error occurred (errorMessage modal shown).';
        }
        return null;
    }

    function dismissPreviousModals() {
        const errModal = document.getElementById('errorMessage');
        if (errModal && (errModal.classList.contains('in') || errModal.style.display === 'block')) {
            errModal.style.display = 'none';
            errModal.classList.remove('in');
            const closeBtn = errModal.querySelector('[data-dismiss="modal"], .close');
            if (closeBtn) closeBtn.click();
        }
        const backdrops = document.querySelectorAll('.modal-backdrop');
        backdrops.forEach(b => b.remove());
    }

    // --- Human Click Simulation ---
    async function simulateHumanClick(element) {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2 + (Math.random() * 6 - 3);
        const y = rect.top + rect.height / 2 + (Math.random() * 6 - 3);

        const eventOptions = {
            bubbles: true,
            cancelable: true,
            view: win,
            detail: 1,
            clientX: x,
            clientY: y,
            screenX: win.screenX + x,
            screenY: win.screenY + y,
            button: 0,
            buttons: 1,
            which: 1
        };

        element.dispatchEvent(new PointerEvent('pointerover', eventOptions));
        element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
        element.dispatchEvent(new PointerEvent('pointerenter', eventOptions));
        element.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
        element.dispatchEvent(new PointerEvent('pointermove', eventOptions));
        element.dispatchEvent(new MouseEvent('mousemove', eventOptions));

        element.focus();
        
        element.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        element.dispatchEvent(new MouseEvent('mousedown', eventOptions));

        await sleep(80 + Math.floor(Math.random() * 50));

        element.dispatchEvent(new PointerEvent('pointerup', eventOptions));
        element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        
        element.click();
    }

    // --- Detect Adyen payment iframe ---
    function isOnPaymentStep() {
        return !!document.querySelector('iframe[src*="checkoutshopper"], iframe[src*="adyen"]');
    }

    // --- Signal Adyen iframes with card data via GM_setValue ---
    async function fillCardDetails() {
        const paymentAlert = document.getElementById('sl-payment-alert');
        if (paymentAlert) paymentAlert.style.display = 'block';

        const cardNumber = (document.getElementById('sl-card-number')?.value || '').replace(/\s/g, '');
        const cardExpiry = document.getElementById('sl-card-expiry')?.value || '';
        const cardCvv    = document.getElementById('sl-card-cvv')?.value || '';

        if (!cardNumber && !cardExpiry && !cardCvv) {
            log('⚠️ No card details entered in the bot panel.', 'warn');
            return;
        }

        // Store values — the Adyen iframe scripts will pick these up and type them in
        if (cardNumber) await GM_setValue('sl_card_number', cardNumber);
        if (cardExpiry) await GM_setValue('sl_card_expiry', cardExpiry);
        if (cardCvv)    await GM_setValue('sl_card_cvv',    cardCvv);

        log('💳 Card data sent to payment fields...', 'info');

        // Scroll to and click each iframe to trigger it to load & start the filler.
        // Use data-cse on the wrapper div since all Adyen iframe srcs share type=card.
        const iframeSelectors = [
            { sel: '[data-cse="encryptedCardNumber"] iframe, [data-internal-id*="cardNumber"] iframe',       label: 'Card Number' },
            { sel: '[data-cse="encryptedExpiryDate"] iframe, [data-internal-id*="expiryDate"] iframe',       label: 'Expiry Date' },
            { sel: '[data-cse="encryptedSecurityCode"] iframe, [data-internal-id*="securityCode"] iframe',   label: 'CVV' },
        ];

        // Fallback: if data-cse wrappers not found, grab all Adyen iframes in order
        let foundAny = iframeSelectors.some(({ sel }) => !!document.querySelector(sel));
        if (!foundAny) {
            const allIframes = Array.from(document.querySelectorAll('iframe[src*="checkoutshopper"]'));
            iframeSelectors.forEach((entry, i) => {
                if (allIframes[i]) entry.fallbackEl = allIframes[i];
            });
        }

        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        for (const { sel, label, fallbackEl } of iframeSelectors) {
            const iframe = document.querySelector(sel) || fallbackEl || null;
            if (!iframe) { log(`⚠️ ${label} iframe not found.`, 'warn'); continue; }
            iframe.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(500);
            const rect = iframe.getBoundingClientRect();
            const cx = rect.left + 20 + Math.random() * 8;
            const cy = rect.top  + 18 + Math.random() * 6;
            const opts = { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy };
            iframe.dispatchEvent(new MouseEvent('mousedown', opts));
            await sleep(80);
            iframe.dispatchEvent(new MouseEvent('mouseup',   opts));
            iframe.dispatchEvent(new MouseEvent('click',     opts));
            log(`Triggered ${label} iframe.`, 'info');
            await sleep(1200); // give the iframe filler time to type
        }

        log('✅ Card details sent! Check the fields and click Pay.', 'success');
    }

    // --- Cart Page Automation ---
    async function runCartCheckout() {
        startBtn.disabled = true;
        startBtn.textContent = 'Processing...';
        log('Cart page detected. Searching for checkout/payment buttons...', 'info');

        let attempts = 0;
        const maxAttempts = 120; // 60 seconds max
        let paymentHandled = false;

        while (attempts < maxAttempts) {
            await sleep(500);

            // --- Check if we have landed on the payment step ---
            if (!paymentHandled && isOnPaymentStep()) {
                paymentHandled = true;
                await fillCardDetails();
                startBtn.disabled = false;
                startBtn.textContent = 'Automating Payment...';
                // Do NOT break; we want to continue and click Review Order once enabled
            }

            // Locate all checkout buttons with multiple selector fallbacks (including the Review Order button)
            const checkoutBtns = document.querySelectorAll('button[data-internal-id="cart-continue"], button[data-internal-id="cart-continue-creditcard"], button[ng-click*="setNextPage"], button[ng-click*="checkCPF"]');
            
            let activeBtn = null;
            for (const btn of checkoutBtns) {
                if (btn.offsetWidth > 0 || btn.offsetHeight > 0) {
                    activeBtn = btn;
                    break;
                }
            }

            if (activeBtn) {
                // Check if button is enabled
                const isDisabled = activeBtn.disabled || 
                                   activeBtn.classList.contains('disabled') || 
                                   activeBtn.getAttribute('disabled') !== null ||
                                   activeBtn.getAttribute('aria-disabled') === 'true';

                if (!isDisabled) {
                    const btnText = activeBtn.textContent.trim() || 'Next Button';
                    log(`"${btnText}" is ready! Clicking...`, 'info');
                    activeBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await sleep(350);
                    await simulateHumanClick(activeBtn);
                    log(`"${btnText}" clicked successfully!`, 'success');
                    
                    // Wait for the next view to render
                    await sleep(2000);
                } else {
                    if (attempts % 10 === 0) {
                        log('Waiting for cart/payment button to enable...', 'info');
                    }
                }
            } else {
                if (attempts % 10 === 0) {
                    log('Locating checkout button on page...', 'info');
                }
            }

            // Check if store displayed an error
            const errorText = checkErrorMessageModal();
            if (errorText) {
                log(`[Store Error]: ${errorText}`, 'error');
                break;
            }

            attempts++;
        }

        if (!paymentHandled) {
            log('Cart automation finished or timed out.', 'info');
            startBtn.disabled = false;
            startBtn.textContent = 'Retry Secure Checkout';
        }
    }

    // --- Product Page Automation ---
    async function runProductBot() {
        startBtn.disabled = true;
        startBtn.textContent = 'Running...';
        dismissPreviousModals();

        const targetQty = parseInt(qtyInput.value, 10);
        if (isNaN(targetQty) || targetQty < 1) {
            log('Invalid quantity. Please enter 1 or more.', 'error');
            resetBtn();
            return;
        }

        log(`Target quantity: ${targetQty}`);

        // 1. Locate Quantity Dropdown
        const qtySelect = document.querySelector('select.qty-select');
        if (!qtySelect) {
            log('Quantity selector not found. Product may be out of stock.', 'error');
            resetBtn();
            return;
        }

        const options = Array.from(qtySelect.options);
        if (options.length === 0) {
            log('No quantities available in dropdown.', 'error');
            resetBtn();
            return;
        }

        let bestOption = null;
        let bestDiff = Infinity;

        for (const opt of options) {
            const val = parseInt(opt.textContent.trim(), 10);
            if (!isNaN(val)) {
                const diff = Math.abs(val - targetQty);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestOption = opt;
                }
            }
        }

        if (!bestOption) {
            log('Could not determine available quantities.', 'error');
            resetBtn();
            return;
        }

        const selectedVal = parseInt(bestOption.textContent.trim(), 10);
        log(`Selected quantity: ${selectedVal} (option value="${bestOption.value}")`, 'info');

        // Apply to DOM
        qtySelect.focus();
        qtySelect.selectedIndex = bestOption.index;
        for (let i = 0; i < qtySelect.options.length; i++) {
            qtySelect.options[i].selected = (i === bestOption.index);
        }
        qtySelect.value = bestOption.value;

        qtySelect.dispatchEvent(new Event('input', { bubbles: true }));
        qtySelect.dispatchEvent(new Event('change', { bubbles: true }));

        // Sync with AngularJS scope & ngModelController
        try {
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            if (win.angular) {
                const ngEl = win.angular.element(qtySelect);
                const scope = ngEl ? ngEl.scope() : null;
                const ngModel = ngEl ? ngEl.controller('ngModel') : null;

                if (scope) {
                    const updateScope = () => {
                        if (scope.cartSelectorItems && scope.cartSelectorItems.length > bestOption.index) {
                            const exactItem = scope.cartSelectorItems[bestOption.index];
                            if (scope.cart) scope.cart.addQuantity = exactItem;
                        } else if (scope.cart) {
                            scope.cart.addQuantity = selectedVal;
                        }
                        if (ngModel) {
                            ngModel.$setViewValue(selectedVal);
                            ngModel.$commitViewValue();
                            ngModel.$render();
                        }
                    };

                    if (scope.$$phase) {
                        updateScope();
                    } else {
                        scope.$apply(updateScope);
                    }
                }
            }
        } catch (e) {
            log(`Angular sync note: ${e.message}`, 'warn');
        }

        await sleep(700);

        // 2. Locate Add to Cart Button
        const addToCartBtn = document.querySelector('.buy-link-with-qtyselect, button[data-internal-id^="add-to-cart"]');
        if (!addToCartBtn) {
            log('Add to cart button not found.', 'error');
            resetBtn();
            return;
        }

        if (addToCartBtn.disabled || addToCartBtn.classList.contains('disabled')) {
            log('Waiting for Add to Cart button to enable...', 'warn');
            await sleep(500);
            if (addToCartBtn.disabled || addToCartBtn.classList.contains('disabled')) {
                log('Add to Cart button is currently disabled by the store.', 'error');
                resetBtn();
                return;
            }
        }

        try {
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            if (win.angular) {
                const btnNg = win.angular.element(addToCartBtn);
                const btnScope = btnNg ? btnNg.scope() : null;
                if (btnScope && btnScope.cart) {
                    if (!btnScope.$$phase) {
                        btnScope.$apply(() => {
                            btnScope.cart.addQuantity = selectedVal;
                        });
                    } else {
                        btnScope.cart.addQuantity = selectedVal;
                    }
                }
            }
        } catch (e) {}

        // 3. Read initial cart state
        const initialCartCount = getCartCount();
        log(`Initial cart count: ${initialCartCount}`);

        // 4. Scroll into view and simulate human click
        log('Clicking Add to Cart...', 'info');
        addToCartBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(250);
        await simulateHumanClick(addToCartBtn);

        // 5. Monitor for Cart Update or Error Modal
        log('Waiting for confirmation...', 'info');
        let success = false;
        let attempts = 0;

        while (attempts < 24) { // Poll for up to 12 seconds
            await sleep(500);

            const errorText = checkErrorMessageModal();
            if (errorText) {
                log(`[Store Blocked]: ${errorText}`, 'error');
                success = false;
                break;
            }

            const currentCartCount = getCartCount();
            if (currentCartCount > initialCartCount) {
                log(`Success! Cart updated. New count: ${currentCartCount}`, 'success');
                success = true;
                break;
            }

            const interstitialModal = document.getElementById('intersticialCheckoutModal');
            if (interstitialModal && (interstitialModal.classList.contains('in') || interstitialModal.style.display === 'block')) {
                log('Success! Checkout modal opened.', 'success');
                success = true;
                break;
            }

            attempts++;
        }

        if (!success && !checkErrorMessageModal()) {
            log('Timeout waiting for cart update.', 'error');
            resetBtn();
        } else if (success) {
            log('Finished successfully! Redirecting to cart...', 'success');
            await sleep(800);
            const pathParts = window.location.pathname.split('/').filter(Boolean);
            const locale = (pathParts.length > 0 && /^[a-z]{2}$/i.test(pathParts[0])) ? pathParts[0] : 'us';
            window.location.href = `https://secretlair.wizards.com/${locale}/cart`;
        }
    }

    function resetBtn() {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Auto-Checkout';
    }

    // --- Bind Events and Auto-Launch ---
    if (isProductPage) {
        startBtn.addEventListener('click', runProductBot);
    } else if (isCartPage) {
        startBtn.addEventListener('click', runCartCheckout);
        // Automatically start checkout on cart page after brief settle delay
        setTimeout(runCartCheckout, 800);
    }

})();
