#!/usr/bin/env python3
"""
查询企业: 深圳市远方数据技术有限公司
v3: 持久化浏览器上下文保存登录态 + 改进登录检测
"""
import json
import time
import os
import sys
from datetime import datetime
from playwright.sync_api import sync_playwright

ENTERPRISE_NAME = "深圳市远方数据技术有限公司"
SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
SCREENSHOT_DIR = os.path.join(SKILL_DIR, "screenshots")
LOG_FILE = os.path.join(SKILL_DIR, "logs", "audit.log")
DATA_FILE = os.path.join(SKILL_DIR, "verify_yuanfang_data.json")
SIGNAL_FILE = os.path.join(SKILL_DIR, "login_done.txt")

# 持久化用户数据目录 —— 保存登录态
USER_DATA_BASE = os.path.join(SKILL_DIR, "browser_profiles")
TYC_PROFILE = os.path.join(USER_DATA_BASE, "tianyancha")
QCC_PROFILE = os.path.join(USER_DATA_BASE, "qcc")

os.makedirs(SCREENSHOT_DIR, exist_ok=True)
os.makedirs(TYC_PROFILE, exist_ok=True)
os.makedirs(QCC_PROFILE, exist_ok=True)

# Clean up old signal
if os.path.exists(SIGNAL_FILE):
    os.remove(SIGNAL_FILE)

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    sys.stdout.flush()
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def screenshot(page, name):
    path = os.path.join(SCREENSHOT_DIR, f"yf_{name}_{datetime.now().strftime('%H%M%S')}.png")
    page.screenshot(path=path, full_page=True)
    log(f"📸 截图: {os.path.basename(path)}")
    return path

def check_logged_in(page, platform="default"):
    """多信号检测登录状态"""
    try:
        text = page.inner_text("body") or ""
        url = page.url

        # 平台特定的已登录信号
        signals = {
            "tianyancha": {
                "positive": ["退出", "我的关注", "个人中心", "消息中心", "会员中心", "VIP"],
                "negative": ["登录/注册", "请登录", "扫码登录", "密码登录"],
                "url_positive": [],  # URL contains these = logged in
            },
            "qcc": {
                "positive": ["退出登录", "我的关注", "个人中心", "会员", "消息"],
                "negative": ["登录 | 注册", "登录/注册", "请登录"],
                "url_positive": [],
            },
            "default": {
                "positive": ["退出", "我的", "个人中心", "消息", "会员"],
                "negative": ["登录/注册", "请登录", "扫码登录", "密码登录", "短信登录"],
                "url_positive": [],
            }
        }

        cfg = signals.get(platform, signals["default"])

        # Check URL signals
        url_ok = any(s in url for s in cfg["url_positive"]) if cfg["url_positive"] else None

        # Check text signals
        has_positive = any(p in text for p in cfg["positive"])
        has_negative = any(n in text for n in cfg["negative"])

        # Logged in = has positive signals AND no negative signals
        is_logged = has_positive and not has_negative
        if is_logged:
            log(f"  ✅ 登录检测通过 (platform={platform}, positive={has_positive}, negative={has_negative})")

        # URL override: if URL has positive signal, consider logged in regardless
        if url_ok:
            log(f"  ✅ URL信号检测通过")
            is_logged = True

        return is_logged
    except Exception as e:
        log(f"  ⚠️ 登录检测异常: {e}")
        return False

