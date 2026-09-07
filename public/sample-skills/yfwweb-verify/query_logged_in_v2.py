#!/usr/bin/env python3
"""
改进版：登录后查询 - 天眼查 + 企查查
改进点：
1. 文件信号确认：用户在 Skill 目录创建 login_done.txt 表示登录完成
2. 更长的等待时间
3. 改进页面检测逻辑
"""
import json
import time
import os
from datetime import datetime
from playwright.sync_api import sync_playwright

ENTERPRISE_NAME = "深圳市爱康泉水处理服务有限公司"
SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
SCREENSHOT_DIR = os.path.join(SKILL_DIR, "screenshots")
LOG_FILE = os.path.join(SKILL_DIR, "logs", "audit.log")
DATA_FILE = os.path.join(SKILL_DIR, "verify_logged_in_v2.json")
SIGNAL_FILE = os.path.join(SKILL_DIR, "login_done.txt")

os.makedirs(SCREENSHOT_DIR, exist_ok=True)

# Clean up any old signal file
if os.path.exists(SIGNAL_FILE):
    os.remove(SIGNAL_FILE)

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def screenshot(page, name):
    path = os.path.join(SCREENSHOT_DIR, f"{name}_{datetime.now().strftime('%H%M%S')}.png")
    page.screenshot(path=path, full_page=True)
    log(f"截图: {path}")
    return path

def check_logged_in(page):
    """检测是否已登录"""
    try:
        text = page.inner_text("body") or ""
        # Positive indicators (logged in)
        positive = ["退出", "我的", "个人中心", "消息", "会员"]
        # Negative indicators (logged out)
        negative = ["登录/注册", "请登录", "扫码登录", "密码登录", "短信登录"]

        has_positive = any(p in text for p in positive)
        has_negative = any(n in text for n in negative)

        # If we see positive AND don't see the main login prompts
        if has_positive and "登录/注册" not in text:
            return True

        return False
    except:
        return False

def wait_for_user_login(page, platform_name):
    """等待用户登录 - 自动检测 + 文件信号"""
    log(f"{'='*60}")
    log(f"⏳ 等待用户在 {platform_name} 登录...")

    print(f"\n{'#'*60}")
    print(f"## 🔐 请在 {platform_name} 浏览器窗口中登录！")
    print(f"##")
    print(f"## 登录后，我会自动检测并继续。")
    print(f"## 如果超过2分钟未检测到，请在此目录创建文件:")
    print(f"##   {SIGNAL_FILE}")
    print(f"##")
    print(f"## 等待中...")
    print(f"{'#'*60}\n")

    check_count = 0
    while True:
        # Check signal file (manual trigger)
        if os.path.exists(SIGNAL_FILE):
            log("📨 检测到手动确认信号文件！")
            os.remove(SIGNAL_FILE)
            # Give a moment for page to settle
            time.sleep(2)
            return True

        # Auto-detect login state
        if check_logged_in(page):
            log("✅ 自动检测到已登录状态！")
            return True

        check_count += 1
        if check_count % 15 == 0:  # Every ~30 seconds
            elapsed = check_count * 2
            log(f"   仍在等待... ({elapsed}秒)")
            print(f"   等待中... ({elapsed}秒) - 登录后如需手动触发请创建 login_done.txt")

        time.sleep(2)

