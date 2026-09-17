/**
 * Icon Picker UI controller
 * Modal for browsing/searching Iconify icon libraries and picking one to insert.
 *
 * Follows the same lightweight modal pattern as the other dialogs in
 * index.html (#shortcuts-modal, #multi-label-modal): a hidden fixed overlay
 * toggled by adding/removing the `hidden` class, driven entirely from here.
 *
 * Three content modes, chosen from the current library + search text:
 * - 'recent'  - "All libraries" selected, empty search -> recent/favorite icons
 * - 'browse'  - a specific library selected, empty search -> that library's
 *               full icon list (via /collection), with an optional category filter
 * - 'search'  - non-empty search text -> keyword search (optionally scoped
 *               to the selected library)
 *
 * Both 'browse' and 'search' fetch their full name/result list exactly
 * once (browse: the library's whole icon list from /collection; search:
 * one /search call at Iconify's max limit) and then page through it
 * client-side in PAGE_SIZE chunks for "Load more" - see loadNextPage().
 * This sidesteps a real, verified Iconify /search quirk: its `start`
 * offset is rejected outright without a `prefix`, and even with a prefix
 * it 400s unless `start < limit` - i.e. `limit` is the size of the whole
 * candidate pool `start` indexes into, not an independent page size.
 */

import { ICON, ICON_RECOMMENDED_COLLECTIONS, STORAGE_KEYS } from './constants.js';
import {
  searchIcons,
  fetchIconSet,
  fetchCollection,
  fetchCollectionsList,
  resolveIcon,
  buildIconSvg,
  svgToDataUri,
} from './icons.js';
import { logError, ErrorLevel, safeStorageGet, safeStorageSet } from './utils/errors.js';

const $ = (sel) => document.querySelector(sel);

let onSelectCallback = null;
let debounceTimer = null;

// The one AbortController/requestId pair in flight for the *current*
// logical query (a fresh search, a fresh browse, or a "load more"
// continuation of either). Starting a new query aborts whatever came
// before it; a stale response is also caught by the requestId check, which
// guards against a slow earlier request resolving after a newer one.
let currentController = null;
let currentRequestId = 0;

function beginNewRun() {
  if (currentController) currentController.abort();
  currentController = new AbortController();
  currentRequestId += 1;
  return { signal: currentController.signal, requestId: currentRequestId };
}

// Picker state for the content area (library panel state is separate, below).
const pickerState = {
  prefix: '',              // '' = "All libraries"
  query: '',
  category: '',            // browse mode only
  mode: 'recent',          // 'recent' | 'browse' | 'search'
  items: [],               // resolved {prefix,name,dataUri,width,height} currently rendered

  // Both browse and search modes work the same way once they have a name
  // list in hand: `pagedRefs` is the full ordered {prefix,name} list for
  // the current query/library+category (fetched once), and `loadedCount`
  // is how many of it have been resolved-to-SVG and rendered so far.
  // "Load more" just resolves the next PAGE_SIZE slice - no extra network
  // round-trip beyond fetching individual icon bodies.
  pagedRefs: [],
  loadedCount: 0,
  total: 0,                // pagedRefs.length, shown in the "Showing X of Y" footer

  allBrowseNames: [],      // browse mode: full deduped icon name list for the selected library
  browseNamesByCategory: {}, // browse mode: category name -> icon names (raw, may overlap)
  browseCategories: [],    // browse mode: category names for the selected library
};

// Library picker panel state - the full Iconify collection list, fetched
// once per session and cached here (icons.js also caches the raw fetch, but
// we keep the processed array here too since it is re-filtered on every
// keystroke in the library search box).
let allLibraries = [];
let collectionsByPrefix = new Map();
let librariesLoadState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
let librariesLoadPromise = null;

