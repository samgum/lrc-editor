const languages = import.meta.glob<Language>(["./*.json", "!./en-US.json"], { query: "?json", import: "default" });

export { languages };

export type Language = typeof import("./en-US.json");
