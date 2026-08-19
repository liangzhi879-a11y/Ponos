#!/usr/bin/env python3
"""
深入查询企业详细信息：天眼查详情页 + 知识产权
目标：深圳市爱康泉水处理服务有限公司
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

os.makedirs(SCREENSHOT_DIR, exist_ok=True)
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

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

def safe_text(page, selector, timeout=5000):
    """Safely get text from a locator"""
    try:
        loc = page.locator(selector)
        if loc.count() > 0:
            return loc.first.inner_text(timeout=timeout)
    except:
        pass
    return ""

def query_tianyancha_detail():
    """天眼查企业详情页 - 获取基本信息/股东/主要人员/知识产权/资质"""
    log("=" * 60)
    log("天眼查 - 深入查询企业详情")

    results = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=200)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            # Direct to search URL
            log("搜索企业...")
            page.goto(f"https://www.tianyancha.com/search?key={ENTERPRISE_NAME}", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(5000)
            screenshot(page, "tyc_detail_search")

            # Get page text for analysis
            page_text = page.inner_text("body")
            results["search_page"] = page_text[:12000]

            # Try to click the first company result
            log("尝试进入企业详情页...")
            try:
                # Look for links containing the company name
                company_links = page.locator(f"a:has-text('深圳市爱康泉水处理服务有限公司')")
                count = company_links.count()
                log(f"找到 {count} 个包含公司名称的链接")

                if count > 0:
                    # Click the first one that looks like a company detail link
                    for i in range(count):
                        href = company_links.nth(i).get_attribute("href") or ""
                        if "/company/" in href:
                            log(f"点击详情链接: {href}")
                            company_links.nth(i).click()
                            page.wait_for_timeout(8000)
                            break

                screenshot(page, "tyc_detail_main")

                # Extract full page text
                detail_text = page.inner_text("body")
                results["detail_page"] = detail_text[:15000]  # Larger capture

                # Try to navigate to IP/knowledge section
                log("查找知识产权信息...")

                # Look for tabs/menus related to IP
                ip_tabs = [
                    "知识产权", "专利", "商标", "著作权", "软件著作权",
                    "知识产权", "专利信息", "商标信息", "资质证书"
                ]

                for tab_text in ip_tabs:
                    try:
                        tab = page.locator(f"text='{tab_text}'").first
                        if tab.count() > 0 and tab.is_visible():
                            log(f"点击 {tab_text} 标签...")
                            tab.click()
                            page.wait_for_timeout(3000)
                            ip_text = page.inner_text("body")
                            results[f"ip_{tab_text}"] = ip_text[:8000]
                            screenshot(page, f"tyc_{tab_text}")
                            break
                    except:
                        pass

                # Also try to find honors/qualifications
                log("查找荣誉资质信息...")
                honor_tabs = ["荣誉", "资质", "证书", "行政许可", "荣誉资质"]
                for tab_text in honor_tabs:
                    try:
                        tab = page.locator(f"text='{tab_text}'").first
                        if tab.count() > 0 and tab.is_visible():
                            log(f"点击 {tab_text} 标签...")
                            tab.click()
                            page.wait_for_timeout(3000)
                            honor_text = page.inner_text("body")
                            results[f"honor_{tab_text}"] = honor_text[:8000]
                            screenshot(page, f"tyc_{tab_text}")
                    except:
                        pass

                # Navigate to patent page directly
                log("尝试直接查询知识产权...")
                # Look for intellectual property section in the enterprise page
                page.goto(f"https://www.tianyancha.com/search?key={ENTERPRISE_NAME}&companyType=1", timeout=30000)
                page.wait_for_timeout(3000)

                # Get any accessible text on the detail page
                if "detail_page" not in results or not results["detail_page"]:
                    results["retry_detail"] = page.inner_text("body")[:10000]

            except Exception as e:
                log(f"详情页提取异常: {e}")
                screenshot(page, "tyc_detail_error")
                results["detail_error"] = str(e)

            log("天眼查详情查询完成")

        except Exception as e:
            log(f"天眼查查询异常: {e}")
            screenshot(page, "tyc_fatal_error")
            results["fatal_error"] = str(e)
        finally:
            browser.close()

    return results

def query_gsxt_direct():
    """直接查询国家企业信用信息公示系统"""
    log("=" * 60)
    log("尝试国家企业信用信息公示系统 - 直接搜索")

    results = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=200)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            # Use the Guangdong provincial GSXT site (more accessible than national)
            log("访问广东省市场监督管理局/公示系统...")
            page.goto("http://gsxt.gd.gov.cn/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(5000)
            screenshot(page, "gsxt_gd_home")

            results["page_text"] = page.inner_text("body")[:5000]

            # Try to search
            log(f"搜索: {ENTERPRISE_NAME}")
            try:
                # GSXT typically has a keyword input
                inputs = page.locator("input[type='text']")
                if inputs.count() > 0:
                    inputs.first.fill(ENTERPRISE_NAME)
                    page.wait_for_timeout(500)
                    # Look for search button
                    buttons = page.locator("button, input[type='button'], input[type='submit'], a.btn")
                    for i in range(min(buttons.count(), 5)):
                        btn_text = (buttons.nth(i).inner_text() or "").strip()
                        if "搜索" in btn_text or "查询" in btn_text or "search" in btn_text.lower():
                            buttons.nth(i).click()
                            page.wait_for_timeout(8000)
                            screenshot(page, "gsxt_gd_results")
                            results["search_results"] = page.inner_text("body")[:8000]
                            break
            except Exception as e:
                log(f"GSXT搜索异常: {e}")
                results["error"] = str(e)

            log("GSXT查询完成")

        except Exception as e:
            log(f"GSXT查询异常: {e}")
            results["fatal_error"] = str(e)
        finally:
            browser.close()

    return results

def query_ip_search():
    """直接在搜索引擎查询企业知识产权"""
    log("=" * 60)
    log("通过专利/商标平台查询知识产权...")

    results = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=200)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            # Search for company patents on Google/Bing
            log("通过网络搜索企业专利信息...")
            page.goto(f"https://www.bing.com/search?q={ENTERPRISE_NAME}+专利+知识产权", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "bing_ip_search")
            results["bing_search"] = page.inner_text("body")[:5000]

            # Also check cnipa (国家知识产权局)
            log("查询国家知识产权局...")
            page.goto(f"https://www.cnipa.gov.cn/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            results["cnipa"] = page.inner_text("body")[:3000]

            log("知识产权搜索完成")

        except Exception as e:
            log(f"IP搜索异常: {e}")
            results["error"] = str(e)
        finally:
            browser.close()

    return results

if __name__ == "__main__":
    log(f"深入查询: {ENTERPRISE_NAME}")
    log(f"时间: {datetime.now().isoformat()}")

    all_results = {}

    # Query in order
    try:
        all_results["tianyancha_detail"] = query_tianyancha_detail()
        time.sleep(3)
    except Exception as e:
        log(f"天眼查详情查询失败: {e}")
        all_results["tianyancha_detail"] = {"error": str(e)}

    try:
        all_results["gsxt"] = query_gsxt_direct()
        time.sleep(3)
    except Exception as e:
        log(f"GSXT查询失败: {e}")
        all_results["gsxt"] = {"error": str(e)}

    try:
        all_results["ip_search"] = query_ip_search()
    except Exception as e:
        log(f"IP搜索失败: {e}")
        all_results["ip_search"] = {"error": str(e)}

    # Save
    detail_file = os.path.join(SKILL_DIR, "verify_detail.json")
    with open(detail_file, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    log(f"详细结果已保存: {detail_file}")
    log("全部查询完成!")
