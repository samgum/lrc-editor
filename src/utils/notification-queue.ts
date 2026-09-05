export interface NotificationMessage {
    type: "info" | "success" | "warning";
    text: string;
    channel?: string;
}

export interface NotificationEntry extends NotificationMessage {
    id: number;
    count: number;
    revision: number;
}

export const enqueueNotification = (
    queue: readonly NotificationEntry[],
    message: NotificationMessage,
    id: number,
): NotificationEntry[] => {
    const previous = queue.find((item) =>
        message.channel
            ? item.channel === message.channel
            : !item.channel && item.text === message.text && item.type === message.type
    );
    const repeated = previous?.text === message.text && previous.type === message.type;
    const next = { ...message, id: previous?.id ?? id, count: repeated ? previous.count + 1 : 1, revision: id };
    return [next, ...queue.filter((item) => item.id !== previous?.id)].slice(0, 3);
};
