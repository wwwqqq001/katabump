#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SeleniumBase UC-mode renew path (adapted from weikkadd/katabump).

Keeps platform webhook contract used by action_renew.js.
Test branch only until verified.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import subprocess
import time
import traceback
from typing import Any
from urllib.parse import urlparse

import requests
from seleniumbase import SB

BASE_URL = "https://dashboard.katabump.com"
DEFAULT_CALLBACK_URL = "https://checkin-cron-worker.wwwqqq001.workers.dev/webhook/checkin"
JOB_ID = os.environ.get("JOB_ID") or "katabump-renew"
RUN_ID = os.environ.get("RUN_ID") or f"local_{int(time.time())}"
CALLBACK_URL = os.environ.get("CALLBACK_URL") or DEFAULT_CALLBACK_URL
WEBHOOK_TOKEN = os.environ.get("WEBHOOK_TOKEN") or ""
KATABUMP_TEST_ONLY_USER = (os.environ.get("KATABUMP_TEST_ONLY_USER") or "").strip().lower()
KATABUMP_SERVER_ID = (os.environ.get("KATABUMP_SERVER_ID") or "").strip()
KATABUMP_SERVER_IDS_RAW = (os.environ.get("KATABUMP_SERVER_IDS") or "").strip()
PROXY_URL = (os.environ.get("PROXY_URL") or "").strip()
SINGBOX_PROXY = "http://127.0.0.1:8080"

_EXPAND_JS = """
(function() {
    var ts = document.querySelector('input[name="cf-turnstile-response"]');
    if (!ts) return 'no-turnstile';
    var el = ts;
    for (var i = 0; i < 20; i++) {
        el = el.parentElement;
        if (!el) break;
        var s = window.getComputedStyle(el);
        if (s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflowY === 'hidden')
            el.style.overflow = 'visible';
        el.style.minWidth = 'max-content';
    }
    document.querySelectorAll('iframe').forEach(function(f){
        if (f.src && f.src.includes('challenges.cloudflare.com')) {
            f.style.width = '300px'; f.style.height = '65px';
            f.style.minWidth = '300px';
            f.style.visibility = 'visible'; f.style.opacity = '1';
        }
    });
    return 'done';
})()
"""

_EXISTS_JS = """
(function(){
    return document.querySelector('input[name="cf-turnstile-response"]') !== null;
})()
"""

_SOLVED_JS = """
(function(){
    var i = document.querySelector('input[name="cf-turnstile-response"]');
    return !!(i && i.value && i.value.length > 20);
})()
"""

_DIAG_IFRAMES_JS = """
(function(){
    var iframes = document.querySelectorAll('iframe');
    var result = [];
    for (var i = 0; i < iframes.length; i++) {
        var r = iframes[i].getBoundingClientRect();
        result.push({
            idx: i,
            src: iframes[i].src ? iframes[i].src.substring(0, 100) : '(empty)',
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            visible: r.width > 0 && r.height > 0
        });
    }
    var ts = document.querySelector('input[name="cf-turnstile-response"]');
    return {
        iframeCount: iframes.length,
        iframes: result,
        hasTurnstileInput: !!ts,
        turnstileValue: ts ? ts.value.substring(0, 30) : ''
    };
})()
"""

_TURNSTILE_COORDS_JS = """
(function(){
    var iframes = document.querySelectorAll('iframe');
    var iframe = null;
    for (var i = 0; i < iframes.length; i++) {
        if (iframes[i].src && iframes[i].src.indexOf('challenges.cloudflare.com') !== -1) {
            iframe = iframes[i]; break;
        }
    }
    if (!iframe) {
        for (var i = 0; i < iframes.length; i++) {
            if (iframes[i].src && (iframes[i].src.indexOf('cloudflare') !== -1 || iframes[i].src.indexOf('turnstile') !== -1)) {
                iframe = iframes[i]; break;
            }
        }
    }
    if (!iframe) {
        for (var i = 0; i < iframes.length; i++) {
            var r = iframes[i].getBoundingClientRect();
            if (r.width > 200 && r.width < 400 && r.height > 40 && r.height < 100) {
                iframe = iframes[i]; break;
            }
        }
    }
    if (!iframe) return null;
    var r = iframe.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
        x: Math.round(r.x + 30),
        y: Math.round(r.y + r.height / 2),
        screenX: window.screenX || 0,
        screenY: window.screenY || 0,
        outerHeight: window.outerHeight || 0,
        innerHeight: window.innerHeight || 0
    };
})()
"""