def wait_for_login(page, platform_name, timeout=120):
    """等待用户登录 - 自动检测 + 信号文件 + 手动回车"""
    log(f"{'='*60}")
    log(f"⏳ 等待登录: {platform_name} (超时{timeout}秒)")

    # Check if already logged in from saved profile
    page.wait_for_timeout(2000)
    if check_logged_in(page, platform_name):
        log(f"🎉 已登录! (从持久化Profile恢复)")
        return True

    print(f"\n{'#'*60}")
    print(f"## 🔐 请在 {platform_name} 浏览器窗口中登录")
    print(f"##")
    print(f"## 💡 三种方式触发继续:")
    print(f"##    1. 登录后自动检测（推荐）")
    print(f"##    2. 创建文件: {SIGNAL_FILE}")
    print(f"##    3. 在此终端按 Enter 键")
    print(f"##")
    print(f"## ⏰ 超时: {timeout}秒")
    print(f"{'#'*60}\n")

    start = time.time()
    check_count = 0

    while time.time() - start < timeout:
        # Signal 1: File trigger
        if os.path.exists(SIGNAL_FILE):
            log("📨 信号文件触发!")
            os.remove(SIGNAL_FILE)
            time.sleep(2)
            return True

        # Signal 2: Auto-detect
        if check_logged_in(page, platform_name):
            return True

        check_count += 1
        elapsed = int(time.time() - start)
        if check_count % 10 == 0:  # Every ~20 seconds
            remaining = timeout - elapsed
            print(f"   ⏳ 等待中... ({elapsed}秒 / 剩余{remaining}秒)")
            log(f"等待登录... ({elapsed}秒)")

        time.sleep(2)

    log(f"⚠️ 登录等待超时 ({timeout}秒)")
    print(f"\n⚠️ 超时({timeout}秒)，跳过 {platform_name}")
    return False


