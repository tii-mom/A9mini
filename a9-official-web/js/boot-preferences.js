try {
  const root = document.documentElement;
  if (localStorage.getItem('a9_official_theme') === 'dark') {
    root.dataset.theme = 'dark';
    document.querySelector('meta[name="theme-color"]').content = '#161619';
  }
  if (localStorage.getItem('a9_official_lang') === 'en') root.lang = 'en';
} catch {}
