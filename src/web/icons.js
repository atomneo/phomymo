/**
 * Iconify data layer for the Phomymo icon picker.
 *
 * Pure data/network module - no DOM manipulation beyond a throwaway DOMParser
 * used for sanitizing untrusted SVG markup. UI lives in icon-picker.js.
 *
 * Icons are fetched from the public Iconify API (https://iconify.design) and
 * converted into a self-contained, sanitized SVG data URI. That data URI is
 * what gets stored in the project (as a normal image element's `imageData`),
 * so a saved design never needs the network again to redisplay an icon.
 *
 * Endpoints used:
 * - GET /collections            -> full library list (name, total, palette, category)
 * - GET /collection?prefix=X    -> one library's icon names, grouped by category
 * - GET /search?query=&prefix=&limit= -> keyword search (fetched once at the max limit; see searchIcons)
 * - GET /{prefix}.json?icons=a,b,c -> actual icon bodies (SVG path data) for a batch
 */

import { ICON } from './constants.js';
import { logError, ErrorLevel } from './utils/errors.js';

// Elements allowed to survive sanitization. Anything else (script,
// foreignObject, style, animate*, etc.) is stripped.
const ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'defs', 'clippath', 'mask', 'lineargradient', 'radialgradient',
  'stop', 'use', 'title',
]);

// Attributes allowed on any surviving element (beyond tag-specific geometry
// attributes, which are just copied through since they are not executable).
const DISALLOWED_ATTR_PREFIX = 'on'; // onload, onclick, etc.

// Simple in-memory caches (cleared on page reload). Not persisted - the
// per-icon data URI that actually needs to survive a reload lives inside the
// saved project itself, not in a cache here.
const searchCache = new Map();
const iconSetCache = new Map();
const collectionCache = new Map(); // prefix -> processed browse data
let collectionsListPromise = null; // single shared /collections fetch
const MAX_CACHE_ENTRIES = 60;

function cacheGet(cache, key) {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, value);
}

/**
 * Fetch the full Iconify library list (all ~200+ collections), cached in
 * memory for the session. Used to populate the library picker and to
 * annotate icon sets with metadata (palette, category) - never persisted.
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ prefix: string, name: string, total: number, palette: boolean, category: string }>>}
 */
export async function fetchCollectionsList(signal) {
  if (collectionsListPromise) return collectionsListPromise;

  collectionsListPromise = (async () => {
    const res = await fetch(`${ICON.API_BASE}/collections`, { signal });
    if (!res.ok) {
      throw new Error(`Collections list fetch failed (${res.status})`);
    }
    const data = await res.json();
    return Object.entries(data).map(([prefix, meta]) => ({
      prefix,
      name: meta.name || prefix,
      total: meta.total || 0,
      palette: !!meta.palette,
      category: meta.category || '',
    }));
  })();

  try {
    return await collectionsListPromise;
  } catch (e) {
    collectionsListPromise = null; // allow retry on failure
    throw e;
  }
}

/**
 * Search icons by keyword.
 *
 * Always fetches once at (or near) Iconify's maximum `limit` (999) instead
 * of requesting small pages via a `start` offset. Verified against the
 * live API: `start` is rejected outright (HTTP 400) when no `prefix` is
 * given, and even when a `prefix` *is* given, the API 400s unless
 * `start < limit` - i.e. `limit` behaves as the size of the whole
 * candidate pool `start` can index into, not a page size independent of
 * it. Fetching the full (up to 999) pool once and paginating the already-
 * fetched name list client-side (see icon-picker.js) sidesteps both quirks
 * entirely and is also what makes "Load more" work for "All libraries",
 * which has no other way to page at all.
 * @param {string} query - Search text (e.g. "car")
 * @param {object} options
 * @param {string} [options.prefix] - Limit to a single collection prefix; omit to search all of Iconify
 * @param {number} [options.limit] - Override the fetch size (defaults to ICON.SEARCH_FETCH_LIMIT)
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ icons: Array<{ prefix: string, name: string }> }>}
 */
export async function searchIcons(query, options = {}) {
  const trimmed = (query || '').trim();
  if (!trimmed) return { icons: [] };

  const limit = options.limit || ICON.SEARCH_FETCH_LIMIT;
  const prefix = options.prefix || '';

  const cacheKey = `${prefix}::${trimmed.toLowerCase()}::${limit}`;
  const cached = cacheGet(searchCache, cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({ query: trimmed, limit: String(limit) });
  // Single-prefix search uses Iconify's `prefix` param (not `prefixes`) -
  // omitting it entirely searches across every Iconify collection, which is
  // what "All libraries" is supposed to mean.
  if (prefix) params.set('prefix', prefix);

  const res = await fetch(`${ICON.API_BASE}/search?${params.toString()}`, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`Icon search failed (${res.status})`);
  }
  const data = await res.json();
  const rawIcons = Array.isArray(data.icons) ? data.icons : [];

  const icons = rawIcons.map((full) => {
    const idx = full.indexOf(':');
    return idx === -1
      ? { prefix: '', name: full }
      : { prefix: full.slice(0, idx), name: full.slice(idx + 1) };
  });

  const result = { icons };
  cacheSet(searchCache, cacheKey, result);
  return result;
}

