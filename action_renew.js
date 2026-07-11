const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || '';
const DEFAULT_CALLBACK_URL = 'https://checkin-cron-worker.wwwqqq001.workers.dev/webhook/checkin';
const JOB_ID = process.env.JOB_ID || 'katabump-renew';
const RUN_ID = process.env.RUN_ID || `local_${Date.now()}`;
const CALLBACK_URL = process.env.CALLBACK_URL || DEFAULT_CALLBACK_URL;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

// Anti-detection: scheduled runs get 0-3h random delay; manual runs skip delay
const SINGBOX_LOCAL_PROXY = 'http://127.0.0.1:8080';

async function sendTelegramMessage(message, imagePath = null) {
    console.log('[Notify] Direct notification disabled; result will be sent by platform webhook.');
}

function maskAccount(value = '') {
    const raw = String(value);
    if (!raw) return 'unknown';
    const [name, domain] = raw.split('@');
    const maskedName = name.length <= 4
        ? `${name.slice(0, 1)}***`
        : `${name.slice(0, 2)}***${name.slice(-2)}`;
    if (!domain) return maskedName;
    const domainParts = domain.split('.');
    const domainHead = domainParts[0] || '';
    const maskedDomain = domainHead.length <= 2
        ? `${domainHead.slice(0, 1)}***`
        : `${domainHead.slice(0, 2)}***`;
    return `${maskedName}@${maskedDomain}`;
}

function accountId(value = '') {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function createAccountResult(user, status, success, note = '') {
    return {
        account_id: accountId(user && user.username),
        name: maskAccount(user && user.username),
        status,
        success,
        reward: {
            points: 0,
            space_mb: 0,
            items: [],
            text: success ? '+0' : '',
        },
        balance: {
            points: 0,
            value_cny: 0,
            days_remaining: 0,
            personal_quota: '',
            family_quota: '',
            text: '',
        },
        note,
        roles: [],
    };
}

function summarizeAccounts(accounts) {
    return accounts.reduce((summary, account) => {
        if (account.status === '跳过') {
            summary.skipped += 1;
        } else if (account.success) {
            summary.success += 1;
        } else {
            summary.failed += 1;
        }
        return summary;
    }, {
        success: 0,
        failed: 0,
        duplicate: 0,
        skipped: 0,
        warning: 0,
    });
}

function buildDetailsMarkdown(accounts) {
    if (accounts.length === 0) return 'Katabump：失败1\n- 未产生账号结果';
    const summary = summarizeAccounts(accounts);
    const headlineParts = [];
    if (summary.success) headlineParts.push(`成功${summary.success}`);
    if (summary.failed) headlineParts.push(`失败${summary.failed}`);
    if (summary.skipped) headlineParts.push(`跳过${summary.skipped}`);
    if (headlineParts.length === 0) headlineParts.push('无结果');
    const lines = [`Katabump：${headlineParts.join('，')}`];
    for (const account of accounts) {
        const note = account.note ? `，${account.note}` : '';
        lines.push(`- ${account.name}：${account.status}${note}`);
    }
    return lines.join('\n');
}

function errorCodeFromMessage(message = '') {
    const text = String(message).toLowerCase();
    if (text.includes('incorrect password') || text.includes('账号或密码')) return 'AUTH_REQUIRED';
    if (text.includes('token')) return 'TOKEN_INVALID';
    if (text.includes('proxy') || text.includes('timeout') || text.includes('timed out') || text.includes('network')) return 'NETWORK_TIMEOUT';
    if (text.includes('config') || text.includes('users_json') || text.includes('http_proxy')) return 'CONFIG_INVALID';
    return 'UNKNOWN_ERROR';
}

function isRetryableError(errorCode) {
    return !['AUTH_REQUIRED', 'COOKIE_EXPIRED', 'TOKEN_INVALID', 'CONFIG_INVALID'].includes(errorCode);
}

function buildPlatformPayload(accounts, topLevelError = null) {
    const summary = summarizeAccounts(accounts);
    const hasFailed = summary.failed > 0 || !!topLevelError;
    if (topLevelError && summary.failed === 0) summary.failed = 1;
    const message = hasFailed
        ? `成功${summary.success}，失败${summary.failed}，跳过${summary.skipped}`
        : `成功${summary.success}，失败0，跳过${summary.skipped}`;
    const payload = {
        job_id: JOB_ID,
        run_id: RUN_ID,
        source: 'github_actions',
        status: hasFailed ? 'failed' : 'success',
        title: hasFailed ? 'Katabump 续期失败' : 'Katabump 续期完成',
        message,
        data: {
            summary,
            accounts,
            roles: [],
            details_markdown: buildDetailsMarkdown(accounts),
        },
    };

    if (hasFailed) {
        const failedAccount = accounts.find((account) => !account.success);
        const errorSource = topLevelError ? topLevelError.message : (failedAccount && failedAccount.note) || message;
        const errorCode = errorCodeFromMessage(errorSource);
        payload.retryable = isRetryableError(errorCode);
        payload.error_code = errorCode;
    }

    return payload;
}

async function sendPlatformWebhook(payload) {
    if (!WEBHOOK_TOKEN) {
        throw new Error('CONFIG_INVALID: WEBHOOK_TOKEN is required');
    }
    await axios.post(CALLBACK_URL, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Token': WEBHOOK_TOKEN,
        },
        timeout: 30000,
        validateStatus: (status) => status >= 200 && status < 300,
    });
    console.log(`[Webhook] Sent result to ${CALLBACK_URL}`);
}

