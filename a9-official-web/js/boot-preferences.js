try {
  const root = document.documentElement;
  if (localStorage.getItem('a9_official_theme') === 'dark') {
    root.dataset.theme = 'dark';
    document.querySelector('meta[name="theme-color"]').content = '#15161A';
  }
  if (localStorage.getItem('a9_official_lang') === 'en') root.lang = 'en';
} catch {}
