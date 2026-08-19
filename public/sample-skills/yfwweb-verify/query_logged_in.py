#!/usr/bin/env python3
"""
登录后深入查询：天眼查 + 企查查
步骤：
1. 打开天眼查 → 等待用户手动登录 → 进入企业详情页提取数据
2. 打开企查查 → 等待用户手动登录 → 进入企业详情页提取数据
"""
import json
import time
import os
from datetime import datetime
from playwright.sync_api import sync_playwright

ENTERPRISE_NAME = "深圳市爱康泉水处理服务有限公司"
UNIFIED_CODE = "91440300192398147F"
SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
SCREENSHOT_DIR = os.path.join(SKILL_DIR, "screenshots")
LOG_FILE = os.path.join(SKILL_DIR, "logs", "audit.log")
DATA_FILE = os.path.join(SKILL_DIR, "verify_logged_in.json")

os.makedirs(SCREENSHOT_DIR, exist_ok=True)

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

def wait_for_login(page, platform_name, timeout=120):
    """等待用户在浏览器中手动登录"""
    log(f"{'='*60}")
    log(f"⏳ 请在打开的 {platform_name} 浏览器窗口中手动登录")
    log(f"   超时时间: {timeout}秒")
    log(f"   登录完成后脚本将自动继续...")
    print(f"\n{'!'*60}")
    print(f"🔐 请在 {platform_name} 浏览器窗口中手动完成登录！")
    print(f"   登录成功后脚本会自动检测并继续...")
    print(f"{'!'*60}\n")

    # Wait for user to manually log in by checking for login indicators
    start = time.time()
    while time.time() - start < timeout:
        try:
            page_text = page.inner_text("body") or ""

            # Check for logged-in state indicators (various platforms)
            logged_in_indicators = [
                "退出登录", "退出", "个人中心", "我的", "会员中心",
                "已登录", "我的关注", "企业套餐", "消息中心",
            ]

            # Check for login page indicators (not logged in)
            login_indicators = [
                "登录/注册", "扫码登录", "密码登录", "短信登录",
                "手机号登录", "微信登录", "免费注册",
            ]

            is_logged_in = any(ind in page_text for ind in logged_in_indicators)
            is_login_page = any(ind in page_text for ind in login_indicators)

            if is_logged_in and not is_login_page:
                elapsed = time.time() - start
                log(f"✅ 检测到已登录状态！({elapsed:.0f}秒)")
                return True
        except:
            pass

        time.sleep(2)

    log(f"⚠️ 登录等待超时 ({timeout}秒)")
    return False


