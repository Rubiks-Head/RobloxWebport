// i18n.js — string table + T() for every user-facing string in the client.
// Add a locale by copying `en` under its BCP-47 code; T() falls back to en.
// Wasm strings can't be localized in-place (fixed data) — the banner/loading
// layer covers everything the page itself renders.
(function (g) {
  'use strict';
  const en = {
    'auth.loggingIn': 'Logging in with Roblox auth token...',
    'auth.done': 'Authenticated in %s ms',
    'auth.welcome': "Welcome %s to RubiksHead's roblox webport!",
    'auth.repo': 'This is a opensource webport at the [RubiksHead Github Repo](https://github.com/Rubiks-Head/Roblox-Webport)',
    'auth.standby': 'Continuing log stream via console. Please stand by for <%s> to load',
    'auth.none': 'You dont have auth!',
    'loading.waiting': 'Waiting for experience',
    'loading.joining': 'Joining server',
    'loading.loading': 'Loading experience...',
    'loading.cancel': 'Cancel',
    'loading.leave': 'Leave',
    'error.join': 'Join Error',
    'error.server': 'Failed to connect to the server. Please check your internet connection and try again.',
    'error.http': 'A Http error has occurred. Please close the client and try again.',
  };
  const langs = { en };
  let active = 'en';
  function setLang(code) {
    if (!code) return;
    if (langs[code]) active = code;
    else if (langs[code.split('-')[0]]) active = code.split('-')[0];
  }
  setLang((g.navigator && (g.navigator.languages || [])[0]) || (g.navigator && g.navigator.language));
  function T(key, ...args) {
    let s = (langs[active] && langs[active][key]) || en[key] || key;
    for (const a of args) s = s.replace('%s', a);
    return s;
  }
  g.T = T;
  g.i18n = { langs, setLang, get lang() { return active; } };
})(typeof window !== 'undefined' ? window : self);
