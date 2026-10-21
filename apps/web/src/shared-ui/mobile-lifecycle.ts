/**
 * Keep player controls clear of an iOS keyboard and reserve their actual height.
 * Uses the visual viewport in Safari and also works when a native WebView
 * resizes its layout viewport. No keyboard-height constants or forced page scroll.
 */
export function initializeMobileLayout(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const root = document.documentElement;
  const viewport = window.visualViewport;
  const properties = ['--visual-viewport-height', '--keyboard-bottom', '--player-dock-height'];
  const previousProperties = properties.map((name): [string, string] => [
    name,
    root.style.getPropertyValue(name),
  ]);
  const previousKeyboardState = root.getAttribute('data-keyboard-open');
  let frame: number | null = null;
  let disposed = false;
  let docks: HTMLElement[] = [];
  let restingHeight = window.innerHeight;
  let previousWidth = window.innerWidth;

  const setProperty = (name: string, value: string) => {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  };
  const editingText = () => {
    const element = document.activeElement;
    if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
    if (element instanceof HTMLInputElement) {
      return (
        !element.readOnly &&
        !element.disabled &&
        ['text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes(element.type)
      );
    }
    return element instanceof HTMLElement && element.isContentEditable;
  };
  const schedule = () => {
    if (!disposed && frame === null) frame = window.requestAnimationFrame(syncLayout);
  };
  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);

  function syncLayout() {
    frame = null;
    if (disposed) return;
    const editing = editingText();
    // Pinch zoom is an accessibility feature, not a keyboard opening. Do not
    // resize/reposition the page around a magnified visual viewport.
    const unzoomed = !viewport || Math.abs(viewport.scale - 1) < 0.02;
    const height = unzoomed ? (viewport?.height ?? window.innerHeight) : window.innerHeight;
    const widthChanged = Math.abs(window.innerWidth - previousWidth) > 1;
    if (!editing || widthChanged) restingHeight = window.innerHeight;
    previousWidth = window.innerWidth;
    const coveredBottom =
      viewport && editing && unzoomed
        ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        : 0;
    const keyboardOpen =
      editing && unzoomed && (coveredBottom > 80 || restingHeight - height > 100);
    setProperty('--visual-viewport-height', `${Math.max(1, Math.round(height))}px`);
    setProperty('--keyboard-bottom', `${Math.ceil(coveredBottom)}px`);
    const keyboardState = String(keyboardOpen);
    if (root.getAttribute('data-keyboard-open') !== keyboardState) {
      root.setAttribute('data-keyboard-open', keyboardState);
    }

    const nextDocks = Array.from(document.querySelectorAll<HTMLElement>('.p-cta-bar, .p-pick-bar'));
    if (
      nextDocks.length !== docks.length ||
      nextDocks.some((dock, index) => dock !== docks[index])
    ) {
      resizeObserver?.disconnect();
      docks = nextDocks;
      docks.forEach((dock) => resizeObserver?.observe(dock));
    }
    const dockHeight = Math.max(
      0,
      ...docks.map((dock) => {
        if (window.getComputedStyle(dock).position !== 'fixed') return 0;
        // offsetHeight ignores the entrance animation's temporary scale.
        return dock.offsetHeight;
      }),
    );
    setProperty('--player-dock-height', `${Math.ceil(dockHeight)}px`);
  }

  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body ?? root, { childList: true, subtree: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.addEventListener('pageshow', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  document.addEventListener('visibilitychange', schedule);
  viewport?.addEventListener('resize', schedule, { passive: true });
  viewport?.addEventListener('scroll', schedule, { passive: true });
  schedule();

  return () => {
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    mutations.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    window.removeEventListener('pageshow', schedule);
    document.removeEventListener('focusin', schedule);
    document.removeEventListener('focusout', schedule);
    document.removeEventListener('visibilitychange', schedule);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    for (const [name, value] of previousProperties) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
    if (previousKeyboardState === null) root.removeAttribute('data-keyboard-open');
    else root.setAttribute('data-keyboard-open', previousKeyboardState);
  };
}