def query_tianyancha_logged_in():
    """天眼查 - 先登录，再查详情"""
    log("=" * 60)
    log("🔍 天眼查 - 登录后查询")

    result = {"platform": "tianyancha", "sections": {}}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            # Step 1: Go to tianyancha and wait for login
            log("导航到天眼查...")
            page.goto("https://www.tianyancha.com/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "tyc_before_login")

            # Wait for user to login
            if not wait_for_login(page, "天眼查", timeout=180):
                log("天眼查登录超时，跳过")
                result["error"] = "login_timeout"
                return result

            screenshot(page, "tyc_after_login")

            # Step 2: Search for the enterprise
            log(f"搜索企业: {ENTERPRISE_NAME}")
            page.goto(f"https://www.tianyancha.com/search?key={ENTERPRISE_NAME}", timeout=30000)
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_loggedin_search")

            # Step 3: Click into detail page
            log("进入企业详情页...")
            try:
                # Find and click company detail link
                links = page.locator(f"a:has-text('{ENTERPRISE_NAME}')")
                count = links.count()
                log(f"找到 {count} 个链接")

                clicked = False
                for i in range(count):
                    href = links.nth(i).get_attribute("href") or ""
                    if "/company/" in href:
                        log(f"点击: {href}")
                        links.nth(i).click()
                        page.wait_for_timeout(8000)
                        clicked = True
                        break

                if not clicked:
                    # Try direct URL
                    log("尝试直接访问详情页...")
                    page.goto("https://www.tianyancha.com/company/2323613741", timeout=30000)
                    page.wait_for_timeout(8000)

                screenshot(page, "tyc_loggedin_detail")

                # Extract full page content
                detail_text = page.inner_text("body")
                result["sections"]["detail_overview"] = detail_text[:20000]
                log(f"详情页提取完成: {len(detail_text)} 字符")

                # Step 4: Navigate to IP/KNOWLEDGE section
                log("查询知识产权板块...")
                try:
                    # Try clicking on IP tab
                    ip_selectors = [
                        "text=知识产权",
                        "text=专利信息",
                        "text=商标信息",
                        "text=软件著作权",
                        "a:has-text('知识产权')",
                        "span:has-text('知识产权')",
                    ]
                    for sel in ip_selectors:
                        try:
                            elem = page.locator(sel).first
                            if elem.count() > 0 and elem.is_visible():
                                log(f"点击 {sel}")
                                elem.click()
                                page.wait_for_timeout(4000)
                                ip_text = page.inner_text("body")
                                result["sections"]["intellectual_property"] = ip_text[:15000]
                                screenshot(page, "tyc_loggedin_ip")
                                log("知识产权板块提取完成")
                                break
                        except:
                            continue

                    # Try patent list
                    log("查询专利列表...")
                    page.goto(f"https://www.tianyancha.com/company/2323613741-patent/", timeout=30000)
                    page.wait_for_timeout(5000)
                    patent_text = page.inner_text("body")
                    result["sections"]["patents"] = patent_text[:15000]
                    screenshot(page, "tyc_loggedin_patents")

                    # Try trademark list
                    log("查询商标列表...")
                    page.goto(f"https://www.tianyancha.com/company/2323613741-trademark/", timeout=30000)
                    page.wait_for_timeout(5000)
                    tm_text = page.inner_text("body")
                    result["sections"]["trademarks"] = tm_text[:15000]
                    screenshot(page, "tyc_loggedin_trademarks")

                    # Try copyright list
                    log("查询软著列表...")
                    page.goto(f"https://www.tianyancha.com/company/2323613741-copyright/", timeout=30000)
                    page.wait_for_timeout(5000)
                    cr_text = page.inner_text("body")
                    result["sections"]["copyrights"] = cr_text[:15000]
                    screenshot(page, "tyc_loggedin_copyrights")

                    # Try honors/qualifications
                    log("查询资质证书...")
                    page.goto(f"https://www.tianyancha.com/company/2323613741-cert/", timeout=30000)
                    page.wait_for_timeout(5000)
                    cert_text = page.inner_text("body")
                    result["sections"]["certificates"] = cert_text[:15000]
                    screenshot(page, "tyc_loggedin_certs")

                except Exception as e:
                    log(f"IP板块查询异常: {e}")

                # Step 5: Risk/legal info
                log("查询风险信息...")
                try:
                    page.goto(f"https://www.tianyancha.com/company/2323613741-risk/", timeout=30000)
                    page.wait_for_timeout(5000)
                    risk_text = page.inner_text("body")
                    result["sections"]["risks"] = risk_text[:10000]
                    screenshot(page, "tyc_loggedin_risks")
                except Exception as e:
                    log(f"风险查询异常: {e}")

            except Exception as e:
                log(f"详情页查询异常: {e}")
                result["error"] = str(e)

            log("✅ 天眼查登录后查询完成")

        except Exception as e:
            log(f"天眼查查询异常: {e}")
            result["fatal_error"] = str(e)
        finally:
            # Keep browser open for a bit so user can see
            log("浏览器将在10秒后关闭...")
            page.wait_for_timeout(10000)
            browser.close()

    return result


def query_qcc_logged_in():
    """企查查 - 先登录，再查详情"""
    log("=" * 60)
    log("🔍 企查查 - 登录后查询")

    result = {"platform": "qcc", "sections": {}}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            log("导航到企查查...")
            page.goto("https://www.qcc.com/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "qcc_before_login")

            # Wait for user to login
            if not wait_for_login(page, "企查查", timeout=180):
                log("企查查登录超时，跳过")
                result["error"] = "login_timeout"
                return result

            screenshot(page, "qcc_after_login")

            # Search
            log(f"搜索企业: {ENTERPRISE_NAME}")
            # Use the search input
            try:
                search_input = page.locator("#searchKey")
                if search_input.count() == 0:
                    search_input = page.locator("input[type='text']").first
                search_input.fill(ENTERPRISE_NAME)
                search_input.press("Enter")
                page.wait_for_timeout(5000)
            except:
                page.goto(f"https://www.qcc.com/web/search?key={ENTERPRISE_NAME}", timeout=30000)
                page.wait_for_timeout(5000)

            screenshot(page, "qcc_loggedin_search")

            # Click into detail
            log("进入企业详情页...")
            try:
                links = page.locator(f"a:has-text('{ENTERPRISE_NAME}')")
                count = links.count()
                log(f"找到 {count} 个链接")

                for i in range(count):
                    href = links.nth(i).get_attribute("href") or ""
                    if "/firm/" in href or "/company/" in href:
                        log(f"点击: {href}")
                        links.nth(i).click()
                        page.wait_for_timeout(8000)
                        break

                screenshot(page, "qcc_loggedin_detail")
                detail_text = page.inner_text("body")
                result["sections"]["detail_overview"] = detail_text[:20000]
                log(f"详情页提取完成: {len(detail_text)} 字符")

                # Query IP section
                log("查询知识产权...")
                try:
                    ip_tabs = ["知识产权", "专利", "商标", "著作权"]
                    for tab_text in ip_tabs:
                        try:
                            elem = page.locator(f"text='{tab_text}'").first
                            if elem.count() > 0 and elem.is_visible():
                                elem.click()
                                page.wait_for_timeout(4000)
                                result["sections"][f"ip_{tab_text}"] = page.inner_text("body")[:12000]
                                screenshot(page, f"qcc_loggedin_{tab_text}")
                                break
                        except:
                            continue
                except:
                    pass

            except Exception as e:
                log(f"企查查详情异常: {e}")
                result["error"] = str(e)

            log("✅ 企查查登录后查询完成")

        except Exception as e:
            log(f"企查查查询异常: {e}")
            result["fatal_error"] = str(e)
        finally:
            log("浏览器将在10秒后关闭...")
            page.wait_for_timeout(10000)
            browser.close()

    return result


if __name__ == "__main__":
    log(f"=== 登录后查询: {ENTERPRISE_NAME} ===")
    log(f"时间: {datetime.now().isoformat()}")

    all_results = {}

    # Tianyancha first
    print("\n" + "="*60)
    print(" 第一步：天眼查")
    print("="*60)
    try:
        all_results["tianyancha"] = query_tianyancha_logged_in()
        log("天眼查完成，数据已保存")
    except Exception as e:
        log(f"天眼查失败: {e}")
        all_results["tianyancha"] = {"error": str(e)}

    # Save intermediate results
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    print("\n" + "="*60)
    print(" 第二步：企查查")
    print("="*60)
    try:
        all_results["qcc"] = query_qcc_logged_in()
        log("企查查完成，数据已保存")
    except Exception as e:
        log(f"企查查失败: {e}")
        all_results["qcc"] = {"error": str(e)}

    # Save final results
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    log(f"全部结果已保存: {DATA_FILE}")
    log("🎉 登录后查询全部完成!")
    print(f"\n结果已保存: {DATA_FILE}")
