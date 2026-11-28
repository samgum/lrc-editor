import LSK from "#const/local_key.json" assert { type: "json" };
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    deleteEncryptedApiKey,
    getStoredApiKeySummary,
    loadEncryptedApiKey,
    resetApiKeyVaultCacheForTest,
    saveEncryptedApiKey,
    subscribeApiKeyVault,
} from "./ai-key-vault.js";

const createMemoryStorage = (): Storage => {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        clear: () => map.clear(),
        getItem: (key) => map.get(key) ?? null,
        key: (index) => Array.from(map.keys())[index] ?? null,
        removeItem: (key) => {
            map.delete(key);
        },
        setItem: (key, value) => {
            map.set(key, value);
        },
    };
};

describe("ai-key-vault", () => {
    let storage: Storage;

    beforeEach(() => {
        storage = createMemoryStorage();
        vi.stubGlobal("localStorage", storage);
        vi.stubGlobal("location", { origin: "https://lrc.sgmy.org" });
        resetApiKeyVaultCacheForTest();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        resetApiKeyVaultCacheForTest();
    });

    it("encrypts API keys with AES-GCM and never stores plaintext in localStorage", async () => {
        const fakeGeminiSecret = "fake-gemini-key-for-unit-test-12345";
        const fakeOrSecret = "fake-openrouter-key-for-unit-test-67890";

        await saveEncryptedApiKey("gemini", fakeGeminiSecret);
        await saveEncryptedApiKey("openrouter", fakeOrSecret);

        const rawStored = storage.getItem(LSK.aiKeys) || "";
        expect(rawStored).toContain("AES-GCM");
        expect(rawStored).not.toContain(fakeGeminiSecret);
        expect(rawStored).not.toContain(fakeOrSecret);

        const summary = getStoredApiKeySummary();
        expect(summary.gemini.configured).toBe(true);
        expect(summary.gemini.encrypted).toBe(true);
        expect(summary.openrouter.configured).toBe(true);

        expect(await loadEncryptedApiKey("gemini")).toBe(fakeGeminiSecret);
        expect(await loadEncryptedApiKey("openrouter")).toBe(fakeOrSecret);
    });

    it("notifies subscribers on save and delete, and removes storage when empty", async () => {
        const listener = vi.fn();
        const unsubscribe = subscribeApiKeyVault(listener);

        await saveEncryptedApiKey("gemini", "sample-test-key");
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getStoredApiKeySummary().gemini.configured).toBe(true);

        await deleteEncryptedApiKey("gemini");
        expect(listener).toHaveBeenCalledTimes(2);
        expect(getStoredApiKeySummary().gemini.configured).toBe(false);
        expect(await loadEncryptedApiKey("gemini")).toBeNull();
        expect(storage.getItem(LSK.aiKeys)).toBeNull();

        unsubscribe();
    });
});