def query_tianyancha_v2():
    """天眼查 v2"""
    log("=" * 60)
    log("🔍 天眼查 - 登录后查询 v2")

    result = {"platform": "tianyancha", "sections": {}}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=200)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            log("打开天眼查...")
            page.goto("https://www.tianyancha.com/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "tyc_v2_start")

            # Wait for user to log in
            wait_for_user_login(page, "天眼查")
            screenshot(page, "tyc_v2_logged_in")

            # === Now navigate through sections ===

            # 1. Search and go to detail
            log("搜索企业并进入详情页...")
            page.goto(f"https://www.tianyancha.com/search?key={ENTERPRISE_NAME}", timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_v2_search")

            # Click into detail
            clicked = False
            links = page.locator(f"a:has-text('{ENTERPRISE_NAME}')")
            count = links.count()
            log(f"搜索到 {count} 个链接")
            for i in range(count):
                href = links.nth(i).get_attribute("href") or ""
                if "/company/" in href:
                    log(f"点击企业链接: {href}")
                    links.nth(i).click()
                    page.wait_for_timeout(8000)
                    clicked = True
                    break

            if not clicked:
                log("直接访问详情URL...")
                page.goto("https://www.tianyancha.com/company/2323613741", timeout=30000)
                page.wait_for_timeout(8000)

            screenshot(page, "tyc_v2_detail")
            detail = page.inner_text("body")
            result["sections"]["detail"] = detail[:25000]
            log(f"详情: {len(detail)}字符")

            # 2. Patents
            log("查询专利...")
            page.goto("https://www.tianyancha.com/company/2323613741-patent/", timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_v2_patents")
            result["sections"]["patents"] = page.inner_text("body")[:20000]

            # 3. Trademarks
            log("查询商标...")
            page.goto("https://www.tianyancha.com/company/2323613741-trademark/", timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_v2_trademarks")
            result["sections"]["trademarks"] = page.inner_text("body")[:20000]

            # 4. Copyrights
            log("查询著作权...")
            page.goto("https://www.tianyancha.com/company/2323613741-copyright/", timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_v2_copyrights")
            result["sections"]["copyrights"] = page.inner_text("body")[:20000]

            # 5. Certificates / Qualifications
            log("查询资质证书...")
            page.goto("https://www.tianyancha.com/company/2323613741-cert/", timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_v2_certs")
            result["sections"]["certificates"] = page.inner_text("body")[:20000]

            # 6. Risks
            log("查询风险信息...")
            page.goto("https://www.tianyancha.com/company/2323613741-risk/", timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_v2_risks")
            result["sections"]["risks"] = page.inner_text("body")[:15000]

            # 7. Changes
            log("查询变更记录...")
            page.goto("https://www.tianyancha.com/company/2323613741-change/", timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_v2_changes")
            result["sections"]["changes"] = page.inner_text("body")[:15000]

            log("✅ 天眼查 v2 全部查询完成")

        except Exception as e:
            log(f"天眼查异常: {e}")
            result["error"] = str(e)
            screenshot(page, "tyc_v2_error")
        finally:
            log("浏览器保持打开30秒供查看...")
            page.wait_for_timeout(30000)
            browser.close()

    return result


def query_qcc_v2():
    """企查查 v2"""
    log("=" * 60)
    log("🔍 企查查 - 登录后查询 v2")

    result = {"platform": "qcc", "sections": {}}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=200)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            log("打开企查查...")
            page.goto("https://www.qcc.com/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "qcc_v2_start")

            # Check if already logged in
            if check_logged_in(page):
                log("企查查已处于登录状态")
            else:
                wait_for_user_login(page, "企查查")

            screenshot(page, "qcc_v2_logged_in")

            # Search
            log("搜索企业...")
            try:
                search_box = page.locator("#searchKey")
                if search_box.count() > 0:
                    search_box.fill(ENTERPRISE_NAME)
                    search_box.press("Enter")
                else:
                    # Try other selectors
                    inputs = page.locator("input[type='text']")
                    if inputs.count() > 0:
                        inputs.first.fill(ENTERPRISE_NAME)
                        inputs.first.press("Enter")
                    else:
                        page.goto(f"https://www.qcc.com/web/search?key={ENTERPRISE_NAME}", timeout=30000)
            except:
                page.goto(f"https://www.qcc.com/web/search?key={ENTERPRISE_NAME}", timeout=30000)

            page.wait_for_timeout(5000)
            screenshot(page, "qcc_v2_search")
            search_text = page.inner_text("body")
            log(f"搜索结果: {len(search_text)}字符")
            result["sections"]["search"] = search_text[:10000]

            # Click first result
            clicked = False
            links = page.locator("a")
            count = links.count()
            for i in range(count):
                try:
                    href = links.nth(i).get_attribute("href") or ""
                    text = links.nth(i).inner_text() or ""
                    if ENTERPRISE_NAME in text and ("/firm/" in href or "/company/" in href):
                        log(f"点击: {href}")
                        links.nth(i).click()
                        page.wait_for_timeout(8000)
                        clicked = True
                        break
                except:
                    continue

            if not clicked:
                log("⚠️ 未找到企业详情链接，尝试直接搜索URL")

            screenshot(page, "qcc_v2_detail")
            detail = page.inner_text("body")
            result["sections"]["detail"] = detail[:25000]
            log(f"详情: {len(detail)}字符")

            log("✅ 企查查 v2 查询完成")

        except Exception as e:
            log(f"企查查异常: {e}")
            result["error"] = str(e)
            screenshot(page, "qcc_v2_error")
        finally:
            log("浏览器保持打开30秒...")
            page.wait_for_timeout(30000)
            browser.close()

    return result


if __name__ == "__main__":
    log(f"=== v2 登录后查询: {ENTERPRISE_NAME} ===")
    log(f"信号文件: {SIGNAL_FILE}")
    log(f"时间: {datetime.now().isoformat()}")

    all_results = {}

    # Tianyancha
    print("\n" + "="*60)
    print(" 第一步：天眼查")
    print(f" 手动确认方式：在以下目录创建 login_done.txt")
    print(f" {SKILL_DIR}")
    print("="*60)

    try:
        all_results["tianyancha"] = query_tianyancha_v2()
        log("天眼查 v2 完成")
    except Exception as e:
        log(f"天眼查 v2 失败: {e}")
        all_results["tianyancha"] = {"error": str(e)}

    # Save intermediate
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    # QCC
    print("\n" + "="*60)
    print(" 第二步：企查查")
    print(f" 手动确认方式：在以下目录创建 login_done.txt")
    print(f" {SKILL_DIR}")
    print("="*60)

    try:
        all_results["qcc"] = query_qcc_v2()
        log("企查查 v2 完成")
    except Exception as e:
        log(f"企查查 v2 失败: {e}")
        all_results["qcc"] = {"error": str(e)}

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    log(f"全部完成! 结果: {DATA_FILE}")
    print(f"\n✅ 完成! 结果: {DATA_FILE}")