_ALTCHA_SOLVED_JS = """
(function(){
    var modal = document.querySelector('div.modal.show') || document;
    var inputs = modal.querySelectorAll('input[type="hidden"]');
    for (var i = 0; i < inputs.length; i++) {
        var n = (inputs[i].name || '').toLowerCase();
        if ((n.includes('altcha') || n.includes('captcha')) &&
            inputs[i].value && inputs[i].value.length > 20) return true;
    }
    var cbs = modal.querySelectorAll('input[type="checkbox"]');
    for (var j = 0; j < cbs.length; j++) {
        if (cbs[j].disabled) return true;
    }
    var w = modal.querySelector('[data-state="verified"],.altcha--verified,.altcha-verified');
    return !!w;
})()
"""


def mask_account(value: str = "") -> str:
    raw = str(value or "")
    if not raw:
        return "unknown"
    if "@" not in raw:
        return raw[:2] + "***"
    name, domain = raw.split("@", 1)
    masked_name = f"{name[:1]}***" if len(name) <= 4 else f"{name[:2]}***{name[-2:]}"
    head = domain.split(".")[0] if domain else ""
    masked_domain = f"{head[:1]}***" if len(head) <= 2 else f"{head[:2]}***"
    return f"{masked_name}@{masked_domain}"


def account_id(value: str = "") -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:12]


def load_server_id_map() -> dict[str, str]:
    if not KATABUMP_SERVER_IDS_RAW:
        return {}
    try:
        parsed = json.loads(KATABUMP_SERVER_IDS_RAW)
        if isinstance(parsed, list):
            out = {}
            for item in parsed:
                user = str(item.get("username") or item.get("email") or "").strip().lower()
                sid = str(item.get("server_id") or item.get("serverId") or item.get("id") or "").strip()
                if user and sid:
                    out[user] = sid
            return out
        if isinstance(parsed, dict):
            return {
                str(k).strip().lower(): str(v).strip()
                for k, v in parsed.items()
                if str(k).strip() and str(v).strip()
            }
    except Exception as e:
        print(f"解析 KATABUMP_SERVER_IDS 失败: {e}")
    return {}


SERVER_ID_MAP = load_server_id_map()


def resolve_server_id(user: dict[str, Any]) -> str:
    from_user = str(user.get("server_id") or user.get("serverId") or "").strip()
    if from_user:
        return from_user
    email = str(user.get("username") or "").strip().lower()
    if email and SERVER_ID_MAP.get(email):
        return SERVER_ID_MAP[email]
    return KATABUMP_SERVER_ID


def get_accounts() -> list[dict[str, Any]]:
    users: list[dict[str, Any]] = []
    raw = (os.environ.get("USERS_JSON") or "").strip()
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                users = data
            elif isinstance(data, dict):
                users = data.get("users") or []
        except Exception as e:
            print(f"解析 USERS_JSON 失败: {e}")
    if KATABUMP_TEST_ONLY_USER:
        users = [u for u in users if str(u.get("username") or "").strip().lower() == KATABUMP_TEST_ONLY_USER]
        print(f"[Test] KATABUMP_TEST_ONLY_USER set, matched {len(users)} account(s).")
    return users


def create_account_result(user: dict[str, Any], status: str, success: bool, note: str = "") -> dict[str, Any]:
    return {
        "account_id": account_id(user.get("username")),
        "name": mask_account(user.get("username")),
        "status": status,
        "success": success,
        "reward": {"points": 0, "space_mb": 0, "items": [], "text": note or status},
        "balance": {
            "points": 0,
            "value_cny": 0,
            "days_remaining": 0,
            "personal_quota": "",
            "family_quota": "",
            "text": note or status,
        },
        "note": note,
        "roles": [],
    }


