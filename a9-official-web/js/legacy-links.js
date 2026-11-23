const legacyHomeAnchors = new Map([
  ['#war', '#observatory'],
  ['#floor', '#observatory'],
  ['#ladder', '#observatory'],
  ['#supply', '#allocation'],
  ['#cmd', '#sandbox'],
  ['#rules', './redpaper/#rules'],
  ['#risk', './redpaper/#principal-risk'],
]);

function followLegacyAnchor() {
  const target = legacyHomeAnchors.get(location.hash);
  if (target) location.replace(target);
}

followLegacyAnchor();
window.addEventListener('hashchange', followLegacyAnchor);
