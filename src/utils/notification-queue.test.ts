import { describe, expect, it } from "vitest";
import { enqueueNotification, type NotificationEntry } from "./notification-queue.js";

describe("notification queue", () => {
    it("replaces media progress with its result in the same card", () => {
        const progress = enqueueNotification([], { type: "info", text: "Resolving", channel: "media" }, 1);
        const result = enqueueNotification(progress, { type: "success", text: "Loaded", channel: "media" }, 2);
        expect(result).toEqual([{ id: 1, type: "success", text: "Loaded", channel: "media", count: 1, revision: 2 }]);
    });
    it("coalesces repeats without accumulating new cards", () => {
        let queue: NotificationEntry[] = [];
        for (let id = 1; id <= 100; id++) queue = enqueueNotification(queue, { type: "info", text: "Loading" }, id);
        expect(queue).toEqual([{ id: 1, type: "info", text: "Loading", count: 100, revision: 100 }]);
    });

    it("keeps at most three distinct messages and does not merge different severities", () => {
        let queue: NotificationEntry[] = [];
        queue = enqueueNotification(queue, { type: "info", text: "A" }, 1);
        queue = enqueueNotification(queue, { type: "warning", text: "A" }, 2);
        queue = enqueueNotification(queue, { type: "success", text: "B" }, 3);
        const updated = enqueueNotification(queue, { type: "warning", text: "C" }, 4);
        expect(updated.map((entry) => entry.id)).toEqual([4, 3, 2]);
        expect(queue.map((entry) => entry.id)).toEqual([3, 2, 1]);
    });
});