def summarize(accounts: list[dict[str, Any]]) -> dict[str, int]:
    summary = {"success": 0, "failed": 0, "duplicate": 0, "skipped": 0, "warning": 0}
    for item in accounts:
        if item.get("success"):
            if "跳过" in str(item.get("status")) or "未到" in str(item.get("note")):
                summary["skipped"] += 1
            else:
                summary["success"] += 1
        else:
            summary["failed"] += 1
    return summary


def build_payload(accounts: list[dict[str, Any]], top_error: str | None = None) -> dict[str, Any]:
    summary = summarize(accounts)
    if top_error and not accounts:
        accounts = [create_account_result({"username": "unknown"}, "失败", False, top_error)]
        summary = summarize(accounts)
    status = "failed" if summary["failed"] > 0 or top_error else "success"
    lines = [f"Katabump：成功{summary['success']} 失败{summary['failed']} 跳过{summary['skipped']}"]
    for a in accounts:
        lines.append(f"- {a['name']}：{a.get('status')}，{a.get('note') or ''}")
    details = "\n".join(lines)
    payload: dict[str, Any] = {
        "job_id": JOB_ID,
        "run_id": RUN_ID,
        "source": "github_actions",
        "status": status,
        "title": "Katabump 续期成功" if status == "success" else "Katabump 续期失败",
        "message": top_error or details.split("\n")[0],
        "data": {
            "summary": summary,
            "accounts": accounts,
            "details_markdown": details,
            "engine": "seleniumbase-uc",
        },
    }
    if status == "failed":
        payload["retryable"] = True
        payload["error_code"] = "AUTH_REQUIRED" if "captcha" in (top_error or "").lower() else "UNKNOWN_ERROR"
    return payload


def send_webhook(payload: dict[str, Any]) -> None:
    if not WEBHOOK_TOKEN:
        print("[Webhook] WEBHOOK_TOKEN missing; print payload only.")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    try:
        parsed = urlparse(CALLBACK_URL)
        if parsed.hostname != "checkin-cron-worker.wwwqqq001.workers.dev":
            raise RuntimeError(f"CALLBACK_URL host not allowed: {parsed.hostname}")
        resp = requests.post(
            CALLBACK_URL,
            headers={
                "Content-Type": "application/json",
                "X-Webhook-Token": WEBHOOK_TOKEN,
                "User-Agent": "katabump-uc-renew",
            },
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            timeout=20,
        )
        print(f"[Webhook] status={resp.status_code}")
        if resp.status_code >= 400:
            print(f"[Webhook] body={resp.text[:300]}")
    except Exception as e:
        print(f"[Webhook] failed: {e}")


def human_type(sb, selector: str, text: str) -> None:
    try:
        el = sb.find_element(selector, timeout=5)
        el.click()
        time.sleep(0.2 + random.random() * 0.3)
        el.send_keys("\b" * 40)
        for ch in text:
            el.send_keys(ch)
            time.sleep(0.05 + random.random() * 0.12)
        time.sleep(0.2 + random.random() * 0.4)
    except Exception as e:
        print(f"human_type fallback: {e}")
        sb.type(selector, text)


def human_mouse_move(sb, steps: int = 4) -> None:
    try:
        for _ in range(steps):
            x = random.randint(200, 1500)
            y = random.randint(200, 800)
            sb.execute_script(
                f"""
                var evt = new MouseEvent('mousemove', {{
                    bubbles: true, cancelable: true, clientX: {x}, clientY: {y}
                }});
                document.dispatchEvent(evt);
                """
            )
            time.sleep(0.15 + random.random() * 0.35)
    except Exception:
        pass


def human_scroll(sb) -> None:
    try:
        for _ in range(2):
            sb.execute_script(f"window.scrollBy(0, {random.randint(80, 300)});")
            time.sleep(0.3 + random.random() * 0.5)
        sb.execute_script("window.scrollTo(0, 0);")
    except Exception:
        pass


def activate_window() -> None:
    for cls in ["chrome", "chromium", "Chromium", "Chrome", "google-chrome"]:
        try:
            r = subprocess.run(
                ["xdotool", "search", "--onlyvisible", "--class", cls],
                capture_output=True,
                text=True,
                timeout=3,
            )
            wids = [w for w in r.stdout.strip().split("\n") if w.strip()]
            if wids:
                subprocess.run(
                    ["xdotool", "windowactivate", "--sync", wids[0]],
                    timeout=3,
                    stderr=subprocess.DEVNULL,
                )
                time.sleep(0.15)
                return
        except Exception:
            pass


