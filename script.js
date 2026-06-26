// Mobile nav toggle
const toggle = document.getElementById("navToggle");
const links = document.getElementById("navLinks");
if (toggle && links) {
  toggle.addEventListener("click", () => links.classList.toggle("open"));
  links.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => links.classList.remove("open"))
  );
}

// Current year in footer
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Subtle reveal on scroll
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.style.opacity = "1";
        e.target.style.transform = "none";
        observer.unobserve(e.target);
      }
    });
  },
  { threshold: 0.12 }
);

const revealEls = document.querySelectorAll(".card, .step, .safety-card, .mock-card");
revealEls.forEach((el) => {
  el.style.opacity = "0";
  el.style.transform = "translateY(18px)";
  el.style.transition = "opacity .5s ease, transform .5s ease";
  observer.observe(el);
});

// Safety fallback: never leave content hidden (e.g. if observer never fires).
const revealAll = () =>
  revealEls.forEach((el) => {
    el.style.opacity = "1";
    el.style.transform = "none";
  });
window.addEventListener("load", () => setTimeout(revealAll, 2500));
