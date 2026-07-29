// Download interception inside the MakerWorld WebView.
//
// MakerWorld throws a GeeTest CAPTCHA at headless API requests (HTTP 418,
// "confirm you are not a robot"), so the only reliable way to obtain a 3MF is
// the real page: the operator taps the site's own Download button and solves the
// challenge if shown. This module owns the injected hook that reports the
// resulting file, and the parsing of what the page sends back.
//
// Everything arriving through `onMessage` is attacker-controlled — it is a
// string produced by a remote page. It is parsed here, defensively and without
// React, so the rules can be tested directly. The hook itself is shared with
// `app/makerworld-download.tsx`'s existing flow rather than reimplemented.

/**
 * Largest message accepted from the page.
 *
 * Blob handoffs arrive base64-encoded inside the message, so this has to be
 * generous, but an unbounded string from a remote page is a memory-exhaustion
 * primitive. 64 MB of base64 is ~48 MB of file, well under the download cap in
 * `DownloadHostPolicy`; anything larger has to come through a URL instead.
 */
export const MAX_HOOK_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Extensions treated as a model download when navigation is intercepted. */
const MODEL_FILE_PATTERN = /\.(3mf|stl)(\?|#|$)/i;

const DATA_URL_PREFIX = /^data:[^,]*;base64,/i;

/**
 * Patches `fetch`, `XHR`, `window.open` and anchor clicks before the SPA loads,
 * so every way MakerWorld can deliver a 3MF — a JSON `{url}` response, a direct
 * link, or an in-page blob — is reported back to React Native.
 *
 * Injected with `injectedJavaScriptBeforeContentLoaded` so it is in place before
 * any page script runs. Kept as ES5 in a single expression because it is
 * evaluated by the WebView, not bundled by Metro.
 */
export const MAKERWORLD_DOWNLOAD_HOOK = `(function(){
  if (window.__mwHook) return; window.__mwHook = true;
  function report(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  function file(url,name){ if(url) report({t:'file',url:url,name:name||''}); }
  function scan(u,text){
    if (typeof u==='string' && u.indexOf('/f3mf')>-1){
      try { var j=JSON.parse(text); if(j&&j.url) file(j.url, j.name); } catch(e){}
    }
  }
  var of = window.fetch;
  window.fetch = function(){
    var args = arguments;
    var u = (args[0] && args[0].url) ? args[0].url : args[0];
    return of.apply(this,args).then(function(resp){
      try { resp.clone().text().then(function(t){ scan(u,t); }); } catch(e){}
      return resp;
    });
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__u=u; return oo.apply(this,arguments); };
  XMLHttpRequest.prototype.send = function(){
    var x=this;
    x.addEventListener('load', function(){ try{ scan(x.__u, x.responseText); }catch(e){} });
    return os.apply(this,arguments);
  };
  var ow = window.open;
  window.open = function(u){ if (u && /\\.(3mf|stl)(\\?|$)/i.test(u)) { file(u, u.split('?')[0].split('/').pop()); return null; } return ow.apply(this, arguments); };
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.href || '';
    if (href.indexOf('blob:') === 0) {
      e.preventDefault();
      fetch(href).then(function(r){ return r.blob(); }).then(function(b){
        var fr = new FileReader();
        fr.onload = function(){ report({ t:'blob', data:String(fr.result), name:(a.getAttribute('download')||'model.3mf') }); };
        fr.readAsDataURL(b);
      }).catch(function(err){ report({ t:'err', msg:String(err) }); });
    } else if (/\\.(3mf|stl)(\\?|$)/i.test(href)) {
      file(href, a.getAttribute('download') || href.split('?')[0].split('/').pop());
    }
  }, true);
})(); true;`;

/**
 * Reports the browsing WebView's current location back to React Native on every
 * SPA route change.
 *
 * MakerWorld is a single-page app, so `onNavigationStateChange` does not fire
 * for in-app route changes and the URL shown in the toolbar would go stale.
 * Patching the history API is what keeps "open current model" honest.
 */
export const MAKERWORLD_LOCATION_HOOK = `(function(){
  if (window.__mwLoc) return; window.__mwLoc = true;
  function send(){ try{ window.ReactNativeWebView.postMessage(JSON.stringify({t:'loc',url:String(location.href)})); }catch(e){} }
  var push = history.pushState, replace = history.replaceState;
  history.pushState = function(){ var r = push.apply(this, arguments); send(); return r; };
  history.replaceState = function(){ var r = replace.apply(this, arguments); send(); return r; };
  window.addEventListener('popstate', send);
  window.addEventListener('hashchange', send);
  send();
})(); true;`;

export type CapturedDownload =
  | { kind: 'url'; sourceUrl: string; suggestedName: string }
  | { kind: 'blob'; base64: string; suggestedName: string };

export type HookMessage =
  | CapturedDownload
  | { kind: 'location'; url: string }
  | { kind: 'page-error'; message: string };

/**
 * Interprets one message from the injected hook.
 *
 * Returns `null` for anything unrecognised, oversized or malformed rather than
 * throwing: a hostile page should not be able to break the browsing screen by
 * posting rubbish, and an unparseable message is simply not a download.
 */
export function parseHookMessage(raw: string): HookMessage | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > MAX_HOOK_MESSAGE_BYTES) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const message = payload as Record<string, unknown>;
  const type = typeof message.t === 'string' ? message.t : '';

  if (type === 'file') {
    const sourceUrl = readString(message.url);
    if (!sourceUrl) return null;
    return { kind: 'url', sourceUrl, suggestedName: readString(message.name) };
  }

  if (type === 'blob') {
    const data = readString(message.data);
    if (!data || !DATA_URL_PREFIX.test(data)) return null;
    const base64 = data.slice(data.indexOf(',') + 1);
    if (!base64) return null;
    return { kind: 'blob', base64, suggestedName: readString(message.name) };
  }

  if (type === 'loc') {
    const url = readString(message.url);
    return url ? { kind: 'location', url } : null;
  }

  if (type === 'err') {
    return { kind: 'page-error', message: readString(message.msg) || 'The page reported an error.' };
  }

  return null;
}

/**
 * Whether a navigation is really a file download to intercept.
 *
 * Some MakerWorld flows redirect straight to the CDN rather than fetching in
 * page. Those must be caught and turned into a managed download, because letting
 * the WebView handle them would drop the file outside the app.
 */
export function isModelFileUrl(url: string): boolean {
  return typeof url === 'string' && MODEL_FILE_PATTERN.test(url);
}

/**
 * Best-effort filename from a URL, for when the page supplies none.
 *
 * Never trusted directly — the caller passes the result through
 * `sanitizeDownloadFilename`, which is what actually makes it safe to write.
 */
export function filenameFromUrl(url: string): string {
  const withoutQuery = url.split('#')[0].split('?')[0];
  const lastSegment = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
