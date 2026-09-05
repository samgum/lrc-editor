import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { enqueueNotification, type NotificationEntry, type NotificationMessage } from "../utils/notification-queue.js";
import { createPubSub } from "../utils/pubsub.js";
import { appContext, ChangBits } from "./app.context.js";
import { CheckSVG, CloseSVG, InfoSVG, ProblemSVG } from "./svg.js";

export const toastPubSub = createPubSub<NotificationMessage>();

export const Toast: React.FC = () => {
    const { lang } = useContext(appContext, ChangBits.lang);
    const self = useRef(Symbol(Toast.name));
    const sequence = useRef(0);
    const [queue, setQueue] = useState<NotificationEntry[]>([]);
    useEffect(() =>
        toastPubSub.sub(self.current, (message) => {
            const id = ++sequence.current;
            setQueue((current) => enqueueNotification(current, message, id));
        }), []);
    const dismiss = useCallback((id: number) => {
        setQueue((current) => current.filter((item) => item.id !== id));
    }, []);
    return (
        <div className="toast-queue">
            {queue.map((entry) => (
                <ToastItem
                    key={entry.id}
                    entry={entry}
                    onDismiss={dismiss}
                    closeLabel={lang.visual.dismissNotification}
                />
            ))}
        </div>
    );
};

const ToastItem: React.FC<{
    entry: NotificationEntry;
    onDismiss: (id: number) => void;
    closeLabel: string;
}> = ({ entry, onDismiss, closeLabel }) => {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const paused = hovered || focused;
    useEffect(() => {
        if (paused) return;
        const timer = setTimeout(() => onDismiss(entry.id), entry.type === "warning" ? 9000 : 6000);
        return () => clearTimeout(timer);
    }, [entry.revision, entry.id, entry.type, onDismiss, paused]);
    const Badge = { info: InfoSVG, success: CheckSVG, warning: ProblemSVG }[entry.type];
    return (
        <section
            className="toast"
            role={entry.type === "warning" ? "alert" : "status"}
            aria-atomic="true"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocusCapture={() => setFocused(true)}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
            }}
        >
            <span className={`toast-badge toast-${entry.type}`} aria-hidden="true">
                <Badge />
            </span>
            <span className="toast-text">{entry.text}{entry.count > 1 && <small>×{entry.count}</small>}</span>
            <button
                type="button"
                className="toast-close"
                aria-label={closeLabel}
                title={closeLabel}
                onClick={() => onDismiss(entry.id)}
            >
                <CloseSVG />
            </button>
        </section>
    );
};
