/** 生产域名默认只读配置注入（在 app.js 之前同步执行）。 */
if (window.location.origin === 'https://app.a9.lat') {
  window.__A9_CONFIG__ = {
    ...window.__A9_CONFIG__,
    mode: 'live',
    apiBase: 'https://api.a9.lat',
    liveFundsEnabled: false,
  };
}
