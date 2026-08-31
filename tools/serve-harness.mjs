// Serves the harness to a Vinted tab for the live integration test.
// Chrome exempts localhost from mixed-content blocking, so an https page can
// fetch it. Run: node tools/make-harness.mjs && node tools/serve-harness.mjs
//
// Then, in the Vinted tab's console:
//   const p = await (await fetch('http://localhost:8731')).json();
//   const un = async (b64) => new Response(
//     new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))])
//       .stream().pipeThrough(new DecompressionStream('gzip'))).text();
//   (0, eval)(await un(p.libs)); (0, eval)(await un(p.content));
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = 8731;
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  // Chrome treats an https page reaching localhost as a private network
  // request and sends a preflight first. Without this header it fails with no
  // useful error and the fetch just hangs.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  try {
    const payload = JSON.stringify({
      libs: readFileSync('.harness-libs.b64', 'utf8').trim(),
      content: readFileSync('.harness-content.b64', 'utf8').trim(),
    });

    if (req.url.startsWith('/payload')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(payload);
      return;
    }

    // Chrome will not let an https page fetch localhost, but it will let one
    // open localhost in a tab. So the page hands itself back through
    // window.opener instead, which is an ordinary cross-origin postMessage.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>harness</title><body style="font:16px sans-serif">
<p id="s">sending…</p><script>
fetch('/payload').then(r => r.json()).then(p => {
  if (!window.opener) { document.getElementById('s').textContent = 'no opener'; return; }
  window.opener.postMessage({ vcf: p }, '*');
  document.getElementById('s').textContent = 'sent ' + p.libs.length + '+' + p.content.length;
});
</script>`);
  } catch (e) {
    res.statusCode = 500;
    res.end('error: ' + e.message);
  }
}).listen(PORT, '127.0.0.1', () => console.log('harness on http://localhost:' + PORT));
