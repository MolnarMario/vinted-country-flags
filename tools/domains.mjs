// The one list of Vinted markets, used to generate the manifest.
//
// Chrome match patterns cannot wildcard a TLD, so "*://*.vinted.*/*" is not a
// thing and every domain has to be written out three times over. This file is
// the source; tools/make-manifest.mjs writes them into manifest.json.
//
// `verified` means a live request to /api/v2/countries answered on that domain
// on 2026-08-31. The rest follow Vinted's obvious pattern and all resolve in
// DNS, but DNS proves nothing here: vinted.ca resolves too and Canada is not a
// market. An unverified domain costs nothing if it turns out to be a parking
// page, because countries.js disables the extension when the API does not
// answer.

export const DOMAINS = [
  { host: 'vinted.ro', country: 'RO', verified: true },
  { host: 'vinted.fr', country: 'FR', verified: true },
  { host: 'vinted.de', country: 'DE', verified: true },
  { host: 'vinted.pl', country: 'PL', verified: true },
  { host: 'vinted.co.uk', country: 'GB', verified: true },

  { host: 'vinted.at', country: 'AT' },
  { host: 'vinted.be', country: 'BE' },
  { host: 'vinted.cz', country: 'CZ' },
  { host: 'vinted.dk', country: 'DK' },
  { host: 'vinted.ee', country: 'EE' },
  { host: 'vinted.es', country: 'ES' },
  { host: 'vinted.fi', country: 'FI' },
  { host: 'vinted.gr', country: 'GR' },
  { host: 'vinted.hr', country: 'HR' },
  { host: 'vinted.hu', country: 'HU' },
  { host: 'vinted.ie', country: 'IE' },
  { host: 'vinted.it', country: 'IT' },
  { host: 'vinted.lt', country: 'LT' },
  { host: 'vinted.lu', country: 'LU' },
  { host: 'vinted.lv', country: 'LV' },
  { host: 'vinted.nl', country: 'NL' },
  { host: 'vinted.pt', country: 'PT' },
  { host: 'vinted.se', country: 'SE' },
  { host: 'vinted.si', country: 'SI' },
  { host: 'vinted.sk', country: 'SK' },
  { host: 'vinted.com', country: 'US' },

  // Australia is in /api/v2/countries but I never loaded its site. Both
  // spellings are registered, so both are here until one is confirmed.
  { host: 'vinted.com.au', country: 'AU' },
  { host: 'vinted.au', country: 'AU' },
];

export const MATCHES = DOMAINS.map((d) => `*://*.${d.host}/*`);
