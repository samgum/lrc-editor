import type { LocalAlignmentProgress } from "./local-ai-alignment.js";

export interface AiAlignmentSessionState extends LocalAlignmentProgress {
    provider?: "huhu" | "local";
    visible: boolean;
    error?: string;
    showInstall?: boolean;
}

export interface AiAlignmentSessionSnapshot {
    state: AiAlignmentSessionState | null;
    active: boolean;
}

type Listener = () => void;
type StateUpdater = (
    state: AiAlignmentSessionState | null,
) => AiAlignmentSessionState | null;

let snapshot: AiAlignmentSessionSnapshot = { state: null, active: false };
let activeOperation: Promise<void> | null = null;
let activeController: AbortController | null = null;
const listeners = new Set<Listener>();

const publish = (next: AiAlignmentSessionSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
};

export const getAiAlignmentSessionSnapshot = (): AiAlignmentSessionSnapshot => snapshot;

export const subscribeAiAlignmentSession = (listener: Listener): () => void => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export const updateAiAlignmentSessionState = (updater: StateUpdater): void => {
    publish({ ...snapshot, state: updater(snapshot.state) });
};

export const startAiAlignmentSession = (run: (signal: AbortSignal) => Promise<void>): boolean => {
    if (snapshot.active) return false;

    const controller = new AbortController();
    activeController = controller;
    publish({ ...snapshot, active: true });

    let operation: Promise<void>;
    try {
        operation = run(controller.signal);
    } catch (error) {
        operation = Promise.reject(error);
    }
    activeOperation = operation;
    void operation.catch(() => undefined).finally(() => {
        if (activeOperation !== operation) return;
        activeOperation = null;
        activeController = null;
        publish({ ...snapshot, active: false });
    });
    return true;
};

export const stopAiAlignmentSession = (): boolean => {
    if (!snapshot.active || !activeController || activeController.signal.aborted) return false;
    updateAiAlignmentSessionState((state) =>
        state && {
            ...state,
            phase: "stopping",
            remainingSeconds: undefined,
            error: undefined,
            showInstall: false,
            visible: true,
        }
    );
    activeController.abort();
    return true;
};

export const resetAiAlignmentSessionForTest = (): void => {
    activeController?.abort();
    activeController = null;
    activeOperation = null;
    snapshot = { state: null, active: false };
    listeners.clear();
};