// 启用 stealth 插件
chromium.use(stealth);

// GitHub Actions 环境下的 Chrome 路径 (通常是 google-chrome)
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration ---
// Priority: PROXY_URL (sing-box local) > HTTP_PROXY (direct HTTP)
const PROXY_URL = process.env.PROXY_URL;
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

async function detectSingboxProxy() {
  if (!PROXY_URL) return false;
  try {
    await axios.get('http://127.0.0.1:8080', { timeout: 2000, proxy: false });
    return true;
  } catch (e) {
    return e.code !== 'ECONNREFUSED';
  }
}

async function resolveProxyConfig() {
  // 1. If PROXY_URL is set, sing-box should be running locally on 8080
  if (PROXY_URL) {
    const isSingboxUp = await detectSingboxProxy();
    if (isSingboxUp) {
      PROXY_CONFIG = { server: SINGBOX_LOCAL_PROXY };
      console.log(`[Proxy] sing-box detected on ${SINGBOX_LOCAL_PROXY}`);
      return;
    }
    console.log('[Proxy] PROXY_URL set but sing-box not responding on 8080, falling back to HTTP_PROXY');
  }

  // 2. Fallback to HTTP_PROXY (traditional http://user:pass@host:port)
  if (HTTP_PROXY) {
    try {
      const proxyUrl = new URL(HTTP_PROXY);
      PROXY_CONFIG = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
        password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
      };
      console.log(`[Proxy] HTTP_PROXY detected: server=${PROXY_CONFIG.server}, auth=${PROXY_CONFIG.username ? 'Yes' : 'No'}`);
    } catch (e) {
      console.error('[Proxy] Invalid HTTP_PROXY format. Expected: http://user:pass@host:port or http://host:port');
      throw new Error('CONFIG_INVALID: invalid HTTP_PROXY format');
    }
  }
}

// --- INJECTED_SCRIPT ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    // 2. 简单的 attachShadow Hook
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };

                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// 辅助函数：检测代理是否可用