/** Read the recently-used icon list from localStorage. */
function getRecentIcons() {
  const raw = safeStorageGet(STORAGE_KEYS.ICON_RECENT);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Record an icon as recently used (most-recent first, deduped, capped). */
function addRecentIcon(icon) {
  const list = getRecentIcons().filter(
    (i) => !(i.prefix === icon.prefix && i.name === icon.name)
  );
  list.unshift(icon);
  const trimmed = list.slice(0, ICON.MAX_RECENT);
  safeStorageSet(STORAGE_KEYS.ICON_RECENT, JSON.stringify(trimmed));
}

/** Read favorite icons from localStorage. */
function getFavoriteIcons() {
  const raw = safeStorageGet(STORAGE_KEYS.ICON_FAVORITES);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isFavorite(icon) {
  return getFavoriteIcons().some((i) => i.prefix === icon.prefix && i.name === icon.name);
}

function toggleFavorite(icon) {
  const list = getFavoriteIcons();
  const idx = list.findIndex((i) => i.prefix === icon.prefix && i.name === icon.name);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.unshift(icon);
    if (list.length > ICON.MAX_FAVORITES) list.length = ICON.MAX_FAVORITES;
  }
  safeStorageSet(STORAGE_KEYS.ICON_FAVORITES, JSON.stringify(list));
  return idx < 0; // true if it just became a favorite
}

// =============================================================================
// Content panel state (loading / empty / error / results) + grid rendering
// =============================================================================

function setPanelState(state) {
  // state: 'idle' | 'loading' | 'results' | 'empty' | 'error'
  $('#icon-picker-loading')?.classList.toggle('hidden', state !== 'loading');
  $('#icon-picker-empty')?.classList.toggle('hidden', state !== 'empty');
  $('#icon-picker-error')?.classList.toggle('hidden', state !== 'error');
  $('#icon-picker-grid')?.classList.toggle('hidden', state !== 'results' && state !== 'idle_recent');
  $('#icon-picker-idle')?.classList.toggle('hidden', state !== 'idle');
}

/**
 * Show/hide the "Showing X of Y results" + Load more footer based on the
 * current mode. Recent-icons mode never paginates.
 */
function updateLoadMore() {
  const wrap = $('#icon-picker-loadmore-wrap');
  const countEl = $('#icon-picker-count');
  const btn = $('#icon-picker-loadmore');
  if (!wrap || !countEl || !btn) return;

  const paginated = pickerState.mode === 'search' || pickerState.mode === 'browse';
  const shown = pickerState.items.length;

  if (!paginated || shown === 0) {
    wrap.classList.add('hidden');
    return;
  }

  const hasMore = pickerState.loadedCount < pickerState.pagedRefs.length;

  wrap.classList.remove('hidden');
  countEl.textContent = pickerState.total
    ? `Showing ${shown} of ${pickerState.total} results`
    : `Showing ${shown} results`;
  btn.classList.toggle('hidden', !hasMore);
  btn.disabled = false;
  btn.textContent = 'Load more';
}

/**
 * Render a grid of icon buttons from already-resolved SVGs.
 * Never uses innerHTML with remote markup - each icon is rendered via an
 * <img src="data:..."> element, so untrusted SVG content is only ever
 * interpreted by the browser's <img> SVG renderer, never parsed as live DOM.
 * @param {Array<{ prefix: string, name: string, dataUri: string, width: number, height: number }>} icons
 */
function renderGrid(icons) {
  const grid = $('#icon-picker-grid');
  if (!grid) return;
  grid.innerHTML = '';

  for (const icon of icons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-picker-item';
    btn.title = `${icon.prefix}:${icon.name}`;

    const img = document.createElement('img');
    img.src = icon.dataUri;
    img.alt = icon.name;
    img.width = 28;
    img.height = 28;
    img.loading = 'lazy';
    btn.appendChild(img);

    btn.addEventListener('click', () => {
      addRecentIcon({ prefix: icon.prefix, name: icon.name });
      if (onSelectCallback) {
        onSelectCallback({
          prefix: icon.prefix,
          name: icon.name,
          dataUri: icon.dataUri,
          width: icon.width,
          height: icon.height,
        });
      }
      closeIconPicker();
    });

    // Favorite star toggle
    const star = document.createElement('span');
    star.className = 'icon-picker-fav' + (isFavorite(icon) ? ' active' : '');
    star.textContent = isFavorite(icon) ? '★' : '☆';
    star.title = 'Toggle favorite';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowFav = toggleFavorite({ prefix: icon.prefix, name: icon.name });
      star.textContent = nowFav ? '★' : '☆';
      star.classList.toggle('active', nowFav);
    });
    btn.appendChild(star);

    grid.appendChild(btn);
  }
}

