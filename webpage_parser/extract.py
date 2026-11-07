from urllib.parse import urljoin

from bs4 import BeautifulSoup


def extract(html, url, selector, attribute=""):
    soup = BeautifulSoup(html, "html.parser")
    for element in soup.select("script, style, noscript, template"):
        element.decompose()
    base = soup.select_one("base[href]")
    base_url = urljoin(url, base["href"]) if base else url
    items = []
    for element in soup.select(selector):
        if attribute:
            value = element.get(attribute)
            if value is None:
                continue
            if isinstance(value, list):
                value = " ".join(value)
            if attribute in ("href", "src", "action"):
                value = urljoin(base_url, value)
        else:
            value = " ".join(element.get_text(" ", strip=True).split())
        items.append(value)
    return {"title": soup.title.get_text(" ", strip=True) if soup.title else "", "items": items}