async function checkProxy() {
  if (!PROXY_CONFIG) return true;

  console.log('[Proxy] Validating proxy connection...');
  try {
    const axiosConfig = {
      proxy: false,
      timeout: 10000
    };

    if (PROXY_CONFIG.server === SINGBOX_LOCAL_PROXY) {
      // sing-box local proxy: use as plain HTTP proxy, no auth needed
      axiosConfig.proxy = {
        protocol: 'http',
        host: '127.0.0.1',
        port: 8080,
      };
    } else {
      axiosConfig.proxy = {
        protocol: 'http',
        host: new URL(PROXY_CONFIG.server).hostname,
        port: new URL(PROXY_CONFIG.server).port,
      };
      if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
        axiosConfig.proxy.auth = {
          username: PROXY_CONFIG.username,
          password: PROXY_CONFIG.password
        };
      }
    }

    await axios.get('https://www.google.com', axiosConfig);
    console.log('[Proxy] Connection successful!');
    return true;
  } catch (error) {
    console.error(`[Proxy] Connection failed: ${error.message}`);
    return false;
  }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        // '--headless=new', // (已被注释) 使用 xvfb-run 时不需要 headless 模式，这样可以模拟有头浏览器增加成功率
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data' // 必须指定用户数据目录，否则远程调试可能失败
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    // 添加针对 Linux 环境的额外稳定性参数
    args.push('--disable-dev-shm-usage'); // 避免共享内存不足


    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
        throw new Error('Chrome 启动失败');
    }
}

function getUsers() {
    // 从环境变量读取 JSON 字符串
    // GitHub Actions Secret: USERS_JSON = [{"username":..., "password":...}]
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);

            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);

                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                const client = await page.context().newCDPSession(page);

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

async function waitForCloudflareSuccess(page, timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        for (const frame of page.frames()) {
            if (!frame.url().includes('cloudflare')) continue;
            try {
                if (await frame.getByText('Success!', { exact: false }).isVisible({ timeout: 300 })) {
                    return true;
                }
            } catch (e) { }
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

async function solveLoginTurnstile(page, maxAttempts = 45, maxTotalMs = 45000, successWaitMs = 8000) {
    console.log('   >> 正在检查登录 Turnstile (使用 CDP 绕过)...');
    const startedAt = Date.now();
    for (let findAttempt = 0; findAttempt < maxAttempts && Date.now() - startedAt < maxTotalMs; findAttempt++) {
        const cdpClickResult = await attemptTurnstileCdp(page);
        if (cdpClickResult) {
            console.log('   >> 登录 CDP 点击生效。正在等待 Cloudflare 成功标志...');
            if (await waitForCloudflareSuccess(page, successWaitMs)) {
                console.log('   >> 登录 Turnstile 验证成功。');
                return true;
            }
            console.log('   >> 未观察到 Cloudflare 成功标志，继续重试...');
        }

        try {
            const altchaStatus = await getAltchaStatus(page);
            if (altchaStatus.solved) {
                console.log('   >> 登录验证已通过。');
                return true;
            }
        } catch (e) { }

        await page.waitForTimeout(1000);
    }
    console.log(`   >> 登录 Turnstile 未检测到或未通过，用时 ${Math.ceil((Date.now() - startedAt) / 1000)} 秒。`);
    return false;
}

async function waitForLoginResult(page, timeoutMs = 60000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            if (await page.getByRole('link', { name: 'See' }).first().isVisible({ timeout: 1000 })) {
                return 'see';
            }
        } catch (e) { }

        if (page.url().includes('/dashboard')) {
            return 'dashboard';
        }

        try {
            if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 500 })) {
                return 'bad_credentials';
            }
        } catch (e) { }

        await solveLoginTurnstile(page, 2, 10000, 3000);
        await page.waitForTimeout(1000);
    }
    return 'timeout';
}

async function saveLoginDebug(page, user, reason) {
    console.log(`登录诊断: reason=${reason}, url=${page.url()}`);
    try {
        console.log(`登录诊断标题: ${await page.title()}`);
    } catch (e) { }

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    const safeUser = accountId(user.username);
    const screenshotPath = path.join(photoDir, `${safeUser}_login_${reason}.png`);
    try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`登录诊断截图已保存: ${screenshotPath}`);
    } catch (e) {
        console.log('登录诊断截图失败:', e.message);
    }
}