/**
 * Resolve a batch of "prefix:name" refs into ready-to-render data URIs,
 * grouped into one iconify.json request per prefix.
 * @param {Array<{ prefix: string, name: string }>} refs
 * @param {AbortSignal} signal
 * @returns {Promise<Array<{ prefix: string, name: string, dataUri: string, width: number, height: number }>>}
 */
async function resolveIconRefs(refs, signal) {
  const byPrefix = new Map();
  for (const ref of refs) {
    if (!byPrefix.has(ref.prefix)) byPrefix.set(ref.prefix, []);
    byPrefix.get(ref.prefix).push(ref.name);
  }

  const sets = await Promise.all(
    Array.from(byPrefix.entries()).map(([prefix, names]) =>
      fetchIconSet(prefix, names, signal).then((set) => ({ prefix, set }))
    )
  );
  const setByPrefix = new Map(sets.map((s) => [s.prefix, s.set]));

  const out = [];
  for (const ref of refs) {
    const set = setByPrefix.get(ref.prefix);
    if (!set) continue;
    const resolved = resolveIcon(set, ref.name);
    if (!resolved) continue;
    const svg = buildIconSvg(resolved);
    if (svg === null) continue;
    out.push({
      prefix: ref.prefix,
      name: ref.name,
      dataUri: svgToDataUri(svg),
      width: resolved.width,
      height: resolved.height,
    });
  }
  return out;
}

// =============================================================================
// Recent icons ("All libraries" + empty search)
// =============================================================================

async function runRecent() {
  const { signal, requestId } = beginNewRun();
  pickerState.mode = 'recent';
  pickerState.items = [];
  pickerState.pagedRefs = [];
  pickerState.loadedCount = 0;
  pickerState.total = 0;

  const recent = getRecentIcons();
  if (recent.length === 0) {
    setPanelState('idle');
    renderGrid([]);
    updateLoadMore();
    return;
  }

  setPanelState('loading');
  try {
    const resolved = await resolveIconRefs(recent, signal);
    if (requestId !== currentRequestId) return; // superseded
    pickerState.items = resolved;
    renderGrid(resolved);
    setPanelState(resolved.length ? 'idle_recent' : 'idle');
    updateLoadMore();
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (requestId !== currentRequestId) return;
    logError(e, 'iconPicker.recent', ErrorLevel.WARNING);
    setPanelState('idle');
  }
}

// =============================================================================
// Shared pagination: resolve+render the next PAGE_SIZE slice of whatever
// name/ref list is currently active (browse or search - both populate
// `pickerState.pagedRefs` once, then only ever page through it client-side).
// =============================================================================

/** Resolve and append the next page of `pickerState.pagedRefs` to the grid. */
async function loadNextPage(signal, requestId) {
  const slice = pickerState.pagedRefs.slice(pickerState.loadedCount, pickerState.loadedCount + ICON.PAGE_SIZE);
  if (slice.length === 0) {
    setPanelState(pickerState.items.length ? 'results' : 'empty');
    updateLoadMore();
    return;
  }

  const resolved = await resolveIconRefs(slice, signal);
  if (requestId !== currentRequestId) return;

  pickerState.loadedCount += slice.length;
  pickerState.items = pickerState.items.concat(resolved);
  renderGrid(pickerState.items);
  setPanelState(pickerState.items.length ? 'results' : 'empty');
  updateLoadMore();
}

/** "Load more" button click - continues whichever mode is currently active. */
async function loadMore() {
  if (!currentController) return;
  const signal = currentController.signal;
  const requestId = currentRequestId;
  setLoadMoreButtonLoading(true);
  try {
    await loadNextPage(signal, requestId);
  } catch (e) {
    if (e.name !== 'AbortError') logError(e, 'iconPicker.loadMore', ErrorLevel.WARNING);
  } finally {
    setLoadMoreButtonLoading(false);
  }
}

