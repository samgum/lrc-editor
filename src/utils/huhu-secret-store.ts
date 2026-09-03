const databaseName = "lrc-editor-private-settings";
const databaseVersion = 1;
const recordStore = "records";
const wrappingKeyId = "huhu-wrapping-key";
const apiKeyId = "huhu-api-key";
const secretContext = new TextEncoder().encode("lrc-editor:huhu-api-key:v1");

interface WrappingKeyRecord {
    id: typeof wrappingKeyId;
    value: CryptoKey;
}

interface SecretRecord {
    id: typeof apiKeyId;
    ciphertext: ArrayBuffer;
    iv: Uint8Array<ArrayBuffer>;
}

let databasePromise: Promise<IDBDatabase> | undefined;

export const saveHuhuApiKey = async (apiKey: string): Promise<void> => {
    const normalized = apiKey.trim();
    if (!normalized || normalized.length > 2_048) throw new Error("INVALID_API_KEY");
    const wrappingKey = await getOrCreateWrappingKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: secretContext },
        wrappingKey,
        new TextEncoder().encode(normalized),
    );
    await putRecord({ id: apiKeyId, ciphertext, iv });
};

export const hasHuhuApiKey = async (): Promise<boolean> => {
    const [keyRecord, secretRecord] = await Promise.all([
        getRecord<WrappingKeyRecord>(wrappingKeyId),
        getRecord<SecretRecord>(apiKeyId),
    ]);
    return Boolean(keyRecord && secretRecord);
};

export const readHuhuApiKey = async (): Promise<string | null> => {
    const [keyRecord, secretRecord] = await Promise.all([
        getRecord<WrappingKeyRecord>(wrappingKeyId),
        getRecord<SecretRecord>(apiKeyId),
    ]);
    if (!keyRecord || !secretRecord) return null;
    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: secretRecord.iv, additionalData: secretContext },
        keyRecord.value,
        secretRecord.ciphertext,
    );
    const apiKey = new TextDecoder().decode(plaintext).trim();
    return apiKey || null;
};

export const clearHuhuApiKey = async (): Promise<void> => {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(recordStore, "readwrite");
        const store = transaction.objectStore(recordStore);
        store.delete(apiKeyId);
        store.delete(wrappingKeyId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("SECRET_STORE_WRITE_FAILED"));
        transaction.onabort = () => reject(transaction.error || new Error("SECRET_STORE_WRITE_FAILED"));
    });
};

const getOrCreateWrappingKey = async (): Promise<CryptoKey> => {
    const existing = await getRecord<WrappingKeyRecord>(wrappingKeyId);
    if (existing) return existing.value;
    const value = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
    await putRecord({ id: wrappingKeyId, value });
    return value;
};

const openDatabase = (): Promise<IDBDatabase> => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, databaseVersion);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(recordStore)) {
                database.createObjectStore(recordStore, { keyPath: "id" });
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            database.onversionchange = () => {
                database.close();
                databasePromise = undefined;
            };
            resolve(database);
        };
        request.onerror = () => {
            databasePromise = undefined;
            reject(request.error || new Error("SECRET_STORE_OPEN_FAILED"));
        };
        request.onblocked = () => {
            databasePromise = undefined;
            reject(new Error("SECRET_STORE_OPEN_BLOCKED"));
        };
    });
    return databasePromise;
};

const getRecord = async <T>(id: string): Promise<T | undefined> => {
    const database = await openDatabase();
    return await new Promise<T | undefined>((resolve, reject) => {
        const transaction = database.transaction(recordStore, "readonly");
        const request = transaction.objectStore(recordStore).get(id);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => reject(request.error || new Error("SECRET_STORE_READ_FAILED"));
    });
};

const putRecord = async (record: WrappingKeyRecord | SecretRecord): Promise<void> => {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(recordStore, "readwrite");
        transaction.objectStore(recordStore).put(record);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("SECRET_STORE_WRITE_FAILED"));
        transaction.onabort = () => reject(transaction.error || new Error("SECRET_STORE_WRITE_FAILED"));
    });
};