// --- 辅助函数：通过 CDP 派发鼠标点击事件 ---
async function dispatchCdpClick(page, x, y) {
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100)); // 模拟人手点击延迟
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        console.log(`>> CDP 坐标 (${x.toFixed(2)}, ${y.toFixed(2)}) 点击已发送。`);
        return true;
    } catch (e) {
        console.log('>> CDP 点击失败:', e.message);
        return false;
    } finally {
        await client.detach().catch(() => {});
    }
}

// ==========================================
// ========== ALTCHA专区 (Renew用) ==========
// ==========================================
async function getAltchaStatus(page) {
    try {
        return await page.evaluate(() => {
            const normalize = (value) => {
                if (value == null) return '';
                return String(value).trim();
            };

            const widget = document.querySelector('altcha-widget');
            const altchaInputs = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"], input[name*="altcha" i], textarea[name*="altcha" i]'));
            const firstFilledInput = altchaInputs.find((input) => normalize(input.value).length > 0);
            const shadowRoot = widget ? widget.shadowRoot : null;
            const checkbox = shadowRoot ? shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]') : null;

            const stateProp = normalize(widget ? widget.state : '');
            const stateAttr = normalize(widget ? widget.getAttribute('state') : '');
            const valueProp = normalize(widget ? widget.value : '');
            const valueAttr = normalize(widget ? widget.getAttribute('value') : '');
            const hiddenInputValue = normalize(firstFilledInput ? firstFilledInput.value : '');
            const checkboxChecked = checkbox && typeof checkbox.checked === 'boolean' ? checkbox.checked : null;
            const ariaChecked = normalize(checkbox ? checkbox.getAttribute('aria-checked') : '');
            const busyAttr = normalize(widget ? widget.getAttribute('aria-busy') : '');
            const state = stateProp || stateAttr || '';
            const isSolved = state === 'verified' || valueProp.length > 0 || valueAttr.length > 0 || hiddenInputValue.length > 0;
            const isVerifying = !isSolved && (
                state === 'verifying' ||
                state === 'processing' ||
                state === 'working' ||
                checkboxChecked === true ||
                ariaChecked === 'true' ||
                busyAttr === 'true'
            );

            return {
                exists: !!widget || altchaInputs.length > 0,
                solved: isSolved,
                isVerifying,
                state: state || 'unknown',
                hasShadowRoot: !!shadowRoot,
                checkboxChecked,
                ariaChecked,
                valueLength: Math.max(valueProp.length, valueAttr.length),
                hiddenInputLength: hiddenInputValue.length,
                busy: busyAttr === 'true'
            };
        });
    } catch (e) {
        return {
            exists: false,
            solved: false,
            isVerifying: false,
            state: 'error',
            hasShadowRoot: false,
            checkboxChecked: null,
            ariaChecked: '',
            valueLength: 0,
            hiddenInputLength: 0,
            busy: false
        };
    }
}

function formatAltchaStatus(status) {
    const checkedText = status.checkboxChecked === null ? 'unknown' : String(status.checkboxChecked);
    const ariaChecked = status.ariaChecked || 'n/a';
    return `state=${status.state}, solved=${status.solved}, verifying=${status.isVerifying}, shadow=${status.hasShadowRoot}, checked=${checkedText}, ariaChecked=${ariaChecked}, valueLen=${status.valueLength}, hiddenLen=${status.hiddenInputLength}, busy=${status.busy}`;
}

async function checkAltchaSuccess(page) {
    const status = await getAltchaStatus(page);
    return status.solved;
}

