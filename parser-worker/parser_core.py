import asyncio
import urllib.parse
import openpyxl
import os
import re
import random
import time
from playwright.async_api import async_playwright, Error as PlaywrightError

MAX_FIRM_RETRIES = 2
MAX_PAGE_RETRIES = 3
SAVE_EVERY_N = 5
CONCURRENCY_LIMIT = 4
GRID_STEPS = 7
ZOOM = 13
LAT_MIN, LAT_MAX = 55.1, 56.2
LON_MIN, LON_MAX = 36.7, 38.4

CAPTCHA_MARKERS = ["подтвердите, что вы не робот", "капча", "captcha", "unusual traffic", "доступ ограничен"]


def get_firm_id(url):
    if not url:
        return None
    match = re.search(r'/firm/(\d+)', str(url))
    return match.group(1) if match else None


def generate_grid(lat_min, lat_max, lon_min, lon_max, steps):
    lat_step = (lat_max - lat_min) / steps
    lon_step = (lon_max - lon_min) / steps
    points = []
    for i in range(steps):
        for j in range(steps):
            lat = round(lat_min + lat_step * (i + 0.5), 6)
            lon = round(lon_min + lon_step * (j + 0.5), 6)
            col_letter = chr(65 + j)
            row_num = steps - i
            points.append((lat, lon, f"Сектор {col_letter}{row_num}"))
    points.sort(key=lambda x: x[2])
    return points


def normalize_text(t):
    return re.sub(r'\s+', ' ', (t or '')).strip().lower()


async def get_rubric_text(page):
    try:
        rubric = await page.evaluate("""() => {
            const candidates = Array.from(document.querySelectorAll('[class*="rubric" i], [class*="Rubric" i], a[href*="/rubric/"]'));
            for (const el of candidates) {
                const txt = (el.innerText || '').trim();
                if (txt && txt.length < 120) return txt;
            }
            const main = document.querySelector('main') || document.body;
            return (main.innerText || '').slice(0, 600);
        }""")
        return normalize_text(rubric)
    except Exception:
        return ""


def matches_keywords(rubric_text, title_text, keywords):
    if not keywords:
        return True
    haystack = f"{rubric_text} {title_text}".lower()
    return any(kw.lower().strip() in haystack for kw in keywords if kw.strip())


async def page_looks_like_captcha(page):
    try:
        text = normalize_text(await page.evaluate("() => document.body.innerText.slice(0, 2000)"))
    except Exception:
        return False
    return any(marker in text for marker in CAPTCHA_MARKERS)


class Job:
    """In-memory state for one parser run - one instance per niche card click."""

    def __init__(self, job_id, category, description, queries, out_dir):
        self.id = job_id
        self.category = category
        self.description = description
        self.queries = queries  # [{"query": str, "keywords": [str]}]
        self.out_dir = out_dir
        self.status = "queued"  # queued|running|captcha|done|error
        self.log_lines = []
        self.stats = {"collected": 0, "duplicates": 0, "filtered_out": 0, "errors": 0}
        self.raw_path = os.path.join(out_dir, "raw.xlsx")
        self.dedup_path = os.path.join(out_dir, "dedup.xlsx")
        self.archive_path = os.path.join(out_dir, "archive.zip")
        self.on_captcha = None  # async callback(job) -> None, set by the API layer

    def log(self, msg):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        self.log_lines.append(line)
        print(f"[{self.id}] {line}", flush=True)


