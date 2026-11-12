/**
 * jsdom has no layout: every element measures 0 x 0, so a virtual list would see a zero-height
 * viewport and rows of no height. This shim gives the sidebar's scroll element (`sidebar-scroll`)
 * a height and every virtual row (`li[data-index]` inside `sidebar-list`) a fixed one, the way
 * `@tanstack/react-virtual`'s own tests stub their elements: by overriding the layout getters the
 * library reads (`clientHeight`/`clientWidth` for the viewport, `offsetHeight` for a row).
 *
 * The default viewport is tall enough for ~100 rows, so tests that are not about virtualisation
 * see every row of their small fixtures. A test that is sets a short one with `setSidebarLayout`.
 */
export interface SidebarLayout {
  /** Height of the sidebar's scroll viewport in px. */
  viewport: number;
  /** Height of one virtual row in px. */
  row: number;
}

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = { viewport: 6000, row: 58 };

let current: SidebarLayout = { ...DEFAULT_SIDEBAR_LAYOUT };

/** Call before rendering; the setup file resets it after each test. */
export function setSidebarLayout(layout: Partial<SidebarLayout>): void {
  current = { ...current, ...layout };
}

export function resetSidebarLayout(): void {
  current = { ...DEFAULT_SIDEBAR_LAYOUT };
}

function isScroller(el: Element): boolean {
  return el.getAttribute('data-testid') === 'sidebar-scroll';
}

function isVirtualRow(el: Element): boolean {
  return (
    el.hasAttribute('data-index') &&
    el.parentElement?.getAttribute('data-testid') === 'sidebar-list'
  );
}

/** What a scroller's `scrollTop` is (jsdom keeps none): written by `scrollTo` and tests. */
const scrollTops = new WeakMap<Element, number>();

/** Scrolls the sidebar's scroller the way a browser does: set `scrollTop`, fire `scroll`. */
export function scrollSidebarTo(el: Element, top: number): void {
  scrollTops.set(el, Math.max(0, top));
  el.dispatchEvent(new Event('scroll'));
}

export function installLayoutShim(): void {
  if (typeof HTMLElement === 'undefined') return;
  const define = (
    name: 'clientHeight' | 'clientWidth' | 'offsetHeight',
    get: (el: HTMLElement) => number,
  ) => {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return get(this);
      },
    });
  };
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      if (isScroller(this)) scrollTops.set(this, value);
    },
  });
  // `scrollToIndex` ends in `element.scrollTo({ top })`, which jsdom does not implement.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options?: ScrollToOptions) {
      if (isScroller(this) && typeof options?.top === 'number') scrollSidebarTo(this, options.top);
    },
  });
  // The browser's max scroll offset is `scrollHeight - clientHeight`: the list's own height.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!isScroller(this)) return 0;
      const list = this.querySelector<HTMLElement>('[data-testid="sidebar-list"]');
      return Number.parseFloat(list?.style.height ?? '') || 0;
    },
  });
  define('clientHeight', (el) => (isScroller(el) ? current.viewport : 0));
  define('clientWidth', (el) => (isScroller(el) ? 260 : 0));
  define('offsetHeight', (el) => (isVirtualRow(el) ? current.row : 0));
}