async function attemptAltchaClick(page, currentStatus = null) {
    try {
        const altchaWidget = page.locator('altcha-widget').first();
        if (await altchaWidget.count() > 0) {

            const status = currentStatus || await getAltchaStatus(page);
            if (status.solved) return false;
            if (status.isVerifying) {
                console.log(`>> ALTCHA 正在验证中，跳过重复点击。${formatAltchaStatus(status)}`);
                return false;
            }

            await page.waitForTimeout(500);
            await altchaWidget.scrollIntoViewIfNeeded().catch(() => {});

            let boxInfo = await page.evaluate(() => {
                const widget = document.querySelector('altcha-widget');
                if (!widget) return null;

                const pickClickTarget = (root) => {
                    if (!root) return null;
                    return root.querySelector('input[type="checkbox"], [role="checkbox"], label, button');
                };

                if (widget.shadowRoot) {
                    const target = pickClickTarget(widget.shadowRoot);
                    if (target) {
                        const rect = target.getBoundingClientRect();
                        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: target.tagName };
                    }
                }

                const lightDomTarget = pickClickTarget(widget);
                if (lightDomTarget) {
                    const rect = lightDomTarget.getBoundingClientRect();
                    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: lightDomTarget.tagName };
                }

                const rect = widget.getBoundingClientRect();
                return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: false, tagName: widget.tagName };
            });

            if (boxInfo && boxInfo.width > 0 && boxInfo.height > 0) {
                let clickX, clickY;
                if (boxInfo.isExact) {
                    clickX = boxInfo.x + boxInfo.width / 2;
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 发现 ALTCHA 内部点击目标 <${boxInfo.tagName}>，精确计算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                } else {
                    clickX = boxInfo.x + Math.min(25, Math.max(12, boxInfo.width * 0.15));
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 未获取内部复选框，使用估算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                }

                await dispatchCdpClick(page, clickX, clickY);

                await page.evaluate(() => {
                    const widget = document.querySelector('altcha-widget');
                    if (widget && widget.shadowRoot) {
                        const cb = widget.shadowRoot.querySelector('input[type="checkbox"]');
                        if (cb && !cb.checked) {
                            cb.click();
                        }
                    }
                });

                return true;
            } else {
                console.log('>> 找到了 ALTCHA 元素，但获取不到有效大小，跳过点击。');
            }
        }
    } catch (e) {
        console.log('>> 尝试查找 ALTCHA 时出错:', e.message);
    }
    return false;
}

async function solveAltchaIfPresent(page, stageName = "Renew阶段", maxAttempts = 15, waitAfterClick = 8000) {
    console.log(`[${stageName}] 开始检测 ALTCHA Captcha...`);
    let sawAltcha = false;

    const startedAt = Date.now();
    const totalWaitBudget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
    let clickAttempts = 0;
    let lastStatusText = '';

    while (Date.now() - startedAt < totalWaitBudget) {
        const status = await getAltchaStatus(page);
        if (status.exists) sawAltcha = true;

        const statusText = formatAltchaStatus(status);
        if (status.exists && statusText !== lastStatusText) {
            console.log(`[${stageName}] ALTCHA 状态: ${statusText}`);
            lastStatusText = statusText;
        }

        if (status.solved) {
            console.log(`[${stageName}] ✅ ALTCHA 已通过验证。`);
            return true;
        }

        if (!status.exists) {
            await page.waitForTimeout(1000);
            continue;
        }

        if (status.isVerifying) {
            await page.waitForTimeout(1000);
            continue;
        }

        if (clickAttempts >= maxAttempts) {
            console.log(`[${stageName}] 已达到 ALTCHA 最大点击次数 (${maxAttempts})，继续等待最终结果...`);
            await page.waitForTimeout(1000);
            continue;
        }

        const clicked = await attemptAltchaClick(page, status);
        if (!clicked) {
            await page.waitForTimeout(1000);
            continue;
        }

        clickAttempts += 1;
        console.log(`[${stageName}] 已点击 ALTCHA，等待 PoW 哈希计算完成 (${waitAfterClick}ms)，当前点击 ${clickAttempts}/${maxAttempts}...`);

        const clickStartedAt = Date.now();
        let observedVerification = false;

        while (Date.now() - clickStartedAt < waitAfterClick) {
            await page.waitForTimeout(1000);

            const followupStatus = await getAltchaStatus(page);
            if (followupStatus.exists) sawAltcha = true;

            const followupText = formatAltchaStatus(followupStatus);
            if (followupStatus.exists && followupText !== lastStatusText) {
                console.log(`[${stageName}] ALTCHA 状态: ${followupText}`);
                lastStatusText = followupText;
            }

            if (followupStatus.solved) {
                console.log(`[${stageName}] ✅ ALTCHA 验证通过 (PoW 计算完成)！`);
                return true;
            }

            if (followupStatus.isVerifying) {
                observedVerification = true;
                continue;
            }

            if (!observedVerification && Date.now() - clickStartedAt >= 2500) {
                console.log(`[${stageName}] ⚠️ 点击后未观察到 ALTCHA 进入 verifying 状态，准备重新尝试点击...`);
                break;
            }
        }
    }

    if (!sawAltcha) {
        console.log(`[${stageName}] 弹窗中未检测到 ALTCHA 组件。`);
        return true;
    }

    const finalStatus = await getAltchaStatus(page);
    console.log(`[${stageName}] 检测到 ALTCHA，但在 ${Math.ceil((Date.now() - startedAt) / 1000)} 秒内未能通过验证。最终状态: ${formatAltchaStatus(finalStatus)}`);
  return false;
}