function setLoadMoreButtonLoading(loading) {
  const btn = $('#icon-picker-loadmore');
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Loading…' : 'Load more';
}

// =============================================================================
// Browse mode (specific library selected + empty search)
// =============================================================================

/**
 * Recompute the current category-filtered ref list from the already-
 * fetched full library data. Pure client-side, no network.
 */
function applyCategoryFilter() {
  const names = pickerState.category
    ? (pickerState.browseNamesByCategory[pickerState.category] || [])
    : pickerState.allBrowseNames;
  pickerState.pagedRefs = names.map((name) => ({ prefix: pickerState.prefix, name }));
  pickerState.total = pickerState.pagedRefs.length;
}

/** Fresh browse of the currently-selected library (fetches /collection). */
async function runBrowse() {
  const { signal, requestId } = beginNewRun();
  pickerState.mode = 'browse';
  pickerState.items = [];
  pickerState.loadedCount = 0;
  pickerState.category = '';
  setPanelState('loading');

  try {
    const collection = await fetchCollection(pickerState.prefix, signal);
    if (requestId !== currentRequestId) return;

    pickerState.browseCategories = collection.categories;
    pickerState.browseNamesByCategory = collection.namesByCategory;
    pickerState.allBrowseNames = collection.iconNames;
    updateCategorySelect();
    applyCategoryFilter();

    if (pickerState.pagedRefs.length === 0) {
      renderGrid([]);
      setPanelState('empty');
      updateLoadMore();
      return;
    }

    await loadNextPage(signal, requestId);
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (requestId !== currentRequestId) return;
    logError(e, 'iconPicker.browse', ErrorLevel.WARNING);
    setPanelState('error');
  }
}

/** Category select changed - re-filter client-side, no /collection re-fetch. */
function onCategoryChange() {
  pickerState.category = $('#icon-picker-category')?.value || '';
  const { signal, requestId } = beginNewRun();
  pickerState.items = [];
  pickerState.loadedCount = 0;
  applyCategoryFilter();
  setPanelState('loading');

  if (pickerState.pagedRefs.length === 0) {
    renderGrid([]);
    setPanelState('empty');
    updateLoadMore();
    return;
  }

  loadNextPage(signal, requestId).catch((e) => {
    if (e.name === 'AbortError') return;
    if (requestId !== currentRequestId) return;
    logError(e, 'iconPicker.browse', ErrorLevel.WARNING);
    setPanelState('error');
  });
}

function updateCategorySelect() {
  const select = $('#icon-picker-category');
  if (!select) return;

  select.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All categories';
  select.appendChild(allOpt);

  if (!pickerState.browseCategories || pickerState.browseCategories.length === 0) {
    select.classList.add('hidden');
    return;
  }

  for (const category of pickerState.browseCategories) {
    const opt = document.createElement('option');
    opt.value = category;
    opt.textContent = category;
    select.appendChild(opt);
  }
  select.value = pickerState.category;
  select.classList.remove('hidden');
}

// =============================================================================
// Search mode (non-empty search text, optionally scoped to a library)
// =============================================================================

async function runSearch() {
  const { signal, requestId } = beginNewRun();
  pickerState.mode = 'search';
  pickerState.items = [];
  pickerState.loadedCount = 0;
  setPanelState('loading');

  try {
    // One request at Iconify's max limit (999), not a `start`-based page -
    // see searchIcons() for why. "Load more" below just resolves further
    // slices of this same already-fetched list, exactly like browse mode.
    const { icons } = await searchIcons(pickerState.query, {
      prefix: pickerState.prefix || undefined,
      signal,
    });
    if (requestId !== currentRequestId) return;

    pickerState.pagedRefs = icons;
    pickerState.total = icons.length;

    if (icons.length === 0) {
      renderGrid([]);
      setPanelState('empty');
      updateLoadMore();
      return;
    }

    await loadNextPage(signal, requestId);
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (requestId !== currentRequestId) return;
    logError(e, 'iconPicker.search', ErrorLevel.WARNING);
    setPanelState('error');
  }
}

// =============================================================================
// Top-level dispatch (search box input, retry, load more)
// =============================================================================

