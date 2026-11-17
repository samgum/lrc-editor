const ncmcWorker = self as DedicatedWorkerGlobalScope;

const CORE_KEY = Uint8Array.of(
    0x68,
    0x7a,
    0x48,
    0x52,
    0x41,
    0x6d,
    0x73,
    0x6f,
    0x35,
    0x6b,
    0x49,
    0x6e,
    0x62,
    0x61,
    0x78,
    0x57,
);

const AES_ECB_DECRYPT = async (keyData: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
    /**
     * simulate ECB with CBC
     *
     *  ECB encryption:
     *           Plaintext                                 Plaintext(padding)
     *               |                                         |
     * key -> | block cipher |                   key -> | block cipher |
     *        |  encryption  |                          |  encryption  |
     *               |                                         |
     *           Ciphertext                                Ciphertext(encryptedPadding)
     *
     *  ECB decryption:
     *           Ciphertext                                Ciphertext(encryptedPadding)
     *               |                                         |
     * key -> | block cipher |                   key -> | block cipher |
     *        |  decryption  |                          |  decryption  |
     *               |                                         |
     *           Plaintext                                 Plaintext(padding)
     *
     *  CBC encryption:
     *          Plaintext                                  Plaintext(padding)
     *               |                                         |
     *  iv --------> x                   --------------------> x
     *               |                   |                     |
     *        | block cipher |           |              | block cipher |
     * key -> |  encryption  |           |       key -> |  encryption  |
     *               |                   |                     |
     *               | ------------------|                     |
     *           Ciphertext                                Ciphertext(encryptedPadding)
     *
     *  CBC decryption:
     *           Ciphertext                                Ciphertext(encryptedPadding)
     *               |                                         |
     *  iv --------> x                   --------------------> x
     *               |                   |                     |
     *        | block cipher |           |              | block cipher |
     * key -> |  decryption  |           |       key -> |  decryption  |
     *               |                   |                     |
     *               | ------------------|                     |
     *          Plaintext                                  Plaintext(padding)
     *
     *  Simulate:
     *   ---------------------------------------|
     *   |            Plaintext                 |                 Padding
     *   |                |                     |                    |
     *   |                |                     -------------------> x
     *   |                |                                          |
     *   |          |    ECB     |                             |    CBC     |
     *   |   key -> | encryption |                      key -> | encryption |
     *   |                |                                          |
     *   |---- Ciphertext + encryptedPadding  <==>  encryptedPadding + anoter block (not used)
     *                    |
     *     iv(0) ------>  x
     *                    |
     *              |    CBC     |
     *       key -> | decryption |
     *                    |
     *                Plaintext
     */

    const AES = {
        name: "AES-CBC",
        iv: new Uint8Array(16),
    };

    const cryptoKey = await crypto.subtle.importKey("raw", keyData, "AES-CBC", false, ["encrypt", "decrypt"]);

    const bodyLength = data.byteLength - 16;

    const tailBlock = data.slice(bodyLength);

    const deTailBlock = await crypto.subtle.decrypt(AES, cryptoKey, tailBlock);

    const decrypted = new Uint8Array(bodyLength + deTailBlock.byteLength);

    decrypted.set(new Uint8Array(deTailBlock), bodyLength);

    const padding = new Uint8Array(16);
    padding.fill(16);
    const cipher = new Uint8Array(32);

    for (let curser = 0; curser < bodyLength; curser += 16) {
        const clip = data.slice(curser, curser + 16);

        const encryptedPadding = await crypto.subtle.encrypt(
            {
                name: "AES-CBC",
                iv: clip,
            },
            cryptoKey,
            padding,
        );

        cipher.set(clip, 0);
        cipher.set(new Uint8Array(encryptedPadding).slice(0, 16), 16);

        const result = await crypto.subtle.decrypt(AES, cryptoKey, cipher);
        decrypted.set(new Uint8Array(result), curser);
    }

    return decrypted;
};

ncmcWorker.addEventListener("message", async (ev) => {
    try {
        if (!crypto?.subtle) {
            ncmcWorker.postMessage<IMessage>({ type: "error", payload: "Web Crypto API is unavailable" });
            return;
        }
        const file: File = ev.data;
        const filebuffer = new FileReaderSync().readAsArrayBuffer(file);
        const dataview = new DataView(filebuffer);

        if (
            filebuffer.byteLength < 14
            || dataview.getUint32(0, true) !== 0x4e455443
            || dataview.getUint32(4, true) !== 0x4d414446
        ) {
            ncmcWorker.postMessage<IMessage>({ type: "error", payload: "not ncm file" });
            return;
        }

        let offset = 10;

        const keyDate = (
            await ((): Promise<Uint8Array> => {
                const keyLen = dataview.getUint32(offset, true);
                offset += 4;
                if (keyLen < 32 || keyLen % 16 !== 0 || offset + keyLen > filebuffer.byteLength) {
                    throw new RangeError("corrupted ncm key block");
                }
                const data = new Uint8Array(filebuffer, offset, keyLen);
                const xored = new Uint8Array(keyLen);
                for (let index = 0; index < keyLen; index++) {
                    xored[index] = data[index] ^ 0x64;
                }
                offset += keyLen;

                return AES_ECB_DECRYPT(CORE_KEY, xored);
            })()
        ).slice(17);

        if (keyDate.length === 0) {
            throw new RangeError("empty ncm stream key");
        }

        const keyBox = ((): Uint8Array => {
            const box = new Uint8Array(256);
            for (let i = 0; i < 256; i++) {
                box[i] = i;
            }

            const keyDataLen = keyDate.length;

            let j = 0;

            for (let i = 0; i < 256; i++) {
                j = (box[i] + j + keyDate[i % keyDataLen]) & 0xff;
                const tmp = box[i];
                box[i] = box[j];
                box[j] = tmp;
            }

            const schedule = new Uint8Array(256);
            for (let k = 0; k < 256; k++) {
                const i = (k + 1) & 0xff;
                const si = box[i];
                const sj = box[(i + si) & 0xff];
                schedule[k] = box[(si + sj) & 0xff];
            }
            return schedule;
        })();

        if (offset + 4 > filebuffer.byteLength) {
            throw new RangeError("corrupted ncm metadata block");
        }
        const metaLen = dataview.getUint32(offset, true);
        offset += metaLen + 4;
        if (offset + 9 > filebuffer.byteLength) {
            throw new RangeError("corrupted ncm cover block");
        }
        const coverLen = dataview.getUint32(offset + 5, true);
        offset += coverLen + 13;
        if (offset > filebuffer.byteLength) {
            throw new RangeError("corrupted ncm audio offset");
        }

        // workaround for Firefox which async function causes performance problems
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1521435
        const decryptedData = ((): Uint8Array => {
            const data = new Uint8Array(filebuffer, offset);
            const dataLength = data.length;

            for (let cur = 0; cur < dataLength; ++cur) {
                data[cur] ^= keyBox[cur & 0xff];
            }

            return data;
        })();

        ncmcWorker.postMessage<IMessage>({ type: "success", payload: decryptedData }, [decryptedData.buffer]);
    } catch (error) {
        ncmcWorker.postMessage<IMessage>({
            type: "error",
            payload: error instanceof Error ? error.message : "ncm decode failed",
        });
    } finally {
        ncmcWorker.close();
    }
});
