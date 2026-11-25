const productionHosts = new Set(['a9.lat', 'www.a9.lat']);
const pages = new Set(['/', '/index.html', '/a9.json', '/robots.txt', '/manifest.webmanifest', '/redpaper', '/greenpaper', '/rules']);
const documentPolicy = "default-src 'self'; base-uri 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests";

export default {
  async fetch(request, env) {
    const { hostname, pathname } = new URL(request.url);
    const readOnly = request.method === 'GET' || request.method === 'HEAD';
    const page = pages.has(pathname.replace(/\/$/, '') || '/');
    const asset = /^\/(assets|css|js)\//.test(pathname);

    if (readOnly && (page || asset)) {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) {
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', documentPolicy);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        return new Response(response.body, { status: response.status, headers });
      }
    }

    if (productionHosts.has(hostname)) return fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