/** Re-derive the active mode from current library + search text and run it. */
function runQuery() {
  pickerState.query = $('#icon-picker-search')?.value.trim() || '';

  if (!pickerState.query) {
    if (pickerState.prefix) {
      runBrowse();
    } else {
      runRecent();
    }
    return;
  }

  runSearch();
}

function scheduleQuery() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runQuery, ICON.SEARCH_DEBOUNCE_MS);
}

function handleLoadMoreClick() {
  loadMore();
}

function handleRetryClick() {
  runQuery();
}

// =============================================================================
// Library picker panel (searchable, Recommended + full Iconify collection list)
// =============================================================================

function ensureLibrariesLoaded() {
  if (librariesLoadState === 'ready') return Promise.resolve();
  if (librariesLoadPromise) return librariesLoadPromise;

  librariesLoadState = 'loading';
  renderLibraryPanelMessage('Loading libraries…');

  librariesLoadPromise = fetchCollectionsList()
    .then((list) => {
      allLibraries = list;
      collectionsByPrefix = new Map(list.map((c) => [c.prefix, c]));
      librariesLoadState = 'ready';
      renderLibraryList($('#icon-picker-library-search')?.value || '');
    })
    .catch((e) => {
      librariesLoadState = 'error';
      logError(e, 'iconPicker.collections', ErrorLevel.WARNING);
      renderLibraryPanelError();
    })
    .finally(() => {
      librariesLoadPromise = null;
    });

  return librariesLoadPromise;
}

function renderLibraryPanelMessage(text) {
  const listEl = $('#icon-picker-library-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'px-3 py-6 text-center text-xs text-gray-400';
  msg.textContent = text;
  listEl.appendChild(msg);
}

function renderLibraryPanelError() {
  const listEl = $('#icon-picker-library-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const msg = document.createElement('div');
  msg.className = 'px-3 py-4 text-center text-xs text-red-500';
  msg.textContent = "Couldn't load the library list.";
  listEl.appendChild(msg);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'mx-auto mt-2 block px-2 py-1 text-[11px] border border-gray-200 rounded hover:bg-gray-50';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => {
    librariesLoadState = 'idle';
    ensureLibrariesLoaded();
  });
  listEl.appendChild(retry);
}

function makeLibraryRow(lib) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'icon-picker-lib-row' + (lib.prefix === pickerState.prefix ? ' active' : '');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'icon-picker-lib-name';
  nameSpan.textContent = lib.name;
  row.appendChild(nameSpan);

  const bits = [];
  if (typeof lib.total === 'number' && lib.total > 0) bits.push(lib.total.toLocaleString());
  if (lib.palette) bits.push('color');
  if (bits.length > 0) {
    const metaSpan = document.createElement('span');
    metaSpan.className = 'icon-picker-lib-meta';
    metaSpan.textContent = bits.join(' · ');
    row.appendChild(metaSpan);
  }

  row.addEventListener('click', () => selectLibrary(lib.prefix, lib.name));
  return row;
}

function appendLibrarySectionHeader(listEl, text) {
  const header = document.createElement('div');
  header.className = 'icon-picker-lib-section';
  header.textContent = text;
  listEl.appendChild(header);
}

