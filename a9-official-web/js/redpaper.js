const root = document.documentElement;

function applyPreferences() {
  document.title = root.lang === 'en' ? 'A9 Redpaper' : 'A9 红皮书';
  const dark = root.dataset.theme === 'dark';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#15161A' : '#F4F5F8';
  document.querySelector('#paper-theme').setAttribute('aria-pressed', String(dark));
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

applyPreferences();

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
