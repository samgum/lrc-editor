import LSK from "#const/local_key.json" assert { type: "json" };

export type CloudAiProvider = "gemini" | "openrouter";

export interface StoredApiKeyStatus {
    readonly configured: boolean;
    readonly encrypted: boolean;
    readonly updatedAt?: number;
}

export type ApiKeyVaultSummary = Record<CloudAiProvider, StoredApiKeyStatus>;

interface EncryptedKeyRecord {
    readonly v: 1;
    readonly alg: "AES-GCM";
    readonly mode: "idb-key" | "pbkdf2";
    readonly iv: string;
    readonly ct: string;
    readonly salt?: string;
    readonly updatedAt: number;
}

type StoredVaultPayload = Partial<Record<CloudAiProvider, EncryptedKeyRecord>>;

const VAULT_DB_NAME = "lrc-editor-ai-vault";
const VAULT_STORE_NAME = "keys";
const MASTER_KEY_ID = "master-aes-gcm-v1";
const FALLBACK_SALT_STORAGE_KEY = "lrc-editor-ai-vault-salt";
const VAULT_CONTEXT = "lrc-editor-api-key-vault-v1";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const listeners = new Set<() => void>();
let cachedSummary: ApiKeyVaultSummary | null = null;
let cachedMasterKeyPromise: Promise<CryptoKey | null> | null = null;

const notifyListeners = (): void => {
    cachedSummary = null;
    for (const listener of listeners) listener();
};

export const subscribeApiKeyVault = (listener: () => void): () => void => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const getStoredApiKeySummary = (): ApiKeyVaultSummary => {
    if (cachedSummary) return cachedSummary;
    const store = readVaultStore();
    cachedSummary = {
        gemini: toStatus(store.gemini),
        openrouter: toStatus(store.openrouter),
    };
    return cachedSummary;
};

export const saveEncryptedApiKey = async (provider: CloudAiProvider, rawApiKey: string): Promise<void> => {
    const trimmed = rawApiKey.trim();
    if (!trimmed) {
        await deleteEncryptedApiKey(provider);
        return;
    }

    const subtle = getSubtleCrypto();
    if (!subtle) {
        throw new Error("WEB_CRYPTO_UNAVAILABLE");
    }

    const iv = getRandomBytes(12);
    const plaintext = textEncoder.encode(trimmed);
    const idbKey = await getOrCreateIndexedDbKey(subtle);

    let record: EncryptedKeyRecord;
    if (idbKey) {
        const cipherBuffer = await subtle.encrypt({ name: "AES-GCM", iv }, idbKey, plaintext);
        record = {
            v: 1,
            alg: "AES-GCM",
            mode: "idb-key",
            iv: encodeBase64(iv),
            ct: encodeBase64(new Uint8Array(cipherBuffer)),
            updatedAt: Date.now(),
        };
    } else {
        const salt = getRandomBytes(16);
        const derivedKey = await deriveFallbackKey(subtle, salt);
        const cipherBuffer = await subtle.encrypt({ name: "AES-GCM", iv }, derivedKey, plaintext);
        record = {
            v: 1,
            alg: "AES-GCM",
            mode: "pbkdf2",
            iv: encodeBase64(iv),
            ct: encodeBase64(new Uint8Array(cipherBuffer)),
            salt: encodeBase64(salt),
            updatedAt: Date.now(),
        };
    }

    const store = readVaultStore();
    store[provider] = record;
    writeVaultStore(store);
    notifyListeners();
};

export const loadEncryptedApiKey = async (provider: CloudAiProvider): Promise<string | null> => {
    const store = readVaultStore();
    const record = store[provider];
    if (!isValidEncryptedRecord(record)) return null;

    const subtle = getSubtleCrypto();
    if (!subtle) return null;

    try {
        const iv = decodeBase64(record.iv);
        const ciphertext = decodeBase64(record.ct);
        let key: CryptoKey | null = null;
        if (record.mode === "idb-key") {
            key = await getExistingIndexedDbKey();
        } else if (record.mode === "pbkdf2" && record.salt) {
            key = await deriveFallbackKey(subtle, decodeBase64(record.salt));
        }
        if (!key) return null;
        const plainBuffer = await subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
        const value = textDecoder.decode(plainBuffer).trim();
        return value || null;
    } catch {
        return null;
    }
};

export const deleteEncryptedApiKey = async (provider: CloudAiProvider): Promise<void> => {
    const store = readVaultStore();
    if (!(provider in store)) return;
    delete store[provider];
    if (Object.keys(store).length === 0) {
        try {
            localStorage.removeItem(LSK.aiKeys);
        } catch {
            // Ignore storage errors
        }
    } else {
        writeVaultStore(store);
    }
    notifyListeners();
};

