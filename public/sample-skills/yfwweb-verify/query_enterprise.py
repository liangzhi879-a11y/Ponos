#!/usr/bin/env python3
"""
企业公开信息查询脚本
目标：深圳市爱康泉水处理服务有限公司
查询平台：国家企业信用信息公示系统 → 天眼查 → 企查查
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
DATA_FILE = os.path.join(SKILL_DIR, "verify_data.json")

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
    log(f"截图已保存: {path}")
    return path

def extract_company_info_from_page(page, platform):
    """从页面提取企业信息"""
    info = {"platform": platform, "query_time": datetime.now().isoformat(), "fields": {}}

    try:
        # Get the page text content for analysis
        info["page_text"] = page.inner_text("body")[:8000]  # First 8000 chars
    except Exception as e:
        info["page_text_extract_error"] = str(e)

    return info

def query_tianyancha():
    """通过天眼查查询企业信息"""
    log("=" * 60)
    log("开始查询天眼查...")

    results = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            # Step 1: Navigate to tianyancha search
            log("导航到天眼查首页...")
            page.goto("https://www.tianyancha.com/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "tyc_home")

            # Step 2: Search for the enterprise
            log(f"搜索企业: {ENTERPRISE_NAME}")
            try:
                search_input = page.locator("#header-company-search").or_else(
                    page.locator("input[placeholder*='搜索']").or_else(
                        page.locator("#contact-search-input").or_else(
                            page.get_by_role("textbox").first
                        )
                    )
                )
                if search_input:
                    search_input.fill(ENTERPRISE_NAME)
                    page.wait_for_timeout(500)
                    # Press Enter or click search button
                    search_input.press("Enter")
                    page.wait_for_timeout(5000)
                else:
                    log("未找到搜索框，尝试直接URL搜索")
                    page.goto(f"https://www.tianyancha.com/search?key={ENTERPRISE_NAME}", timeout=30000)
                    page.wait_for_timeout(5000)
            except Exception as e:
                log(f"搜索框定位失败: {e}")
                page.goto(f"https://www.tianyancha.com/search?key={ENTERPRISE_NAME}", timeout=30000)
                page.wait_for_timeout(5000)

            screenshot(page, "tyc_search_result")

            # Extract search results
            info = extract_company_info_from_page(page, "tianyancha")
            info["stage"] = "search_results"
            results.append(info)

            # Step 3: Click on the first search result
            log("尝试进入企业详情页...")
            try:
                # Try various selectors for the first result
                first_result = page.locator(".search-result-single a").first.or_else(
                    page.locator(".result-list a").first.or_else(
                        page.locator("a[href*='/company/']").first.or_else(
                            page.locator(".company-title a").first
                        )
                    )
                )
                if first_result:
                    first_result.click()
                    page.wait_for_timeout(5000)
                    screenshot(page, "tyc_detail")
                    detail_info = extract_company_info_from_page(page, "tianyancha")
                    detail_info["stage"] = "detail_page"
                    results.append(detail_info)
                else:
                    log("未找到搜索结果链接")
            except Exception as e:
                log(f"进入详情页失败: {e}")

            log("天眼查查询完成")

        except Exception as e:
            log(f"天眼查查询异常: {e}")
            screenshot(page, "tyc_error")
        finally:
            browser.close()

    return results

def query_qcc():
    """通过企查查查询企业信息"""
    log("=" * 60)
    log("开始查询企查查...")

    results = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            log("导航到企查查首页...")
            page.goto("https://www.qcc.com/", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            screenshot(page, "qcc_home")

            # Search
            log(f"搜索企业: {ENTERPRISE_NAME}")
            try:
                search_input = page.locator("#searchKey").or_else(
                    page.locator("input[placeholder*='搜索']").or_else(
                        page.get_by_role("textbox").first
                    )
                )
                if search_input:
                    search_input.fill(ENTERPRISE_NAME)
                    page.wait_for_timeout(500)
                    search_input.press("Enter")
                    page.wait_for_timeout(5000)
                else:
                    log("未找到搜索框，尝试直接URL搜索")
                    page.goto(f"https://www.qcc.com/web/search?key={ENTERPRISE_NAME}", timeout=30000)
                    page.wait_for_timeout(5000)
            except Exception as e:
                log(f"企查查搜索框定位失败: {e}")
                page.goto(f"https://www.qcc.com/web/search?key={ENTERPRISE_NAME}", timeout=30000)
                page.wait_for_timeout(5000)

            screenshot(page, "qcc_search_result")

            info = extract_company_info_from_page(page, "qcc")
            info["stage"] = "search_results"
            results.append(info)

            # Try to enter detail page
            log("尝试进入详情页...")
            try:
                first_result = page.locator("a[href*='/firm/']").first.or_else(
                    page.locator(".company-title a").first.or_else(
                        page.locator(".mainlist a").first
                    )
                )
                if first_result:
                    first_result.click()
                    page.wait_for_timeout(5000)
                    screenshot(page, "qcc_detail")
                    detail_info = extract_company_info_from_page(page, "qcc")
                    detail_info["stage"] = "detail_page"
                    results.append(detail_info)
                else:
                    log("未找到搜索结果链接")
            except Exception as e:
                log(f"进入详情页失败: {e}")

            log("企查查查询完成")

        except Exception as e:
            log(f"企查查查询异常: {e}")
            screenshot(page, "qcc_error")
        finally:
            browser.close()

    return results

def query_gsxt():
    """通过国家企业信用信息公示系统查询"""
    log("=" * 60)
    log("开始查询国家企业信用信息公示系统...")

    results = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        try:
            log("导航到国家企业信用信息公示系统...")
            page.goto("https://www.gsxt.gov.cn/index.html", timeout=30000, wait_until="domcontentloaded")
            page.wait_for_timeout(5000)
            screenshot(page, "gsxt_home")

            # Search
            log(f"搜索企业: {ENTERPRISE_NAME}")
            try:
                search_input = page.locator("#keyword").or_else(
                    page.locator("input[placeholder*='搜索']").or_else(
                        page.locator("input[type='text']").first.or_else(
                            page.get_by_role("textbox").first
                        )
                    )
                )
                if search_input:
                    search_input.fill(ENTERPRISE_NAME)
                    page.wait_for_timeout(500)
                    # Click search button
                    search_btn = page.locator("#btn_query").or_else(
                        page.locator("button:has-text('查询')").or_else(
                            page.locator("input[type='submit']")
                        )
                    )
                    if search_btn:
                        search_btn.click()
                    else:
                        search_input.press("Enter")
                    page.wait_for_timeout(8000)
                    screenshot(page, "gsxt_search_result")
                else:
                    log("未找到搜索框")
            except Exception as e:
                log(f"公示系统搜索失败: {e}")

            info = extract_company_info_from_page(page, "gsxt")
            info["stage"] = "search_results"
            results.append(info)

            # Try to enter detail page
            log("尝试进入详情页...")
            try:
                first_result = page.locator("a.search_fun").first.or_else(
                    page.locator("a[href*='detail']").first.or_else(
                        page.locator(".search_list a").first
                    )
                )
                if first_result:
                    first_result.click()
                    page.wait_for_timeout(5000)
                    screenshot(page, "gsxt_detail")
                    detail_info = extract_company_info_from_page(page, "gsxt")
                    detail_info["stage"] = "detail_page"
                    results.append(detail_info)
                else:
                    log("未找到搜索结果链接")
            except Exception as e:
                log(f"进入详情页失败: {e}")

            log("国家企业信用信息公示系统查询完成")

        except Exception as e:
            log(f"公示系统查询异常: {e}")
            screenshot(page, "gsxt_error")
        finally:
            browser.close()

    return results

if __name__ == "__main__":
    log(f"开始查询企业: {ENTERPRISE_NAME}")
    log(f"查询时间: {datetime.now().isoformat()}")

    all_results = {}

    # Query platforms in order
    try:
        all_results["gsxt"] = query_gsxt()
        time.sleep(3)
    except Exception as e:
        log(f"公示系统查询失败: {e}")
        all_results["gsxt"] = [{"error": str(e)}]

    try:
        all_results["tianyancha"] = query_tianyancha()
        time.sleep(3)
    except Exception as e:
        log(f"天眼查查询失败: {e}")
        all_results["tianyancha"] = [{"error": str(e)}]

    try:
        all_results["qcc"] = query_qcc()
        time.sleep(3)
    except Exception as e:
        log(f"企查查查询失败: {e}")
        all_results["qcc"] = [{"error": str(e)}]

    # Save all results
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    log(f"查询结果已保存: {DATA_FILE}")
    log("全部查询完成!")
