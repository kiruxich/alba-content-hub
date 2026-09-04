"""Ядро ScrapeGraphAI-воркера: поиск сайтов компаний по нише и городу,
извлечение контактов с каждого сайта и выгрузка в XLSX.

Отличие от parser-worker (2ГИС): тот ходит в один известный каталог по
фиксированной вёрстке, а этот работает по произвольным сайтам, где вёрстку
заранее знать нельзя - разбором занимается LLM. Модель локальная (Ollama,
см. OLLAMA_BASE_URL/SCRAPE_MODEL), а не платный API: страниц на одну нишу
уходит много, и по токенам это дешевле любого облака.

Колонки на выходе намеренно повторяют 2ГИС-выгрузку
(Название/Адрес/Телефон/Сайт), чтобы обе базы сливались в одну сводную без
маппинга полей - см. mergeCustomerBases() на стороне хаба.
"""
import asyncio
import os
import re
import time

import openpyxl
from playwright.async_api import async_playwright

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434")
SCRAPE_MODEL = os.environ.get("SCRAPE_MODEL", "qwen2.5:7b")
PAGE_TIMEOUT_MS = int(os.environ.get("SCRAPE_PAGE_TIMEOUT_MS", "25000"))
MAX_PAGE_CHARS = int(os.environ.get("SCRAPE_MAX_PAGE_CHARS", "12000"))

EXTRACT_PROMPT = (
    "Извлеки данные организации со страницы. Верни JSON с полями: "
    "name (название организации), address (полный адрес или пустая строка), "
    "phones (массив телефонов), emails (массив email), "
    "telegram, vk, instagram, whatsapp (ссылки или юзернеймы, пустая строка если нет), "
    "description (одно предложение о том, чем занимается компания). "
    "Не выдумывай данные: если чего-то на странице нет, оставь пустую строку или пустой массив."
)

# Страницы, где контакты лежат чаще всего - если на главной пусто, пробуем их.
CONTACT_PATHS = ["/contacts", "/kontakty", "/contact", "/about", "/o-nas"]


class Job:
    def __init__(self, job_id, category, city, sites, out_dir, max_sites=30):
        self.id = job_id
        self.category = category
        self.city = city or ""
        self.sites = sites or []
        self.out_dir = out_dir
        self.max_sites = max_sites
        self.status = "queued"
        self.log_lines = []
        self.stats = {"sites_total": 0, "sites_done": 0, "with_contacts": 0, "failed": 0}
        self.rows = []
        self.task = None
        self.cancelled = False
        os.makedirs(out_dir, exist_ok=True)

    @property
    def raw_path(self):
        return os.path.join(self.out_dir, "scrape_raw.xlsx")

    def log(self, line):
        stamp = time.strftime("%H:%M:%S")
        self.log_lines.append(f"[{stamp}] {line}")
        if len(self.log_lines) > 500:
            self.log_lines = self.log_lines[-500:]


def normalize_url(url):
    url = (url or "").strip()
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def domain_of(url):
    m = re.match(r"https?://([^/]+)", normalize_url(url))
    return (m.group(1) if m else "").lower().replace("www.", "")


def build_graph_config():
    """Конфиг ScrapeGraphAI под локальную Ollama.

    format=json заставляет Ollama возвращать валидный JSON на уровне самого
    сервера, а не надеяться на послушность модели - иначе на длинных
    страницах qwen регулярно доклеивает прозу вокруг объекта.
    """
    return {
        "llm": {
            "model": f"ollama/{SCRAPE_MODEL}",
            "base_url": OLLAMA_BASE_URL,
            "temperature": 0,
            "format": "json",
            "model_tokens": int(os.environ.get("SCRAPE_MODEL_TOKENS", "16384")),
        },
        "embeddings": {
            "model": f"ollama/{os.environ.get('SCRAPE_EMBED_MODEL', 'nomic-embed-text')}",
            "base_url": OLLAMA_BASE_URL,
        },
        "verbose": False,
        "headless": True,
    }


async def fetch_page_text(browser, url):
    """Playwright + вытаскивание видимого текста.

    Грузим страницу сами, а не отдаём URL внутрь ScrapeGraphAI: свой браузер
    уже поднят под весь job (экономит секунды на каждом сайте), и заодно
    сразу видно, отдал ли сайт хоть что-то - мёртвые домены отсеиваются до
    того, как за них заплатят токенами.
    """
    page = await browser.new_page()
    try:
        await page.goto(url, timeout=PAGE_TIMEOUT_MS, wait_until="domcontentloaded")
        await page.wait_for_timeout(1200)
        text = await page.evaluate("() => document.body ? document.body.innerText : ''")
        html_links = await page.evaluate(
            "() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href).slice(0, 300)"
        )
        return (text or "").strip(), html_links or []
    finally:
        await page.close()


def extract_with_llm(page_text, url):
    """Разбор текста страницы моделью через ScrapeGraphAI.

    Импорт внутри функции: пакет тянет за собой пол-LangChain, и на старте
    контейнера это лишние секунды, пока ни одного job'а ещё нет.
    """
    from scrapegraphai.graphs import SmartScraperGraph

    graph = SmartScraperGraph(
        prompt=EXTRACT_PROMPT,
        source=page_text[:MAX_PAGE_CHARS],
        config=build_graph_config(),
    )
    return graph.run()


