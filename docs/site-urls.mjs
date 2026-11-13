/** Website locations only. Never apply to recipe documents or schema identities. */
export const SITE = 'https://crosswalker.io';
export const BASE = '/';
export const LEGACY_PREFIXES = ['/crosswalker', '/Crosswalker'];
const OLD_ORIGIN = 'https://cybersader.github.io';

/** Normalize only our website addresses, preserving the original query/fragment bytes. */
export function sitePath(value) {
  let path = value;
  if (path.startsWith(SITE + '/')) path = path.slice(SITE.length);
  else if (path === SITE) return '/';
  else if (path.startsWith(OLD_ORIGIN + '/')) {
    path = path.slice(OLD_ORIGIN.length);
    // The account-root site is separate; only the old project belongs to us.
    if (!LEGACY_PREFIXES.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?') || path.startsWith(p + '#'))) return value;
  }
  if (!path.startsWith('/') || path.startsWith('//')) return value;
  for (const prefix of LEGACY_PREFIXES) {
    if (path === prefix) return '/';
    if (path.startsWith(prefix + '/')) return path.slice(prefix.length);
    if (path.startsWith(prefix + '?') || path.startsWith(prefix + '#')) return '/' + path.slice(prefix.length);
  }
  return path;
}

export function siteUrl(path = '/') {
  return new URL(sitePath(path), SITE + '/').href;
}

function normalizeCss(css) {
  // Consume comments and ordinary CSS strings before considering url() tokens.
  return css.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\(\s*(['"]?)([^\s)'";]+)\1\s*\)/gi,
    (all, _quote, url) => url === undefined ? all : all.replace(url, sitePath(url)));
}

/**
 * Transform URL-bearing HTML attributes only, after MDX/Astro have rendered.
 * Tokenize quoted tags (including > inside attributes). Leave examples and raw
 * script/text contents alone; no string-wide substitution of historical prose.
 * CSS is restricted to actual url() values in style attributes/blocks.
 */
export function normalizeHtml(html) {
  const tokens = /<!--[\s\S]*?-->|<(script|textarea|pre|code)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  return html.replace(tokens, (tag, protectedTag) => {
    if (protectedTag || tag.startsWith('<!--')) return tag;
    if (/^<style\b/i.test(tag)) return normalizeCss(tag);
    // Consume ALL attribute values, so href= inside a title/data-* string is
    // never mistaken for an actual URL attribute.
    const attributes = /(\s)([a-z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi;
    const valueOf = quoted => /^["']/.test(quoted) ? quoted.slice(1, -1) : quoted;
    const canonical = /^<link\b/i.test(tag) && [...tag.matchAll(attributes)].some(
      match => match[2].toLowerCase() === 'rel' && valueOf(match[4]).split(/\s+/).includes('canonical'));
    return tag.replace(attributes,
      (attribute, space, rawName, equals, quoted) => {
        const name = rawName.toLowerCase();
        if (!['href', 'src', 'xlink:href', 'poster', 'action', 'srcset', 'style'].includes(name)) return attribute;
        const quote = /^["']/.test(quoted) ? quoted[0] : '';
        const value = valueOf(quoted);
        let normalized;
        if (name === 'style') normalized = normalizeCss(value);
        else if (name === 'srcset') {
          normalized = value.replace(/(^|,\s*)(\S+)/g, (all, start, url) => start + sitePath(url));
        } else normalized = canonical && name === 'href' ? siteUrl(value) : sitePath(value);
        return space + rawName + equals + quote + normalized + quote;
      });
  });
}

/** Reject collisions/recursive aliases instead of emitting redirect loops. */
export function legacyAliases(paths) {
  const canonical = [...new Set(paths)];
  for (const path of canonical) {
    if (!path.startsWith('/') || path.startsWith('//') || sitePath(path) !== path) {
      throw new Error(`Non-canonical route in legacy alias inventory: ${path}`);
    }
  }
  return canonical.flatMap(path => LEGACY_PREFIXES.map(prefix => ({
    from: prefix + (path === '/' ? '/' : path), to: path,
  })));
}

/** Static Pages response is HTTP 200 HTML, not a server-side 301. */
export function aliasHtml(destination) {
  if (sitePath(destination) !== destination || !destination.startsWith('/') || destination.startsWith('//')) {
    throw new Error('Legacy alias destination must be a canonical root path');
  }
  const absolute = siteUrl(destination);
  const escaped = absolute.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,follow"><link rel="canonical" href="${escaped}"><title>Page moved</title><script>location.replace(${JSON.stringify(destination).replaceAll('<', '\\u003c')} + location.search + location.hash);</script></head><body><p>This page moved to <a href="${escaped}">${escaped}</a>.</p></body></html>`;
}
