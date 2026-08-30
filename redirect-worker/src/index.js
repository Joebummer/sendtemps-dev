// sendtemps-redirect — single-purpose Worker.
//
// Permanently redirects every request on sendtemps.app (and its www/
// subdomains, via the route pattern in wrangler.toml) to the equivalent
// path on climbable.app. Preserves path + query string.
//
// This exists because Cloudflare Bulk Redirects were unreliable once
// sendtemps.app had been a Pages custom domain — a Worker route is a much
// more direct, debuggable mechanism: it runs first, always, for any
// matched route, with no dependency on Bulk Redirect list state or DNS
// record content.
//
// Deliberately separate from sendtemps-api (api.sendtemps.app) — this
// Worker only ever touches sendtemps.app/* and www.sendtemps.app/*.

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = `https://climbable.app${url.pathname}${url.search}`;
    return Response.redirect(target, 301);
  },
};
