// Runs before the page draws so it doesn't flash the wrong theme (a file, because the page's security policy allows no inline scripts).
(function () {
  var p = 'dark';
  try { p = localStorage.getItem('st-theme') || 'dark'; } catch (e) {}
  var light = p === 'light' || (p === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
})();