async def process_firm(context, url, ws, wb, lock, semaphore, job, keywords):
    async with semaphore:
        for attempt in range(MAX_FIRM_RETRIES + 1):
            page = None
            try:
                page = await context.new_page()
                await page.route("**/*", lambda route: route.abort()
                    if route.request.resource_type in ["image", "stylesheet", "media", "font"]
                    else route.continue_())
                await page.goto(url, wait_until="domcontentloaded", timeout=25000)

                h1 = page.locator('h1')
                title = (await h1.first.inner_text()).split('\n')[0].strip() if await h1.count() > 0 else "Без названия"

                rubric_text = await get_rubric_text(page)
                if not matches_keywords(rubric_text, title, keywords):
                    await page.close()
                    async with lock:
                        job.stats["filtered_out"] += 1
                    return False

                geo = page.locator('a[href*="/geo/"]')
                address = (await geo.first.inner_text()).replace('\n', ', ').strip() if await geo.count() > 0 else "Не указан"

                await page.evaluate("""() => {
                    const btns = Array.from(document.querySelectorAll('button, div, span'));
                    btns.forEach(b => {
                        const t = (b.innerText || '').toLowerCase();
                        if (t.includes('показать телефон') || t.includes('соцсети') || t.includes('показать контакт')) {
                            try { b.click(); } catch(e) {}
                        }
                    });
                }""")
                await page.wait_for_timeout(random.randint(500, 1000))

                tels = page.locator('a[href^="tel:"]')
                phones = []
                for i in range(await tels.count()):
                    href = await tels.nth(i).get_attribute('href')
                    if href:
                        num = href.replace('tel:', '').strip()
                        if num and num not in phones:
                            phones.append(num)
                phone_str = ", ".join(phones) if phones else "Не указан"

                raw_data = await page.evaluate("""() => {
                    let results = [];
                    document.querySelectorAll('a').forEach(a => { if (a.href) results.push(a.href); });
                    return Array.from(new Set(results));
                }""")

                bad_domains = ["2gis", "yandex", "google", "flamp", "apple", "play.google", "otello", "restoclub", "tomesto", "zoon", "sbermarket", "megamarket", "delivery-club", "eda.yandex", "mos.ru", "gosuslugi", "w3.org", "github.com", "yoo.money"]
                good_indicators = [".ru", ".com", ".рф", ".org", ".net", ".info", ".su", ".pro", ".moscow", ".agency", ".media", ".digital", "vk.com", "t.me", "wa.me", "taplink.cc"]
                websites = []
                for val in raw_data:
                    val_lower = val.lower()
                    if "redirect?url=" in val_lower:
                        parsed = urllib.parse.parse_qs(urllib.parse.urlparse(val).query)
                        if "url" in parsed:
                            val = urllib.parse.unquote(parsed["url"][0])
                            val_lower = val.lower()
                    if any(ind in val_lower for ind in good_indicators) and not any(bd in val_lower for bd in bad_domains):
                        if "@" not in val and val not in websites:
                            websites.append(val if val_lower.startswith("http") else "https://" + val)

                real_sites = [w for w in websites if not any(s in w.lower() for s in ['vk.com', 't.me', 'instagram.com', 'wa.me', 'whatsapp.com'])]
                socials = [w for w in websites if any(s in w.lower() for s in ['vk.com', 't.me', 'instagram.com', 'wa.me', 'whatsapp.com'])]
                site_str = real_sites[0] if real_sites else (socials[0] if socials else "Нет сайта")

                site_label = "[WEB]"
                if "t.me" in site_str:
                    site_label = "[TG]"
                elif "vk.com" in site_str:
                    site_label = "[VK]"
                elif "wa.me" in site_str or "whatsapp" in site_str:
                    site_label = "[WA]"
                elif site_str == "Нет сайта":
                    site_label = "[---]"

                async with lock:
                    job.stats["collected"] += 1
                    curr_no = job.stats["collected"]
                    ws.append([curr_no, title, address, phone_str, site_str, site_label, url])
                    if curr_no % SAVE_EVERY_N == 0:
                        wb.save(job.raw_path)
                    job.log(f"[{curr_no}] {title} | {phone_str} | {site_label} {site_str}")

                return True

            except asyncio.CancelledError:
                raise
            except (PlaywrightError, Exception) as e:
                if attempt < MAX_FIRM_RETRIES:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                async with lock:
                    job.stats["errors"] += 1
                return False
            finally:
                if page:
                    try:
                        await page.close()
                    except Exception:
                        pass
        return False


async def collect_valid_hrefs(page):
    cards = page.locator('a[href*="/firm/"]')
    count = await cards.count()
    hrefs = []
    for i in range(count):
        href = await cards.nth(i).get_attribute('href')
        if href:
            hrefs.append(href)
    return hrefs


async def has_next_page(page):
    next_link = page.locator('a[rel="next"], a[href*="/page/"]')
    return await next_link.count() > 0