def query_tianyancha():
    """天眼查 - 使用持久化 Profile"""
    log("=" * 60)
    log(f"🔍 天眼查: {ENTERPRISE_NAME} (持久化Profile)")

    result = {"platform": "tianyancha", "sections": {}}

    with sync_playwright() as p:
        # 关键：使用 launch_persistent_context 保存登录态
        log(f"Profile目录: {TYC_PROFILE}")
        context = p.chromium.launch_persistent_context(
            user_data_dir=TYC_PROFILE,
            headless=False,
            slow_mo=100,
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            args=["--no-first-run", "--no-default-browser-check"],
        )

        page = context.new_page()

        try:
            log("打开天眼查首页...")
            page.goto("https://www.tianyancha.com/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "tyc_home")

            # 等待登录（如果已持久化登录态，会自动检测通过）
            if not wait_for_login(page, "tianyancha", timeout=120):
                result["error"] = "登录超时"
                return result

            screenshot(page, "tyc_logged_in")

            # === 搜索企业 ===
            log("搜索企业...")
            search_url = f"https://www.tianyancha.com/search?key={ENTERPRISE_NAME}"
            page.goto(search_url, timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_search")

            # 查找并点击企业链接
            clicked = False
            try:
                # 用包含企业名的链接定位
                links = page.locator(f"a:has-text('{ENTERPRISE_NAME}')")
                count = links.count()
                log(f"搜索到 {count} 个匹配链接")

                for i in range(min(count, 10)):
                    try:
                        href = links.nth(i).get_attribute("href") or ""
                        text = links.nth(i).inner_text()[:60] or ""
                        log(f"  [{i}] href={href[:80]}, text={text}")
                        if "/company/" in href:
                            log(f"✅ 点击: {href}")
                            links.nth(i).click()
                            page.wait_for_timeout(8000)
                            clicked = True
                            break
                    except Exception as e:
                        continue
            except Exception as e:
                log(f"链接定位异常: {e}")

            screenshot(page, "tyc_detail")
            detail = page.inner_text("body")
            result["sections"]["detail"] = detail[:30000]
            log(f"📄 详情页: {len(detail)}字符")

            # 提取公司ID
            current_url = page.url
            log(f"当前URL: {current_url}")
            company_id = ""
            if "/company/" in current_url:
                company_id = current_url.split("/company/")[1].split("/")[0].split("?")[0]
                log(f"公司ID: {company_id}")

            if company_id:
                sections = [
                    ("patent", "专利"),
                    ("trademark", "商标"),
                    ("copyright", "著作权"),
                    ("cert", "资质证书"),
                    ("risk", "风险信息"),
                    ("change", "变更记录"),
                ]
                for section_id, section_name in sections:
                    log(f"查询{section_name}...")
                    url = f"https://www.tianyancha.com/company/{company_id}-{section_id}/"
                    page.goto(url, timeout=30000)
                    page.wait_for_timeout(4000)
                    screenshot(page, f"tyc_{section_id}")
                    result["sections"][section_id] = page.inner_text("body")[:15000]
                    log(f"  {section_name}: {len(result['sections'][section_id])}字符")
            else:
                log("⚠️ 无法提取公司ID，跳过子页面")

            log("✅ 天眼查查询完成")

        except Exception as e:
            log(f"❌ 天眼查异常: {e}")
            import traceback
            log(traceback.format_exc())
            result["error"] = str(e)
            screenshot(page, "tyc_error")
        finally:
            log("关闭浏览器...")
            page.close()
            context.close()

    return result


def query_qcc():
    """企查查 - 使用持久化 Profile"""
    log("=" * 60)
    log(f"🔍 企查查: {ENTERPRISE_NAME} (持久化Profile)")

    result = {"platform": "qcc", "sections": {}}

    with sync_playwright() as p:
        log(f"Profile目录: {QCC_PROFILE}")
        context = p.chromium.launch_persistent_context(
            user_data_dir=QCC_PROFILE,
            headless=False,
            slow_mo=100,
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            args=["--no-first-run", "--no-default-browser-check"],
        )

        page = context.new_page()

        try:
            log("打开企查查首页...")
            page.goto("https://www.qcc.com/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "qcc_home")

            # 等待登录（如果已持久化，会自动检测通过）
            if not wait_for_login(page, "qcc", timeout=120):
                result["error"] = "登录超时"
                return result

            screenshot(page, "qcc_logged_in")

            # 搜索
            log("搜索企业...")
            search_url = f"https://www.qcc.com/web/search?key={ENTERPRISE_NAME}"
            page.goto(search_url, timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "qcc_search")
            search_text = page.inner_text("body")
            result["sections"]["search"] = search_text[:10000]
            log(f"搜索结果: {len(search_text)}字符")

            # 点击第一个匹配结果
            clicked = False
            links = page.locator("a")
            count = links.count()
            for i in range(min(count, 200)):
                try:
                    href = links.nth(i).get_attribute("href") or ""
                    text = links.nth(i).inner_text() or ""
                    if ENTERPRISE_NAME in text and ("/firm/" in href or "/company/" in href):
                        log(f"✅ 点击: {href}")
                        links.nth(i).click()
                        page.wait_for_timeout(8000)
                        clicked = True
                        break
                except:
                    continue

            if not clicked:
                log("⚠️ 未找到企业详情链接，可能企业不在企查查中")

            screenshot(page, "qcc_detail")
            detail = page.inner_text("body")
            result["sections"]["detail"] = detail[:25000]
            log(f"📄 详情页: {len(detail)}字符")

            log("✅ 企查查查询完成")

        except Exception as e:
            log(f"❌ 企查查异常: {e}")
            import traceback
            log(traceback.format_exc())
            result["error"] = str(e)
            screenshot(page, "qcc_error")
        finally:
            log("关闭浏览器...")
            page.close()
            context.close()

    return result


def query_gsxt():
    """国家企业信用信息公示系统（无需登录）"""
    log("=" * 60)
    log(f"🔍 国家企业信用信息公示系统: {ENTERPRISE_NAME}")

    result = {"platform": "gsxt", "sections": {}}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = context.new_page()

        try:
            log("打开国家企业信用信息公示系统...")
            page.goto("https://www.gsxt.gov.cn/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(5000)
            screenshot(page, "gsxt_home")

            body_text = page.inner_text("body")
            result["sections"]["home"] = body_text[:5000]
            log(f"首页: {len(body_text)}字符")

            # Try to search
            try:
                # 尝试多种搜索框选择器
                search_selectors = [
                    "#searchtxt",
                    "input[placeholder*='搜索']",
                    "input[placeholder*='企业']",
                    "input[type='text']",
                ]
                search_box = None
                for sel in search_selectors:
                    candidate = page.locator(sel).first
                    if candidate.count() > 0:
                        search_box = candidate
                        break

                if search_box:
                    search_box.fill(ENTERPRISE_NAME)
                    search_box.press("Enter")
                    page.wait_for_timeout(8000)
                    screenshot(page, "gsxt_search")
                    search_result = page.inner_text("body")
                    result["sections"]["search_result"] = search_result[:10000]
                    log(f"搜索结果: {len(search_result)}字符")
                else:
                    log("未找到搜索框")
            except Exception as e:
                log(f"搜索异常: {e}")

            log("✅ 公示系统查询完成")

        except Exception as e:
            log(f"❌ 公示系统异常: {e}")
            result["error"] = str(e)
            screenshot(page, "gsxt_error")
        finally:
            page.wait_for_timeout(5000)
            browser.close()

    return result


if __name__ == "__main__":
    log("=" * 60)
    log(f"🏢 企业核验查询 v3（持久化登录态）")
    log(f"📋 目标: {ENTERPRISE_NAME}")
    log(f"🕐 时间: {datetime.now().isoformat()}")
    log(f"💾 登录态目录: {USER_DATA_BASE}")
    log("=" * 60)

    all_results = {
        "enterprise_name": ENTERPRISE_NAME,
        "query_time": datetime.now().isoformat(),
        "platforms": {}
    }

    # ====== 天眼查 ======
    print("\n" + "="*60)
    print(" 📍 第一步：天眼查 (tianyancha.com)")
    print(f"    目标: {ENTERPRISE_NAME}")
    print(f"    💡 登录态保存在: {TYC_PROFILE}")
    print("="*60)
    try:
        all_results["platforms"]["tianyancha"] = query_tianyancha()
        log("天眼查 ✅")
    except Exception as e:
        log(f"天眼查 ❌: {e}")
        all_results["platforms"]["tianyancha"] = {"error": str(e)}

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    # ====== 企查查 ======
    print("\n" + "="*60)
    print(" 📍 第二步：企查查 (qcc.com)")
    print(f"    目标: {ENTERPRISE_NAME}")
    print(f"    💡 登录态保存在: {QCC_PROFILE}")
    print("="*60)
    try:
        all_results["platforms"]["qcc"] = query_qcc()
        log("企查查 ✅")
    except Exception as e:
        log(f"企查查 ❌: {e}")
        all_results["platforms"]["qcc"] = {"error": str(e)}

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    # ====== 国家企业信用信息公示系统 ======
    print("\n" + "="*60)
    print(" 📍 第三步：国家企业信用信息公示系统")
    print(f"    目标: {ENTERPRISE_NAME}")
    print("    ℹ️ 无需登录")
    print("="*60)
    try:
        all_results["platforms"]["gsxt"] = query_gsxt()
        log("公示系统 ✅")
    except Exception as e:
        log(f"公示系统 ❌: {e}")
        all_results["platforms"]["gsxt"] = {"error": str(e)}

    # 最终保存
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    log("=" * 60)
    log(f"🎉 全部查询完成!")
    log(f"📁 结果文件: {DATA_FILE}")
    log(f"📁 截图目录: {SCREENSHOT_DIR}")
    log(f"💾 登录态已保存，下次无需重新登录")
    log("=" * 60)

    print(f"\n{'='*60}")
    print(f"🎉 查询完成!")
    print(f"结果: {DATA_FILE}")
    print(f"💡 下次查询将自动使用已保存的登录态，无需重新登录")
    print(f"{'='*60}")
