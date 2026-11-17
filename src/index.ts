import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/app.js";

if (!("scrollBehavior" in document.documentElement.style)) {
    import("./polyfill/smooth-scroll.js");
}

const container = document.querySelector(".app-container");
if (!(container instanceof HTMLElement)) {
    throw new Error("LRC Editor root element is missing");
}
createRoot(container).render(createElement(App));

if (navigator.standalone || window.matchMedia("(display-mode: standalone)").matches) {
    document.addEventListener("click", (ev) => {
        if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
            return;
        }
        const anchor = ev.target instanceof Element ? ev.target.closest("a") : null;
        const href = anchor?.getAttribute("href");

        if (href && href.length > 1 && href.startsWith("#")) {
            ev.preventDefault();
            location.replace(href);
        }
    });
}

window.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer!.dropEffect = "copy";
});
window.addEventListener("drop", (ev) => {
    ev.preventDefault();
});