def xdotool_click(x: int, y: int) -> bool:
    activate_window()
    try:
        subprocess.run(["xdotool", "mousemove", str(x), str(y)], timeout=3, stderr=subprocess.DEVNULL)
        time.sleep(0.15)
        subprocess.run(["xdotool", "click", "1"], timeout=2, stderr=subprocess.DEVNULL)
        print(f"  xdotool click ({x}, {y})")
        return True
    except Exception as e:
        print(f"  xdotool failed: {e}")
        return False


def handle_turnstile(sb) -> bool:
    print("处理 Cloudflare Turnstile (UC)...")
    time.sleep(1.5)
    if sb.execute_script(_SOLVED_JS):
        print("Turnstile 已静默通过")
        return True

    for _ in range(3):
        try:
            sb.execute_script(_EXPAND_JS)
        except Exception:
            pass
        time.sleep(0.4)

    is_invisible = False
    try:
        diag = sb.execute_script(_DIAG_IFRAMES_JS) or {}
        if diag.get("iframeCount", 0) > 0:
            f0 = (diag.get("iframes") or [{}])[0]
            if f0.get("w", 99) <= 5 and f0.get("h", 99) <= 5:
                is_invisible = True
                print(f"检测到 invisible/managed Turnstile ({f0.get('w')}x{f0.get('h')})")
    except Exception:
        pass

    if is_invisible:
        for i in range(20):
            if sb.execute_script(_SOLVED_JS):
                print(f"Turnstile 自动通过（{i + 1}s）")
                return True
            time.sleep(1)

    print("尝试 uc_gui_click_captcha ...")
    for attempt in range(3):
        if sb.execute_script(_SOLVED_JS):
            print(f"Turnstile 通过（uc_gui 第 {attempt} 次前已通过）")
            return True
        try:
            sb.uc_gui_click_captcha()
        except Exception as e:
            print(f"uc_gui_click_captcha 异常: {e}")
        for _ in range(16):
            time.sleep(0.5)
            if sb.execute_script(_SOLVED_JS):
                print(f"Turnstile 通过（uc_gui 第 {attempt + 1} 次）")
                return True
        print(f"uc_gui 第 {attempt + 1} 次未通过")

    # interactive fallback via xdotool
    try:
        coords = sb.execute_script(_TURNSTILE_COORDS_JS)
    except Exception:
        coords = None
    if coords:
        bar = max(0, coords.get("outerHeight", 0) - coords.get("innerHeight", 0))
        abs_x = coords["x"] + coords.get("screenX", 0)
        abs_y = coords["y"] + coords.get("screenY", 0) + bar
        for attempt in range(3):
            if sb.execute_script(_SOLVED_JS):
                return True
            print(f"xdotool Turnstile 第 {attempt + 1} 次...")
            xdotool_click(abs_x, abs_y)
            for _ in range(16):
                time.sleep(0.5)
                if sb.execute_script(_SOLVED_JS):
                    print("Turnstile 通过（xdotool）")
                    return True

    for i in range(10):
        if sb.execute_script(_SOLVED_JS):
            print(f"Turnstile 延迟通过（{i + 1}s）")
            return True
        time.sleep(1)
    print("Turnstile 失败")
    return False


