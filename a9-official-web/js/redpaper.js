const root = document.documentElement;

function applyPreferences() {
  document.title = root.lang === 'en' ? 'A9 Redpaper' : 'A9 红皮书';
  const dark = root.dataset.theme === 'dark';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#161619' : '#F6F6F8';
  const themeBtn = document.querySelector('#paper-theme');
  if (themeBtn) themeBtn.setAttribute('aria-pressed', String(dark));
  const themeIcon = document.querySelector('#paper-theme-icon');
  if (themeIcon) themeIcon.textContent = dark ? '☀' : '☾';
}

document.querySelector('#paper-language').addEventListener('click', () => {
  root.lang = root.lang === 'en' ? 'zh-CN' : 'en';
  try {
    localStorage.setItem('a9_official_lang', root.lang === 'en' ? 'en' : 'zh');
  } catch {}
  applyPreferences();
});

document.querySelector('#paper-theme').addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('a9_official_theme', root.dataset.theme);
  } catch {}
  applyPreferences();
});

document.querySelector('#paper-back-to-top')?.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

applyPreferences();

const tocLinks = Array.from(document.querySelectorAll('.paper-toc a[href^="#"]'));
const chapters = tocLinks
  .map((link) => document.querySelector(link.getAttribute('href')))
  .filter(Boolean);

if ('IntersectionObserver' in window && chapters.length > 0) {
  const setActiveToc = (id) => {
    tocLinks.forEach((link) => {
      const match = link.getAttribute('href') === `#${id}`;
      link.classList.toggle('is-active', match);
      if (match) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  };
  setActiveToc(chapters[0].id);
  const tocObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
    if (visible.length > 0) setActiveToc(visible[0].target.id);
  }, { rootMargin: '-20% 0px -65% 0px', threshold: [0.1, 0.35] });
  chapters.forEach((chapter) => tocObserver.observe(chapter));
}

const principalInput = document.querySelector('#paper-principal');
const amountFormatter = new Intl.NumberFormat('en-US');

function updateScenarios() {
  const principal = principalInput.valueAsNumber;
  const valid = Number.isSafeInteger(principal)
    && principal >= Number(principalInput.min)
    && principal <= Number(principalInput.max);
  principalInput.setAttribute('aria-invalid', String(!valid));
  document.querySelector('#paper-input-error').hidden = valid;

  for (const [id, value] of [
    ['paper-reward-cap', principal * 15],
    ['paper-burn', principal],
    ['paper-refund', principal],
  ]) {
    document.getElementById(id).textContent = valid ? `${amountFormatter.format(value)} A9` : '—';
  }
}

principalInput.addEventListener('input', updateScenarios);
updateScenarios();