function renderLibraryList(filterText) {
  const listEl = $('#icon-picker-library-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const q = (filterText || '').trim().toLowerCase();

  // The pinned "All libraries" (search-everywhere) row stays put regardless
  // of the library-name filter text - it is not itself a library to search for.
  if (!q) {
    listEl.appendChild(makeLibraryRow({ prefix: '', name: 'All libraries' }));
  }

  if (!q) {
    appendLibrarySectionHeader(listEl, 'Recommended');
    for (const rec of ICON_RECOMMENDED_COLLECTIONS) {
      const meta = collectionsByPrefix.get(rec.prefix);
      listEl.appendChild(makeLibraryRow({
        prefix: rec.prefix,
        name: rec.label,
        total: meta?.total,
        palette: meta?.palette,
      }));
    }

    const recommendedSet = new Set(ICON_RECOMMENDED_COLLECTIONS.map((c) => c.prefix));
    const rest = allLibraries
      .filter((c) => !recommendedSet.has(c.prefix) && c.total > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    appendLibrarySectionHeader(listEl, 'More libraries');
    for (const lib of rest) {
      listEl.appendChild(makeLibraryRow(lib));
    }
    return;
  }

  // Filtering by name/prefix - flat, no section headers, no pinned row.
  const matches = allLibraries
    .filter((c) => c.name.toLowerCase().includes(q) || c.prefix.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'px-3 py-4 text-center text-xs text-gray-400';
    empty.textContent = 'No matching libraries';
    listEl.appendChild(empty);
    return;
  }

  for (const lib of matches) {
    listEl.appendChild(makeLibraryRow(lib));
  }
}

function selectLibrary(prefix, label) {
  pickerState.prefix = prefix;
  pickerState.category = '';

  const labelEl = $('#icon-picker-library-label');
  if (labelEl) labelEl.textContent = label || 'All libraries';

  if (!prefix) {
    $('#icon-picker-category')?.classList.add('hidden');
  }

  closeLibraryPanel();
  runQuery();
}

function toggleLibraryPanel() {
  const panel = $('#icon-picker-library-panel');
  if (!panel) return;

  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    if (librariesLoadState === 'ready') {
      renderLibraryList($('#icon-picker-library-search')?.value || '');
    } else {
      ensureLibrariesLoaded();
    }
    const searchInput = $('#icon-picker-library-search');
    if (searchInput) {
      searchInput.value = '';
      setTimeout(() => searchInput.focus(), 30);
    }
  } else {
    closeLibraryPanel();
  }
}

function closeLibraryPanel() {
  $('#icon-picker-library-panel')?.classList.add('hidden');
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Open the icon picker modal.
 * @param {{ onSelect: (icon: { prefix: string, name: string, dataUri: string, width: number, height: number }) => void }} options
 */
export function openIconPicker({ onSelect }) {
  onSelectCallback = onSelect;

  const modal = $('#icon-picker-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  // Always reset to a predictable starting point on open.
  pickerState.prefix = '';
  pickerState.category = '';
  const labelEl = $('#icon-picker-library-label');
  if (labelEl) labelEl.textContent = 'All libraries';
  $('#icon-picker-category')?.classList.add('hidden');
  closeLibraryPanel();

  const input = $('#icon-picker-search');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 50);
  }

  runQuery(); // shows recent/favorites immediately
}

/**
 * Close the icon picker modal and cancel any in-flight request.
 */
export function closeIconPicker() {
  const modal = $('#icon-picker-modal');
  if (modal) modal.classList.add('hidden');
  closeLibraryPanel();

  if (currentController) {
    currentController.abort();
    currentController = null;
  }
  clearTimeout(debounceTimer);
  onSelectCallback = null;
}

export function isIconPickerOpen() {
  const modal = $('#icon-picker-modal');
  return modal && !modal.classList.contains('hidden');
}

/**
 * Wire up static event listeners. Call once during app init.
 */
export function initIconPicker() {
  $('#icon-picker-search')?.addEventListener('input', scheduleQuery);
  $('#icon-picker-close')?.addEventListener('click', closeIconPicker);
  $('#icon-picker-retry')?.addEventListener('click', handleRetryClick);
  $('#icon-picker-loadmore')?.addEventListener('click', handleLoadMoreClick);
  $('#icon-picker-category')?.addEventListener('change', onCategoryChange);

  $('#icon-picker-library-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLibraryPanel();
  });
  $('#icon-picker-library-search')?.addEventListener('input', (e) => {
    if (librariesLoadState === 'ready') renderLibraryList(e.target.value);
  });

  // Click outside the library panel (but not its toggle button) closes it,
  // without also closing the whole modal (the modal's own backdrop-click
  // handler only fires when the click target is the backdrop itself).
  document.addEventListener('click', (e) => {
    const panel = $('#icon-picker-library-panel');
    const btn = $('#icon-picker-library-btn');
    if (!panel || panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || btn?.contains(e.target)) return;
    closeLibraryPanel();
  });

  const modal = $('#icon-picker-modal');
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeIconPicker();
  });
}