def login(sb, email: str, password: str) -> bool:
    print(f"打开登录页: {BASE_URL}/auth/login")
    sb.uc_open_with_reconnect(BASE_URL + "/auth/login", reconnect_time=8)
    time.sleep(5)

    print("等待 Cloudflare 放行登录表单...")
    for i in range(30):
        src = (sb.get_page_source() or "").lower()
        if 'name="email"' in src:
            print(f"Cloudflare 已通过（{i + 1}s）")
            break
        time.sleep(1)

    try:
        sb.wait_for_element('input[name="email"]', timeout=15)
    except Exception:
        print("登录表单未出现")
        sb.save_screenshot("login_load_fail.png")
        return False

    # cookie banner
    try:
        for btn in sb.find_elements("button"):
            if "Accept" in (btn.text or ""):
                btn.click()
                break
    except Exception:
        pass

    print("模拟人类浏览...")
    human_mouse_move(sb, 4)
    human_scroll(sb)
    human_type(sb, 'input[name="email"]', email)
    time.sleep(0.4 + random.random())
    human_type(sb, 'input[name="password"]', password)
    time.sleep(0.6 + random.random())
    human_mouse_move(sb, 2)

    print("等待 Turnstile ...")
    for i in range(10):
        if sb.execute_script(_EXISTS_JS):
            print(f"检测到 Turnstile（{i + 1}s）")
            break
        time.sleep(1)

    if sb.execute_script(_EXISTS_JS):
        if not handle_turnstile(sb):
            sb.save_screenshot("login_turnstile_fail.png")
            # still try submit

    print("提交登录...")
    try:
        sb.press_keys('input[name="password"]', "\n")
    except Exception:
        try:
            sb.click('button[type="submit"]')
        except Exception:
            pass

    for _ in range(15):
        time.sleep(1)
        url = (sb.get_current_url() or "").lower()
        if "/auth/login" not in url and "katabump.com" in url and "error=" not in url:
            print(f"登录成功: {sb.get_current_url()}")
            return True
        if "error=captcha" in url:
            print(f"登录 captcha 失败: {sb.get_current_url()}")
            sb.save_screenshot("login_captcha.png")
            return False

    print(f"登录失败: {sb.get_current_url()}")
    sb.save_screenshot("login_failed.png")
    return False


def goto_server(sb, user: dict[str, Any]) -> bool:
    sid = resolve_server_id(user)
    if sid:
        url = f"{BASE_URL}/servers/edit?id={sid}"
        print(f"直达 server edit: {url}")
        sb.open(url)
        time.sleep(3)
        try:
            sb.find_element('button[data-bs-target="#renew-modal"],button:contains("Renew")', timeout=10)
            print("已看到 Renew 区域")
            return True
        except Exception:
            print("直达后未看到 Renew，尝试 See 链接")

    # See link discovery
    selectors = [
        'a[href*="/servers/edit?id="]',
        'td a[href*="/servers/edit"]',
        'table a[href*="/servers/edit"]',
    ]
    for sel in selectors:
        try:
            link = sb.find_element(sel, timeout=6)
            print(f"找到 See/edit 链接: {sel}")
            link.click()
            time.sleep(3)
            return True
        except Exception:
            continue

    try:
        for a in sb.find_elements("a"):
            if (a.text or "").strip().lower() == "see":
                a.click()
                time.sleep(3)
                return True
    except Exception:
        pass

    sb.save_screenshot("no_see.png")
    return False


def open_renew_modal(sb) -> bool:
    try:
        btn = sb.find_element('button[data-bs-target="#renew-modal"]', timeout=10)
    except Exception:
        try:
            btn = sb.find_element("button.btn.btn-outline-primary", timeout=5)
        except Exception:
            print("未找到 Renew 按钮")
            return False
    try:
        sb.execute_script(
            """
            var btn = document.querySelector('button[data-bs-target="#renew-modal"]')
                     || document.querySelector('button.btn.btn-outline-primary');
            if (btn) btn.scrollIntoView({behavior:'smooth',block:'center'});
            """
        )
    except Exception:
        pass
    time.sleep(0.6)
    btn.click()
    time.sleep(2.5)
    try:
        sb.find_element("div.modal.show", timeout=5)
        print("Renew 模态框已弹出")
        return True
    except Exception:
        print("模态框未弹出")
        return False


def solve_altcha(sb) -> bool:
    print("处理 ALTCHA...")
    time.sleep(1.5)
    if sb.execute_script(_ALTCHA_SOLVED_JS):
        print("ALTCHA 已通过")
        return True
    for attempt in range(5):
        if sb.execute_script(_ALTCHA_SOLVED_JS):
            print(f"ALTCHA 通过（第 {attempt + 1} 轮）")
            return True
        try:
            # click checkbox-ish area in modal
            cb = sb.find_element("div.modal.show input[type='checkbox']", timeout=2)
            cb.click()
        except Exception:
            try:
                iframe = sb.find_element("div.modal.show iframe", timeout=2)
                iframe.click()
            except Exception:
                pass
        time.sleep(2)
    return bool(sb.execute_script(_ALTCHA_SOLVED_JS))


