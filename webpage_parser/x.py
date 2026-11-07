"""Extract only identified, public X cards; never substitute a neighbouring post."""
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, NavigableString

X_HOSTS = {"x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"}
STATUS_PATH = re.compile(r"/(?:([A-Za-z0-9_]{1,15})/status|i/(?:web/)?status)/(\d+)(?:/(?:photo|video)/\d+)?/?$")
QUOTE_SELECTOR = 'article, [data-testid="quoteTweet"], [data-slot="embedded-tweet-frame"], [data-testid="card.wrapper"]'


def status_identity(url):
    parsed = urlsplit(urljoin("https://x.com", url))
    if parsed.hostname not in X_HOSTS or parsed.scheme not in ("http", "https"):
        return None
    match = STATUS_PATH.fullmatch(parsed.path)
    if not match:
        return None
    return {"id": match[2], "handle": "@" + match[1] if match[1] else None,
            "url": f"https://x.com/{match[1]}/status/{match[2]}" if match[1] else f"https://x.com/i/status/{match[2]}"}


def visible_text(node):
    """Preserve actual whitespace, CJK, emoji alt text and line breaks."""
    clone = BeautifulSoup(str(node), "html.parser")
    for tag in clone.select('script, style, [aria-hidden="true"]'):
        tag.decompose()
    for tag in clone.select('br'):
        tag.replace_with(NavigableString("\n"))
    for tag in clone.select('img[alt]'):
        tag.replace_with(NavigableString(tag["alt"]))
    return clone.get_text().replace("\r\n", "\n").strip()


def timestamp_iso(card, link, timestamp):
    if timestamp:
        return timestamp.get("datetime")
    # The anonymous layout includes an exact epoch for its date formatter.
    for script in card.select('script'):
        raw = script.string or ""
        if link.get("id") and ('"' + link["id"] + '"') in raw:
            match = re.search(r'"timestamp"\s*:\s*(\d{10,16})', raw)
            if match:
                try:
                    return datetime.fromtimestamp(int(match[1]) / 1000, timezone.utc).isoformat()
                except (ValueError, OverflowError, OSError):
                    pass
    return None


def extract_x_posts(html, max_posts=50):
    soup = BeautifulSoup(html, "html.parser")
    posts, seen = [], {}
    for original in soup.select('article'):
        if original.find_parent('article') or original.find_parent(attrs={"data-slot": "embedded-tweet-frame"}):
            continue
        # Remove embedded content before finding identity, author, media or text.
        card = BeautifulSoup(str(original), "html.parser").article
        quotes = []
        for embedded in list(card.select(QUOTE_SELECTOR)):
            if embedded.parent is None:
                continue
            quote = status_identity(embedded.get("data-href", ""))
            if not quote:
                for a in embedded.select('a[href]'):
                    quote = status_identity(a['href'])
                    if quote:
                        break
            if quote:
                quotes.append(quote["url"])
            embedded.decompose()
        avatar = card.select_one('[data-post-avatar] a[href]')
        if card.get("data-testid") != "tweet" and avatar is None:
            continue
        timestamp = card.select_one('time[datetime]')
        link = timestamp.find_parent('a', href=True) if timestamp else None
        if link is None:
            for candidate in card.select('a[data-base-ui-tooltip-trigger][href]'):
                identity = status_identity(candidate["href"])
                if not identity or "view" in candidate.get_text().lower():
                    continue
                if avatar and identity["handle"] and identity["handle"].lower() != '@' + urlsplit(avatar['href']).path.strip('/').lower():
                    continue
                link = candidate
                break
        identity = status_identity(link["href"]) if link else None
        if not identity:
            continue
        text = card.select_one('[data-testid="tweetText"], div[dir="auto"].whitespace-pre-wrap')
        images = list(dict.fromkeys(img['src'] for img in card.select('img[src]')
                                   if urlsplit(img['src']).hostname == 'pbs.twimg.com'
                                   and urlsplit(img['src']).path.startswith('/media/')))
        videos = [{"url": video.get('src'), "poster": video.get('poster'),
                   "sources": [s['src'] for s in video.select('source[src]')]}
                  for video in card.select('video')]
        has_video = bool(videos or card.select_one('[data-testid="videoPlayer"]'))
        if text is None and not images and not has_video and not quotes:
            continue
        author = card.select_one('[data-testid="User-Name"]')
        if not author and avatar:
            author = next((a for a in card.select('a[href]')
                           if a['href'] == avatar['href'] and a.get_text(strip=True)
                           and not a.get_text(strip=True).startswith('@')), None)
        reply_marker = card.select_one('[data-testid="replyingTo"], [data-reply-to-status-id]')
        reply_id = card.get('data-reply-to-status-id') or (reply_marker.get('data-reply-to-status-id') if reply_marker else None)
        post = {**identity, "author": author.get_text(" ", strip=True) if author else identity["handle"],
                "text": visible_text(text) if text else "", "posted_at": timestamp_iso(card, link, timestamp),
                "posted_at_text": link.get_text(" ", strip=True), "images": images,
                "videos": videos, "has_video": has_video, "quoted_urls": list(dict.fromkeys(quotes)),
                "is_reply": True if reply_marker or reply_id else None, "reply_to_status_id": reply_id}
        engagement = card.select_one('[role="group"][aria-label]')
        if engagement:
            metrics = {}
            for number, label in re.findall(r'([\d,]+)\s+(repl(?:y|ies)|reposts?|likes?|bookmarks?|views?)\b', engagement['aria-label'], re.I):
                key = 'replies' if label.lower() in ('reply', 'replies') else label.lower().rstrip('s') + 's'
                metrics[key] = int(number.replace(',', ''))
            post['metrics'] = metrics
        if identity['id'] in seen:
            index = seen[identity['id']]
            if len(post['text']) > len(posts[index]['text']):
                posts[index] = post
            continue
        seen[identity['id']] = len(posts)
        posts.append(post)
        if len(posts) >= max_posts:
            break
    return posts


def select_x_content(html, url, max_posts=1, scope="target"):
    # Scan all cards before limiting: the requested reply may follow its parent.
    posts = extract_x_posts(html, max_posts=1000)
    identity = status_identity(url)
    target = next((p for p in posts if identity and p['id'] == identity['id']), None)
    if identity and target is None:
        return [], None, 'target_not_found'
    if scope == 'target':
        if identity is None:
            return [], None, 'status_url_required'
        selected = [target]
    else:
        selected = ([target] if target else []) + [p for p in posts if p is not target]
        selected = selected[:max_posts]
    for post in selected:
        post['relation'] = 'target' if post is target else 'visible'
    return selected, target, None if selected else 'no_posts'
