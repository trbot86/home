// Run with android-webview.mjs after opening the inbox on the isolated emulator.
(() => {
  const footer = document.querySelector('.capture-footer').getBoundingClientRect();
  const controls = [...document.querySelectorAll('.capture-footer button, .capture-footer select')];
  for (const label of ['Gallery', 'Camera', 'Dictate']) {
    if (!controls.some(element => element.textContent.trim() === label)) throw new Error(`Missing native control: ${label}`);
  }
  for (const element of controls) {
    const bounds = element.getBoundingClientRect();
    if (bounds.left < footer.left || bounds.right > footer.right || bounds.bottom > footer.bottom) {
      throw new Error(`Clipped capture control: ${element.textContent.trim()}`);
    }
  }
  for (const label of document.querySelectorAll('.nav-label-compact')) {
    if (label.getBoundingClientRect().height > parseFloat(getComputedStyle(label).lineHeight) + 1) throw new Error('Wrapped navigation label');
  }
  if (document.documentElement.scrollWidth > innerWidth) throw new Error('Horizontal overflow');
  return { width: innerWidth, height: innerHeight, controlsFit: true, nativeControlsPresent: true, viewport: document.querySelector('meta[name=viewport]').content };
})();