async function openSeeLinkWithRetry(page) {
    const attempts = [
        {
            name: '当前页面',
            prepare: async () => {
                await page.waitForTimeout(5000);
            },
            timeout: 30000,
        },
        {
            name: '等待登录跳转',
            prepare: async () => {
                try {
                    await page.waitForLoadState('networkidle', { timeout: 20000 });
                } catch (e) { }
            },
            timeout: 30000,
        },
        {
            name: 'dashboard 页面',
            prepare: async () => {
                await page.goto('https://dashboard.katabump.com/dashboard', {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                });
            },
            timeout: 30000,
        },
        {
            name: '刷新后的 dashboard 页面',
            prepare: async () => {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            },
            timeout: 30000,
        },
    ];

    for (const attempt of attempts) {
        try {
            await attempt.prepare();
            const seeLink = page.getByRole('link', { name: 'See' }).first();
            await seeLink.waitFor({ timeout: attempt.timeout });
            await page.waitForTimeout(1000);
            await seeLink.click();
            console.log(`已在${attempt.name}找到并点击 "See" 链接。`);
            return true;
        } catch (e) {
            console.log(`未在${attempt.name}找到 "See" 按钮。`);
        }
    }

    return false;
}

async function main() {
  const accountResults = [];
  let browser;
  const recordAccount = (user, status, success, note = '') => {
    const result = createAccountResult(user, status, success, note);
    accountResults.push(result);
    console.log(`[Result] ${result.name}: ${status}${note ? ` - ${note}` : ''}`);
    return result;
  };

  try {
  // Random delay for scheduled runs (anti-detection)
  if (GITHUB_EVENT_NAME === 'schedule') {
    const maxDelaySec = 3 * 60 * 60;
    const delaySec = Math.floor(Math.random() * maxDelaySec);
    const hours = Math.floor(delaySec / 3600);
    const minutes = Math.floor((delaySec % 3600) / 60);
    const seconds = delaySec % 60;
    console.log(`[Anti-Detection] Scheduled run: random delay ${hours}h ${minutes}m ${seconds}s...`);
    await new Promise(r => setTimeout(r, delaySec * 1000));
  } else {
    console.log(`[Anti-Detection] Manual/direct run: skipping random delay.`);
  }

  const users = getUsers();
  if (users.length === 0) {
    console.log('未在 process.env.USERS_JSON 中找到用户');
    throw new Error('CONFIG_INVALID: USERS_JSON is empty');
  }

  await resolveProxyConfig();

  if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            throw new Error('NETWORK_TIMEOUT: proxy validation failed');
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        throw new Error('NETWORK_TIMEOUT: failed to connect Chrome');
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        let userResultRecorded = false;
        const recordUser = (status, success, note = '') => {
            userResultRecorded = true;
            return recordAccount(user, status, success, note);
        };
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`); // 隐去具体邮箱 logging

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                // Context credentials apply
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // --- 登录逻辑 (简略版，逻辑一致) ---
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            // 总是先去登录页
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                // 如果登出没成功，再次登出
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // --- Cloudflare Turnstile Bypass for Login ---
                await solveLoginTurnstile(page, 45);
                // --------------------------------------------

                await page.getByRole('button', { name: 'Login', exact: true }).click();
                const loginResult = await waitForLoginResult(page, 60000);
                console.log(`   >> 登录后等待结果: ${loginResult}`);

                // User Request: Check for incorrect password
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
        if (loginResult === 'bad_credentials' || await errorMsg.isVisible({ timeout: 3000 })) {
          console.error(` >> ❌ 登录失败: 用户 ${maskAccount(user.username)} 账号或密码错误`);
          const failPhotoDir = path.join(process.cwd(), 'screenshots');
          if (!fs.existsSync(failPhotoDir)) fs.mkdirSync(failPhotoDir, { recursive: true });
          const failSafeName = accountId(user.username);
          const failShotPath = path.join(failPhotoDir, `${failSafeName}_login_fail.png`);
          try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }

          await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);

                        recordUser('失败', false, '账号或密码错误');
                        continue;
                    }
                } catch (e) { }

                if (loginResult === 'timeout') {
                    await saveLoginDebug(page, user, loginResult);
                    recordUser('失败', false, '登录超时');
                    continue;
                }

            } catch (e) {
                console.log('登录错误:', e.message);
                await saveLoginDebug(page, user, 'error');
                recordUser('失败', false, `登录异常: ${e.message}`);
                continue;
            }

            console.log('正在寻找 "See" 链接...');
            const seeOpened = await openSeeLinkWithRetry(page);
            if (!seeOpened) {
                console.log('未找到 "See" 按钮。');
                recordUser('失败', false, '登录后未找到 See 入口');
                continue;
            }

            // --- Renew 逻辑 ---
            let renewSuccess = false;
            // 2. 一个扁平化的主循环：尝试 Renew 整个流程 (最多 20 次)
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                // 1. 如果是重试 (attempt > 1)，说明之前失败了或者刚刷新完页面
                // 我们直接开始寻找 Renew 按钮
                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    // 稍微等待一下，防止页面刚刷新还没渲染出来
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // A. 在模态框里晃晃鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // B. 找 Turnstile (小重试)
                    console.log('正在检查 Turnstile (使用 CDP 绕过)...');
                    let cdpClickResult = false;
                    for (let findAttempt = 0; findAttempt < 30; findAttempt++) {
                        cdpClickResult = await attemptTurnstileCdp(page);
                        if (cdpClickResult) break;
                        console.log(`   >> [寻找尝试 ${findAttempt + 1}/30] 尚未找到 Turnstile 复选框...`);
                        await page.waitForTimeout(1000);
                    }

                    let isTurnstileSuccess = false;
                    if (cdpClickResult) {
                        console.log('   >> CDP 点击生效。等待 8秒 Cloudflare 检查...');
                        await page.waitForTimeout(8000);
                    } else {
                        console.log('   >> 重试后仍未确认 Turnstile 复选框。');
                    }

                    // C. 检查 Success 标志
                    const frames = page.frames();
                    for (const f of frames) {
                        if (f.url().includes('cloudflare')) {
                            try {
                                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                    console.log('   >> 在 Turnstile iframe 中检测到 "Success!"。');
                                    isTurnstileSuccess = true;
                                    break;
                                }
                            } catch (e) { }
                        }
                    }

                    // D. ALTCHA Captcha 处理 (本地版本关键功能)
                    const altchaOk = await solveAltchaIfPresent(page, "Renew弹窗", 15, 8000);

                    if (!altchaOk) {
                        console.log('   >> ALTCHA 未通过，跳过确认按钮并刷新重试...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        if (page.url().includes('login')) {
                            console.log('   >> 刷新后被重定向到登录页，退出。');
                            break;
                        }
                        continue;
                    }

                    // E. 准备点击确认
                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {

                        // User Requested: Screenshot BEFORE final click
                        const fs = require('fs');
                        const path = require('path');
                        const photoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const safeUser = accountId(user.username);
                        const tsScreenshotName = `${safeUser}_Turnstile_${attempt}.png`;
                        try {
                            await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true });
                            console.log(`   >> 📸 快照已保存: ${tsScreenshotName}`);
                        } catch (e) { }

                        // User Request: 找不到的话这个循环直接下一步点击renew，然后检测有没有Please complete the captcha to continue
                        console.log('   >> 点击 Renew 确认按钮 (无论 Turnstile 状态如何)...');
                        await confirmBtn.click();

                        try {
                            // 1. Check for Errors (Captcha or Date limit)
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                // A. Captcha Error
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 检测到错误: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }

                                // B. Not Renew Time Error
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${dateStr}`);

                                    // 截图证明
                                    const fs = require('fs');
                                    const path = require('path');
                                    const photoDir = path.join(process.cwd(), 'screenshots');
                                    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                                    const safeUser = accountId(user.username);
                                    const skipShotPath = path.join(photoDir, `${safeUser}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) { }

                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n用户: ${user.username}\n原因: 还没到时间\n下次可用: ${dateStr}`, skipShotPath);

                                    recordUser('跳过', true, `暂无法续期，下次可用 ${dateStr}`);
                                    renewSuccess = true; // Mark as done to stop retries
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break; // Break loop if not time yet

                        if (hasCaptchaError) {
                            console.log('   >> Error found. Refreshing page to reset Turnstile...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue; // 刷新后，重新开始大循环
                        }

                        // F. 检查成功 (模态框消失)
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Modal closed. Renew successful!');

                            // 截图成功状态
                            const fs = require('fs');
                            const path = require('path');
                            const photoDir = path.join(process.cwd(), 'screenshots');
                            if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                            const safeUser = accountId(user.username);
                            const successShotPath = path.join(photoDir, `${safeUser}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }

                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！`, successShotPath);
                            recordUser('续期成功', true, '服务器已成功续期');
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的验证按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('未找到 Renew 按钮 (服务器可能已续期或页面加载错误)。');
                    recordUser('跳过', true, '未找到 Renew 按钮，可能已经续期');
                    break;
                }
            }
            if (!userResultRecorded) {
                recordUser(renewSuccess ? '续期成功' : '失败', renewSuccess, renewSuccess ? '续期流程完成' : '续期流程未确认成功');
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
            if (!userResultRecorded) {
                recordUser('失败', false, err.message || '账号处理异常');
            }
        }

        // Snapshot before handling next user
        // In GitHub Actions, we save to 'screenshots' dir
        const fs = require('fs');
        const path = require('path');
        const photoDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        // Use safe filename
        const safeUsername = accountId(user.username);
        const screenshotPath = path.join(photoDir, `${safeUsername}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    if (browser) {
        await browser.close().catch((e) => console.log('关闭浏览器失败:', e.message));
    }

    const payload = buildPlatformPayload(accountResults);
    await sendPlatformWebhook(payload);
    process.exit(payload.status === 'failed' ? 1 : 0);
  } catch (err) {
    console.error('[Fatal]', err.message || err);
    if (browser) {
        await browser.close().catch((e) => console.log('关闭浏览器失败:', e.message));
    }
    const payload = buildPlatformPayload(accountResults, err);
    try {
        await sendPlatformWebhook(payload);
    } catch (webhookErr) {
        console.error('[Webhook] Failed to send failure payload:', webhookErr.message);
    }
    process.exit(1);
  }
}

main();
