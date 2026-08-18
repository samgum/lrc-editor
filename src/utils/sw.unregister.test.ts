import { afterEach, describe, expect, it, vi } from "vitest";
import { unregister } from "./sw.unregister.js";

describe("website cache cleanup", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("removes only LRC Editor caches, unregisters the worker, and reloads", async () => {
        const deleteCache = vi.fn(async () => true);
        const unregisterWorker = vi.fn(async () => true);
        const reload = vi.fn();
        vi.stubGlobal("window", { caches: {} });
        vi.stubGlobal("caches", {
            keys: async () => ["lrc-editor-old", "another-app"],
            delete: deleteCache,
        });
        vi.stubGlobal("navigator", {
            serviceWorker: {
                getRegistration: async () => ({ unregister: unregisterWorker }),
            },
        });
        vi.stubGlobal("location", { reload });

        await unregister();

        expect(deleteCache).toHaveBeenCalledOnce();
        expect(deleteCache).toHaveBeenCalledWith("lrc-editor-old");
        expect(unregisterWorker).toHaveBeenCalledOnce();
        expect(reload).toHaveBeenCalledOnce();
    });

    it("can clean development state without reloading", async () => {
        const reload = vi.fn();
        vi.stubGlobal("window", {});
        vi.stubGlobal("navigator", {});
        vi.stubGlobal("location", { reload });

        await unregister(false);

        expect(reload).not.toHaveBeenCalled();
    });
});