def as_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if value is None:
        return []
    s = str(value).strip()
    return [s] if s else []


def first_or_empty(value):
    items = as_list(value)
    return items[0] if items else ""


def harvest_contacts_from_text(text):
    """Регулярки как страховка поверх модели.

    Телефон и email - единственные поля, которые надёжно ловятся без LLM;
    если модель их проглядела (а на длинных страницах это бывает), берём то,
    что нашлось текстом, и не теряем лид целиком.
    """
    emails = re.findall(r"[\w.+-]+@[\w-]+\.[\w.]{2,}", text or "")
    phones = re.findall(r"\+?\d[\d\-\s()]{9,17}\d", text or "")
    clean_phones = []
    for p in phones:
        digits = re.sub(r"\D", "", p)
        if 10 <= len(digits) <= 15:
            clean_phones.append(p.strip())
    return list(dict.fromkeys(emails))[:5], list(dict.fromkeys(clean_phones))[:5]


async def run_scrape_job(job: Job):
    job.status = "running"
    sites = [normalize_url(s) for s in job.sites if normalize_url(s)]
    # Дедуп по домену: поисковая выдача постоянно возвращает один сайт
    # несколькими URL (с /, с utm, с www) - платить за него дважды незачем.
    seen_domains = set()
    unique_sites = []
    for s in sites:
        d = domain_of(s)
        if d and d not in seen_domains:
            seen_domains.add(d)
            unique_sites.append(s)
    unique_sites = unique_sites[: job.max_sites]

    job.stats["sites_total"] = len(unique_sites)
    job.log(f"Ниша «{job.category}»{f', город {job.city}' if job.city else ''}: сайтов к обходу — {len(unique_sites)}")
    if not unique_sites:
        job.status = "error"
        job.log("Нет ни одного сайта для обхода — поиск ничего не вернул")
        return

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            for i, url in enumerate(unique_sites, 1):
                if job.cancelled:
                    raise asyncio.CancelledError()
                job.log(f"({i}/{len(unique_sites)}) {domain_of(url)}")
                try:
                    text, links = await fetch_page_text(browser, url)
                    if len(text) < 200:
                        # Пустая главная (SPA/заглушка) - пробуем страницу контактов.
                        for path in CONTACT_PATHS:
                            candidate = url.rstrip("/") + path
                            try:
                                alt_text, _ = await fetch_page_text(browser, candidate)
                                if len(alt_text) > len(text):
                                    text = alt_text
                                    break
                            except Exception:
                                continue
                    if len(text) < 100:
                        job.stats["failed"] += 1
                        job.log("  пусто — пропуск")
                        continue

                    # Страница контактов почти всегда содержательнее главной,
                    # поэтому если ссылка на неё есть - дочитываем и её.
                    contact_link = next(
                        (l for l in links if re.search(r"contact|kontakt|контакт", l, re.I) and domain_of(l) == domain_of(url)),
                        None,
                    )
                    if contact_link:
                        try:
                            c_text, _ = await fetch_page_text(browser, contact_link)
                            text = (text + "\n\n" + c_text)[: MAX_PAGE_CHARS * 2]
                        except Exception:
                            pass

                    data = await asyncio.to_thread(extract_with_llm, text, url)
                    if not isinstance(data, dict):
                        data = {}

                    re_emails, re_phones = harvest_contacts_from_text(text)
                    phones = as_list(data.get("phones")) or re_phones
                    emails = as_list(data.get("emails")) or re_emails

                    row = {
                        "name": (data.get("name") or domain_of(url)).strip(),
                        "address": (data.get("address") or "").strip(),
                        "phone": ", ".join(phones),
                        "site": url,
                        "email": ", ".join(emails),
                        "telegram": first_or_empty(data.get("telegram")),
                        "vk": first_or_empty(data.get("vk")),
                        "instagram": first_or_empty(data.get("instagram")),
                        "description": (data.get("description") or "").strip(),
                    }
                    job.rows.append(row)
                    if phones or emails:
                        job.stats["with_contacts"] += 1
                    job.log(f"  {row['name']} — телефонов {len(phones)}, email {len(emails)}")
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    job.stats["failed"] += 1
                    job.log(f"  ошибка: {e}")
                finally:
                    job.stats["sites_done"] += 1
        finally:
            await browser.close()

    write_workbook(job)
    job.status = "done"
    job.log(f"Готово: {len(job.rows)} организаций, с контактами — {job.stats['with_contacts']}")


def write_workbook(job: Job):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Заказчики"
    ws.append(["№", "Название", "Адрес", "Телефон", "Сайт", "Email", "Telegram", "VK", "Instagram", "Описание"])
    for i, r in enumerate(job.rows, 1):
        ws.append([
            i, r["name"], r["address"], r["phone"], r["site"],
            r["email"], r["telegram"], r["vk"], r["instagram"], r["description"],
        ])
    for col, width in zip("ABCDEFGHIJ", [5, 34, 40, 26, 32, 28, 20, 20, 20, 50]):
        ws.column_dimensions[col].width = width
    wb.save(job.raw_path)