async def run_parser_job(job: Job):
    """Runs the full 2GIS grid scrape for job.queries, writing to job.raw_path.
    Mutates job.status/log/stats as it goes. Calls job.on_captcha(job) and
    pauses (awaiting resume) if a CAPTCHA page is detected."""
    os.makedirs(job.out_dir, exist_ok=True)
    job.status = "running"
    job.log(f"Старт парсинга ниши «{job.category}», запросов: {len(job.queries)}")

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "База"
    ws.append(["№", "Название", "Адрес", "Телефон", "Сайт", "Тип сайта", "URL"])
    wb.save(job.raw_path)

    saved_ids = set()
    lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(CONCURRENCY_LIMIT)
    grid_points = generate_grid(LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, GRID_STEPS)

    display = os.environ.get("DISPLAY", ":99")
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            env={**os.environ, "DISPLAY": display},
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale="ru-RU", timezone_id="Europe/Moscow", viewport={"width": 1280, "height": 720},
        )
        main_page = await context.new_page()

        try:
            for q_idx, item in enumerate(job.queries, 1):
                search_query = item["query"]
                keywords = item.get("keywords") or [w for w in re.split(r'\s+', search_query) if len(w) > 2]
                job.log(f"Запрос [{q_idx}/{len(job.queries)}]: '{search_query}'")
                encoded_query = urllib.parse.quote(search_query)

                for cell_idx, (lat, lon, sector_name) in enumerate(grid_points, 1):
                    page_num = 1
                    duplicate_pages = 0
                    while True:
                        search_url = f"https://2gis.ru/moscow/search/{encoded_query}/page/{page_num}?m={lon}%2C{lat}%2F{ZOOM}"
                        try:
                            await main_page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
                            await main_page.wait_for_timeout(1200)

                            if await page_looks_like_captcha(main_page):
                                job.status = "captcha"
                                job.log("⚠️ Обнаружена капча/блокировка 2ГИС — жду ручного решения (до 8 минут)")
                                if job.on_captcha:
                                    await job.on_captcha(job)
                                cleared = False
                                for _ in range(32):  # 32 * 15s = 8 min
                                    await asyncio.sleep(15)
                                    await main_page.reload(wait_until="domcontentloaded")
                                    if not await page_looks_like_captcha(main_page):
                                        cleared = True
                                        break
                                if not cleared:
                                    job.status = "error"
                                    job.log("🛑 Капча не решена вовремя, сектор пропущен")
                                    break
                                job.status = "running"
                                job.log("✅ Капча решена, продолжаю")

                            for _ in range(6):
                                current_count = await main_page.locator('a[href*="/firm/"]').count()
                                if current_count >= 24:
                                    break
                                await main_page.evaluate("window.scrollTo(0, document.body.scrollHeight);")
                                await main_page.wait_for_timeout(400)
                        except Exception as e:
                            job.log(f"Ошибка загрузки страницы: {e}")
                            break

                        hrefs = await collect_valid_hrefs(main_page)
                        if len(hrefs) == 0:
                            break

                        tasks = []
                        dup_count = 0
                        for href in hrefs:
                            firm_id = get_firm_id(href)
                            if not firm_id:
                                continue
                            if firm_id in saved_ids:
                                dup_count += 1
                                continue
                            clean = href.split('?')[0]
                            full_url = clean if clean.startswith('http') else f"https://2gis.ru{clean}"
                            saved_ids.add(firm_id)
                            tasks.append(process_firm(context, full_url, ws, wb, lock, semaphore, job, keywords))

                        async with lock:
                            job.stats["duplicates"] += dup_count

                        if tasks:
                            await asyncio.gather(*tasks, return_exceptions=True)

                        if not await has_next_page(main_page):
                            break
                        if dup_count == len(hrefs) and len(hrefs) > 0:
                            duplicate_pages += 1
                        else:
                            duplicate_pages = 0
                        if duplicate_pages >= 2:
                            break
                        page_num += 1
                        if page_num > 15:
                            break

                    if cell_idx % 10 == 0:
                        wb.save(job.raw_path)

                job.log(f"Готово: '{search_query}' — всего собрано {job.stats['collected']}")
        finally:
            wb.save(job.raw_path)
            await browser.close()

    job.status = "done"
    job.log(f"🏁 Парсинг завершён. Собрано: {job.stats['collected']}, дублей: {job.stats['duplicates']}, отфильтровано: {job.stats['filtered_out']}, ошибок: {job.stats['errors']}")


def get_domain(url):
    if not url:
        return None
    url_str = str(url).strip().lower()
    if url_str in ["нет сайта", "не указан"]:
        return None
    if not url_str.startswith('http'):
        url_str = 'http://' + url_str
    try:
        domain = urllib.parse.urlparse(url_str).netloc
        return domain[4:] if domain.startswith('www.') else domain
    except Exception:
        return None


def dedupe_franchises(raw_path, dedup_path):
    """Pure function version of clear_db.py's clean_franchises() - drops rows
    whose site domain repeats 2+ times (franchise chains), keeps the rest."""
    wb = openpyxl.load_workbook(raw_path)
    ws = wb.active

    domain_counts = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if len(row) >= 5:
            domain = get_domain(row[4])
            if domain:
                domain_counts[domain] = domain_counts.get(domain, 0) + 1

    franchise_domains = {d for d, c in domain_counts.items() if c >= 2}

    rows_to_delete = []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if len(row) >= 5 and get_domain(row[4]) in franchise_domains:
            rows_to_delete.append(i)
    for i in reversed(rows_to_delete):
        ws.delete_rows(i)
    for i, row in enumerate(ws.iter_rows(min_row=2), start=1):
        row[0].value = i

    wb.save(dedup_path)
    return {"deleted_rows": len(rows_to_delete), "franchise_domains": len(franchise_domains)}
