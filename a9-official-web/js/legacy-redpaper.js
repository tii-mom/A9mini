const destination = new URL(document.querySelector('#redpaper-destination').href);
const aliases = new Map([
  ['#model', '#token-data'],
  ['#bp-principal-risk', '#principal-risk'],
]);
const sections = new Set(['#bp-gates', '#rules', '#token-data', '#scenarios', '#verification', '#principal-risk']);
const hash = aliases.get(location.hash) ?? location.hash;
if (sections.has(hash)) destination.hash = hash;
location.replace(destination.href);