export const resetApiKeyVaultCacheForTest = (): void => {
    cachedSummary = null;
    cachedMasterKeyPromise = null;
};

const toStatus = (record: EncryptedKeyRecord | undefined): StoredApiKeyStatus =>
    isValidEncryptedRecord(record)
        ? {
            configured: true,
            encrypted: true,
            updatedAt: record.updatedAt,
        }
        : {
            configured: false,
            encrypted: true,
        };

const isValidEncryptedRecord = (value: unknown): value is EncryptedKeyRecord => {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return record.v === 1
        && record.alg === "AES-GCM"
        && (record.mode === "idb-key" || record.mode === "pbkdf2")
        && typeof record.iv === "string"
        && record.iv.length > 0
        && typeof record.ct === "string"
        && record.ct.length > 0
        && typeof record.updatedAt === "number";
};

const readVaultStore = (): StoredVaultPayload => {
    try {
        const raw = localStorage.getItem(LSK.aiKeys);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "object" || parsed === null) return {};
        const result: StoredVaultPayload = {};
        const obj = parsed as Record<string, unknown>;
        if (isValidEncryptedRecord(obj.gemini)) result.gemini = obj.gemini;
        if (isValidEncryptedRecord(obj.openrouter)) result.openrouter = obj.openrouter;
        return result;
    } catch {
        return {};
    }
};

const writeVaultStore = (store: StoredVaultPayload): void => {
    localStorage.setItem(LSK.aiKeys, JSON.stringify(store));
};

const getSubtleCrypto = (): SubtleCrypto | null => {
    if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) return null;
    return globalThis.crypto.subtle;
};

const getRandomBytes = (length: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(new ArrayBuffer(length));
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
};

const getOrCreateIndexedDbKey = (subtle: SubtleCrypto): Promise<CryptoKey | null> => {
    if (cachedMasterKeyPromise) return cachedMasterKeyPromise;
    cachedMasterKeyPromise = (async () => {
        if (typeof indexedDB === "undefined") return null;
        try {
            const existing = await getExistingIndexedDbKey();
            if (existing) return existing;
            const generated = await subtle.generateKey(
                { name: "AES-GCM", length: 256 },
                false,
                ["encrypt", "decrypt"],
            );
            await putIndexedDbKey(generated);
            return generated;
        } catch {
            return null;
        }
    })();
    return cachedMasterKeyPromise;
};

const openVaultDatabase = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        const request = indexedDB.open(VAULT_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(VAULT_STORE_NAME)) {
                db.createObjectStore(VAULT_STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IDB_OPEN_FAILED"));
    });

const getExistingIndexedDbKey = async (): Promise<CryptoKey | null> => {
    if (typeof indexedDB === "undefined") return null;
    try {
        const db = await openVaultDatabase();
        try {
            return await new Promise<CryptoKey | null>((resolve, reject) => {
                const tx = db.transaction(VAULT_STORE_NAME, "readonly");
                const req = tx.objectStore(VAULT_STORE_NAME).get(MASTER_KEY_ID);
                req.onsuccess = () => {
                    const value = req.result;
                    resolve(value && typeof value === "object" ? (value as CryptoKey) : null);
                };
                req.onerror = () => reject(req.error || new Error("IDB_READ_FAILED"));
            });
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
};

const putIndexedDbKey = async (key: CryptoKey): Promise<void> => {
    const db = await openVaultDatabase();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(VAULT_STORE_NAME, "readwrite");
            tx.objectStore(VAULT_STORE_NAME).put(key, MASTER_KEY_ID);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("IDB_WRITE_FAILED"));
        });
    } finally {
        db.close();
    }
};

const getOrCreateFallbackSecretMaterial = (): string => {
    let deviceToken = "";
    try {
        deviceToken = localStorage.getItem(FALLBACK_SALT_STORAGE_KEY) || "";
        if (!deviceToken) {
            deviceToken = encodeBase64(getRandomBytes(32));
            localStorage.setItem(FALLBACK_SALT_STORAGE_KEY, deviceToken);
        }
    } catch {
        deviceToken = "ephemeral-fallback";
    }
    const origin = typeof location !== "undefined" ? location.origin : "local";
    return `${VAULT_CONTEXT}:${origin}:${deviceToken}`;
};

const deriveFallbackKey = async (subtle: SubtleCrypto, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
    const material = await subtle.importKey(
        "raw",
        textEncoder.encode(getOrCreateFallbackSecretMaterial()),
        "PBKDF2",
        false,
        ["deriveKey"],
    );
    return subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 120_000,
            hash: "SHA-256",
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
};

const encodeBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
    }
    return btoa(binary);
};

const decodeBase64 = (base64: string): Uint8Array<ArrayBuffer> => {
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};
