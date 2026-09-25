// Helpers d'échappement partagés par app.js (desktop) et mobile-app.js.
// Script sans import/export : chargé en side-effect (`import '/escape.js'`)
// et testé côté Node dans api/tests/lib/front-escape.test.js.

// esc : échappe les 5 caractères dangereux pour une insertion HTML (texte
// d'un élément, valeur d'attribut entre guillemets : title, value, href…).
// Ne protège PAS une chaîne JS dans un handler inline : dans
// onclick="fn('${esc(x)}')", le navigateur décode `&#39;` en `'` AVANT
// d'exécuter le JS, donc x = `');alert(1);//` s'échappe du littéral.
// Pour un handler inline, utiliser jsArg().
window.esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

// jsArg : sérialise une valeur en littéral de chaîne JS pour un handler
// inline — onclick="fn(${jsArg(x)})", sans quotes autour (jsArg fournit les
// siennes). À utiliser pour toute valeur qui n'est pas un UUID/entier généré
// par le serveur (nom, libellé, hostname, email, IP, texte libre, paramètre
// d'URL…).
//
// Règle : la valeur d'un attribut HTML est décodée (entités &quot; &#39;
// &amp;…) PUIS parsée comme du JS. L'encodage doit survivre aux deux étapes :
//   1. JSON.stringify produit un littéral JS valide (\, ", retours à la
//      ligne et caractères de contrôle échappés) ;
//   2. & < > ' U+2028 U+2029 deviennent des séquences \uXXXX : il ne reste
//      aucun caractère que le parseur HTML interprète, et une entité écrite
//      dans la valeur (ex. `&quot;`) ne peut plus être décodée en guillemet
//      qui fermerait le littéral ;
//   3. les " (délimiteurs et \" internes) deviennent &quot;, que le
//      navigateur redécode en " juste avant d'évaluer le JS : l'attribut,
//      entre "…" comme entre '…', ne peut pas être refermé.
// Ne convient qu'à un attribut entre guillemets passé par le parseur HTML
// (innerHTML, insertAdjacentHTML…), pas à setAttribute() ni à du JS direct.
window.jsArg = (v) => JSON.stringify(String(v ?? ''))
  .replace(/[&<>'\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  .replace(/"/g, '&quot;')