/**
 * Fetch and process one library's browsable icon list via /collection.
 *
 * Iconify's /collection response splits icons into `categories` (an object
 * of categoryName -> icon names) and `uncategorized` (icon names in no
 * category), plus `hidden` (deprecated/renamed icons that should never be
 * browsed) and `aliases` (alternate names for icons that already appear in
 * categories/uncategorized - never additional icons, so they are ignored
 * here entirely to avoid showing the same icon twice).
 *
 * @param {string} prefix - Collection prefix (e.g. "mdi")
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ prefix: string, total: number, iconNames: string[], categories: string[], namesByCategory: Record<string, string[]> }>}
 */
export async function fetchCollection(prefix, signal) {
  const cached = cacheGet(collectionCache, prefix);
  if (cached) return cached;

  const res = await fetch(`${ICON.API_BASE}/collection?prefix=${encodeURIComponent(prefix)}`, { signal });
  if (!res.ok) {
    throw new Error(`Collection fetch failed (${res.status})`);
  }
  const data = await res.json();

  const seen = new Set();
  const iconNames = [];
  const categories = [];
  const namesByCategory = {};

  // Categories first (order as returned by the API), then uncategorized.
  // `hidden` is intentionally never read - those are deprecated icons the
  // Iconify collection browser itself excludes from normal listing.
  for (const [categoryName, names] of Object.entries(data.categories || {})) {
    categories.push(categoryName);
    namesByCategory[categoryName] = Array.isArray(names) ? names : [];
    for (const name of namesByCategory[categoryName]) {
      if (!seen.has(name)) {
        seen.add(name);
        iconNames.push(name);
      }
    }
  }

  for (const name of (data.uncategorized || [])) {
    if (!seen.has(name)) {
      seen.add(name);
      iconNames.push(name);
    }
  }

  const result = {
    prefix,
    total: iconNames.length,
    iconNames,
    categories,
    namesByCategory,
  };

  cacheSet(collectionCache, prefix, result);
  return result;
}

/**
 * Fetch raw icon set data for a batch of icon names within one collection.
 * One request per prefix per uncached batch, regardless of how many icon
 * names are requested (Iconify's {prefix}.json endpoint takes a comma-
 * separated icons= list in a single call).
 * @param {string} prefix - Collection prefix (e.g. "mdi")
 * @param {string[]} names - Icon names within that collection
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} Raw Iconify icon set JSON (icons + aliases + defaults)
 */
export async function fetchIconSet(prefix, names, signal) {
  const uncachedNames = [];
  const merged = { prefix, icons: {}, aliases: {}, width: 24, height: 24 };

  // Reuse whatever we already have cached for this prefix.
  const existing = cacheGet(iconSetCache, prefix);
  if (existing) {
    Object.assign(merged, existing);
  }

  for (const name of names) {
    if (!merged.icons[name] && !merged.aliases[name]) {
      uncachedNames.push(name);
    }
  }

  if (uncachedNames.length > 0) {
    const url = `${ICON.API_BASE}/${encodeURIComponent(prefix)}.json?icons=${uncachedNames.map(encodeURIComponent).join(',')}`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new Error(`Icon set fetch failed (${res.status})`);
    }
    const data = await res.json();

    merged.width = data.width || merged.width;
    merged.height = data.height || merged.height;
    merged.icons = { ...merged.icons, ...(data.icons || {}) };
    merged.aliases = { ...merged.aliases, ...(data.aliases || {}) };

    cacheSet(iconSetCache, prefix, {
      width: merged.width,
      height: merged.height,
      icons: merged.icons,
      aliases: merged.aliases,
    });
  }

  return merged;
}

/**
 * Resolve a single icon's effective geometry (body + viewbox + transform
 * flags), following one level of alias indirection if needed.
 * @param {object} iconSet - Result of fetchIconSet
 * @param {string} name - Icon name within the set
 * @returns {{ body: string, width: number, height: number, left: number, top: number, hFlip: boolean, vFlip: boolean, rotate: number } | null}
 */