def submit_renew(sb) -> str:
    try:
        # modal primary renew button
        modal_btn = sb.find_element(
            'div.modal.show button[type="submit"], div.modal.show button.btn-primary',
            timeout=5,
        )
        modal_btn.click()
        print("已点击确认 Renew")
    except Exception as e:
        print(f"点击确认失败: {e}")
        return "submit_failed"

    time.sleep(4)
    alert = ""
    try:
        el = sb.find_element("div.alert", timeout=6)
        alert = (el.text or "").strip()
    except Exception:
        pass
    lower = alert.lower()
    if "can't renew" in lower or "cannot renew" in lower or "not yet" in lower or "未到" in alert:
        return f"skip:{alert or 'not yet renew time'}"
    if "success" in lower or "renewed" in lower or "成功" in alert:
        return f"success:{alert or 'renewed'}"
    page = (sb.get_page_source() or "").lower()
    if "successfully" in page or "renewed" in page:
        return "success:page indicates renewed"
    return f"unknown:{alert or 'no clear result'}"


def process_account(sb, user: dict[str, Any]) -> dict[str, Any]:
    email = str(user.get("username") or "")
    password = str(user.get("password") or "")
    print(f"\n=== 处理 {mask_account(email)} ===")
    if not email or not password:
        return create_account_result(user, "失败", False, "账号配置不完整")

    if not login(sb, email, password):
        return create_account_result(user, "失败", False, "登录失败/captcha")

    if not goto_server(sb, user):
        return create_account_result(user, "失败", False, "登录后未找到服务器入口")

    if not open_renew_modal(sb):
        # maybe already renewed / no button
        return create_account_result(user, "跳过", True, "未找到 Renew 按钮，可能已续期")

    solve_altcha(sb)
    result = submit_renew(sb)
    if result.startswith("success"):
        return create_account_result(user, "续期成功", True, result)
    if result.startswith("skip"):
        return create_account_result(user, "跳过", True, result)
    return create_account_result(user, "失败", False, result)


def detect_local_proxy() -> str | None:
    if not PROXY_URL:
        return None
    try:
        r = requests.get("https://api.ipify.org", proxies={"http": SINGBOX_PROXY, "https": SINGBOX_PROXY}, timeout=12)
        print(f"[Proxy] sing-box ok, exit IP={r.text.strip()}")
        return SINGBOX_PROXY
    except Exception as e:
        print(f"[Proxy] sing-box not usable: {e}")
        return None


def main() -> int:
    accounts = get_accounts()
    if not accounts:
        payload = build_payload([], "USERS_JSON empty or test filter matched 0")
        send_webhook(payload)
        return 1

    proxy = detect_local_proxy()
    sb_kwargs: dict[str, Any] = {"uc": True, "headless": False}
    if proxy:
        # seleniumbase proxy format host:port or user:pass@host:port
        p = urlparse(proxy)
        sb_kwargs["proxy"] = f"{p.hostname}:{p.port or 8080}"
        print(f"[Proxy] SB proxy={sb_kwargs['proxy']}")
    else:
        print("[Proxy] direct / no sing-box")

    results: list[dict[str, Any]] = []
    top_error = None
    try:
        with SB(**sb_kwargs) as sb:
            try:
                sb.open("https://api.ipify.org")
                print(f"出口 IP 页面: {(sb.get_text('body') or '')[:64]}")
            except Exception:
                pass
            for user in accounts:
                try:
                    results.append(process_account(sb, user))
                except Exception as e:
                    print(f"账号异常: {e}")
                    traceback.print_exc()
                    try:
                        sb.save_screenshot(f"{account_id(user.get('username'))}_exception.png")
                    except Exception:
                        pass
                    results.append(create_account_result(user, "失败", False, str(e)))
    except Exception as e:
        top_error = str(e)
        print(f"浏览器启动失败: {e}")
        traceback.print_exc()

    payload = build_payload(results, top_error)
    print(payload["data"]["details_markdown"])
    send_webhook(payload)
    return 1 if payload["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
