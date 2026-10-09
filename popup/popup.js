const $ = (id) => document.getElementById(id);

// Any Vinted market. The extension only runs where the manifest lets it, so
// this only has to be loose enough to recognise the tab.
const VINTED = /^https?:\/\/([a-z0-9-]+\.)*vinted\.(ro|fr|de|pl|co\.uk|at|be|cz|dk|ee|es|fi|gr|hr|hu|ie|it|lt|lu|lv|nl|pt|se|si|sk|com|com\.au|au)\//i;

async function activeVintedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && VINTED.test(tab.url || '') ? tab : null;
}

// Everything the popup shows lives in the content script, so one message
// covers it. That keeps the extension down to a single "storage" permission.
function ask(tabId, type) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type }, (reply) => {
      void chrome.runtime.lastError;
      resolve(reply || null);
    });
  });
}

const secs = (ms) => Math.max(0, Math.round(ms / 1000));

function blank(message) {
  for (const id of ['page', 'guessed', 'users', 'items', 'sent', 'tokens']) {
    $(id).textContent = '–';
  }
  $('progress-wrap').hidden = true;
  $('status').textContent = message;
}

async function refresh() {
  const tab = await activeVintedTab();
  if (!tab) {
    blank('Open a Vinted tab to see activity.');
    return;
  }

  const stats = await ask(tab.id, 'vcf-stats');
  if (!stats) {
    blank('Reload the Vinted tab to activate.');
    return;
  }
  if (!stats.active) {
    blank('This domain did not answer Vinted’s country API.');
    return;
  }
  $('status').textContent = '';

  $('page').textContent = stats.seen ? stats.flagged + ' / ' + stats.seen : '–';
  $('guessed-row').hidden = !stats.guessed;
  $('guessed').textContent = stats.guessed;
  $('sent').textContent = stats.sent;
  $('tokens').textContent = stats.tokens + ' left';
  $('users').textContent = stats.users;
  $('items').textContent = stats.items;

  $('circuit-row').hidden = !stats.circuitOpen;
  if (stats.circuitOpen) $('circuit-for').textContent = secs(stats.etaMs) + ' s';

  // Every uncached seller costs a lookup and a cold grid fills in over about
  // a minute. Saying so beats letting it look broken: the flags that are not
  // there yet are the whole complaint a user would have.
  const waiting = stats.pending > 0 && !stats.circuitOpen;
  $('progress-wrap').hidden = !waiting;
  if (waiting) {
    const done = stats.flagged;
    const total = Math.max(stats.seen, done + stats.pending);
    $('bar').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    $('progress-text').textContent =
      'Filling in ' + stats.pending + ' more, about ' + secs(stats.etaMs) + ' s.';
  }

  // Vinted dropped the currency from its grid data, so the price fingerprint
  // has to learn its rates from looked-up sellers before it helps. A euro
  // domain never gets there, everyone prices in euro.
  $('note').textContent = stats.euroDomain
    ? 'Everyone here prices in euro, so each seller is looked up once, starting '
      + 'with the cards on screen. Answers are cached for 30 days and shared '
      + 'with every other Vinted site.'
    : 'The first sellers are looked up once each. They also teach the extension '
      + 'the exchange rates, and after that most flags come from the price for '
      + 'free. Answers are cached for 30 days and shared with every other Vinted site.';
}

chrome.storage.local.get({ enabled: true }, (cfg) => {
  $('enabled').checked = cfg.enabled !== false;
});

$('enabled').addEventListener('change', (e) => {
  chrome.storage.local.set({ enabled: e.target.checked });
});

$('clear').addEventListener('click', async () => {
  const tab = await activeVintedTab();
  if (!tab) return;
  await ask(tab.id, 'vcf-clear');
  refresh();
});

refresh();
setInterval(refresh, 1000);
