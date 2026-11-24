/** 首屏同步主题初始化，避免深浅色模式切换闪烁。 */
(function () {
  try {
    var raw = localStorage.getItem('a9_ui_prefs_v1');
    var p = raw ? JSON.parse(raw) : null;
    var t = (p && p.settings && p.settings.themeMode) || localStorage.getItem('a9_theme_mode');
    if (t === 'dark' || t === 'light') {
      document.documentElement.dataset.theme = t;
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute('content', t === 'dark' ? '#15161A' : '#F4F5F8');
    }
  } catch (e) {}
})();
