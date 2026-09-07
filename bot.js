// ==UserScript==
// @name         Secret Lair Auto Add to Cart & Checkout
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Auto select quantity, add to cart, and proceed to checkout for Secret Lair with a beautiful UI.
// @author       Antigravity
// @match        https://secretlair.wizards.com/*/product/*
// @match        https://secretlair.wizards.com/*/cart*
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

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
            <button id="sl-bot-start">Click Secure Checkout</button>
            `}
        </div>
        <div id="sl-bot-console">
            <span class="log-info">[Ready] Initialized on ${isCartPage ? 'Cart' : 'Product'} page.</span>
        </div>
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

    // --- Cart Page Automation ---
    async function runCartCheckout() {
        startBtn.disabled = true;
        startBtn.textContent = 'Processing...';
        log('Cart page detected. Searching for Secure Checkout button...', 'info');

        let attempts = 0;
        const maxAttempts = 30; // 15 seconds max

        while (attempts < maxAttempts) {
            await sleep(500);

            // Locate checkout button with multiple selector fallbacks
            const checkoutBtn = document.querySelector('button[data-internal-id="cart-continue"], button[ng-click*="setNextPage"], button[ng-click*="checkCPF"]');
            
            if (checkoutBtn) {
                // Check if button is enabled
                const isDisabled = checkoutBtn.disabled || 
                                   checkoutBtn.classList.contains('disabled') || 
                                   checkoutBtn.getAttribute('disabled') !== null ||
                                   checkoutBtn.getAttribute('aria-disabled') === 'true';

                if (!isDisabled) {
                    log('Secure Checkout button is ready! Clicking...', 'info');
                    checkoutBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await sleep(350);
                    await simulateHumanClick(checkoutBtn);
                    log('Secure Checkout clicked successfully!', 'success');
                    startBtn.textContent = 'Checkout Clicked';
                    return;
                } else {
                    if (attempts % 4 === 0) {
                        log('Waiting for cart to load and button to enable...', 'info');
                    }
                }
            } else {
                if (attempts % 4 === 0) {
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

        log('Could not click Secure Checkout button within timeout.', 'error');
        startBtn.disabled = false;
        startBtn.textContent = 'Retry Secure Checkout';
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
