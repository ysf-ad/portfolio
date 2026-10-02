"use strict";

// All content and navigation work without JavaScript; this only adds the year and the theme toggle.
document.getElementById("year").textContent = String(new Date().getFullYear());

const toggle = document.querySelector(".theme-toggle");
function showToggle() {
  const dark = document.documentElement.dataset.theme === "dark";
  toggle.textContent = dark ? "Light" : "Dark";
  toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}
toggle.addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
  } catch (e) {}
  showToggle();
});
showToggle();

// Scroll reveals: blocks below the fold fade up as they come into view (cards in a row are staggered).
// (browsers without IntersectionObserver simply show everything)
if ("IntersectionObserver" in window) document.documentElement.classList.add("js");
const revealObserver = "IntersectionObserver" in window && new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("in");
      revealObserver.unobserve(entry.target);
    });
  },
  { rootMargin: "0px 0px -8% 0px" }
);
if (revealObserver) document.querySelectorAll(".reveal").forEach((el) => {
  const siblings = [...el.parentElement.querySelectorAll(":scope > .reveal")];
  el.style.setProperty("--stagger", `${siblings.indexOf(el) * 80}ms`);
  revealObserver.observe(el);
});