export function resolveIcon(iconSet, name) {
  let entry = iconSet.icons[name];
  let alias = null;

  if (!entry) {
    alias = iconSet.aliases[name];
    if (!alias) return null;
    // Follow one further level of alias-to-alias, if present.
    entry = iconSet.icons[alias.parent] || null;
    if (!entry) {
      const parentAlias = iconSet.aliases[alias.parent];
      if (parentAlias) entry = iconSet.icons[parentAlias.parent] || null;
    }
    if (!entry) return null;
  }

  const source = alias || entry;
  return {
    body: entry.body,
    width: entry.width || iconSet.width || 24,
    height: entry.height || iconSet.height || 24,
    left: entry.left || 0,
    top: entry.top || 0,
    hFlip: !!(entry.hFlip || source.hFlip),
    vFlip: !!(entry.vFlip || source.vFlip),
    rotate: source.rotate || entry.rotate || 0,
  };
}

/**
 * Sanitize raw Iconify icon body markup with a strict element/attribute
 * allowlist. Iconify's public API is not attacker-controlled in the normal
 * sense, but the result is inserted as SVG/data-URI content in the app, so
 * we treat it as untrusted external data and never trust it blindly.
 * @param {string} body - Inner SVG markup (no outer <svg> wrapper)
 * @returns {string|null} Sanitized markup, or null if it could not be parsed
 */
export function sanitizeSvgBody(body) {
  if (typeof body !== 'string' || !body) return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
      'image/svg+xml'
    );

    if (doc.querySelector('parsererror')) return null;

    const root = doc.documentElement;
    sanitizeNode(root);

    // Serialize just the children of the wrapper <svg> we introduced.
    const serializer = new XMLSerializer();
    let out = '';
    for (const child of Array.from(root.childNodes)) {
      out += serializer.serializeToString(child);
    }
    return out;
  } catch (e) {
    logError(e, 'sanitizeSvgBody', ErrorLevel.WARNING);
    return null;
  }
}

/**
 * Recursively strip disallowed tags/attributes from a parsed SVG node tree.
 * @param {Element} node
 */
function sanitizeNode(node) {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        node.removeChild(child);
        continue;
      }
      // Strip event-handler and other risky attributes.
      for (const attr of Array.from(child.attributes)) {
        const attrName = attr.name.toLowerCase();
        const isHref = attrName === 'href' || attrName === 'xlink:href';
        if (attrName.startsWith(DISALLOWED_ATTR_PREFIX)) {
          child.removeAttribute(attr.name);
        } else if (isHref && !attr.value.startsWith('#')) {
          // Only allow same-document fragment refs (e.g. gradient/use refs).
          child.removeAttribute(attr.name);
        }
      }
      sanitizeNode(child);
    } else if (child.nodeType === Node.COMMENT_NODE) {
      node.removeChild(child);
    }
  }
}

/**
 * Build a complete, self-contained, sanitized SVG string for an icon,
 * ready to embed as a data URI.
 * @param {object} resolved - Result of resolveIcon()
 * @param {number} [sizePx] - Rendered intrinsic width/height in px
 * @returns {string|null} Full <svg>...</svg> markup, or null if sanitization failed
 */
export function buildIconSvg(resolved, sizePx = ICON.RASTER_SIZE) {
  const safeBody = sanitizeSvgBody(resolved.body);
  if (safeBody === null) return null;

  const { width, height, left, top, hFlip, vFlip, rotate } = resolved;

  let inner = safeBody;
  if (hFlip || vFlip || rotate) {
    const cx = left + width / 2;
    const cy = top + height / 2;
    const transforms = [];
    // Order matches Iconify's own convention: flip before rotate.
    if (hFlip || vFlip) {
      const sx = hFlip ? -1 : 1;
      const sy = vFlip ? -1 : 1;
      transforms.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
    }
    if (rotate) {
      const degrees = (rotate % 4) * 90;
      transforms.push(`rotate(${degrees} ${cx} ${cy})`);
    }
    inner = `<g transform="${transforms.join(' ')}">${safeBody}</g>`;
  }

  // currentColor resolves against CSS at render time; since this SVG is
  // embedded as a data URI <img> (not inline in the DOM), currentColor would
  // resolve to the <img>'s own color context (usually black) which is fine,
  // but we pin it explicitly to black for predictable thermal-print output.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="${left} ${top} ${width} ${height}"><g fill="#000" color="#000">${inner}</g></svg>`;
}

/**
 * Encode an SVG string as a data URI. Uses encodeURIComponent (not btoa) so
 * unicode characters in the markup can't break encoding.
 * @param {string} svg
 * @returns {string}
 */
export function svgToDataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
