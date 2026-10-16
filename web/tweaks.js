// Extra keys: Z = left flipper, / = right flipper (sent as the arrow keys)
function dispatchKey(code) {
  window.dispatchEvent(new KeyboardEvent("keydown", {keyCode: code, which: code, bubbles: true}));
}
function dispatchKeyUp(code) {
  window.dispatchEvent(new KeyboardEvent("keyup", {keyCode: code, which: code, bubbles: true}));
}
window.addEventListener("keydown", function (e) {
  if (e.key === "z" || e.key === "Z") dispatchKey(37);
  if (e.key === "/") dispatchKey(39);
}, true);
window.addEventListener("keyup", function (e) {
  if (e.key === "z" || e.key === "Z") dispatchKeyUp(37);
  if (e.key === "/") dispatchKeyUp(39);
}, true);
