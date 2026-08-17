// All bindable actions (input-source agnostic)
export const enum InputAction {
    // Synchronizer actions
    Sync = "sync",
    DeleteTime = "deleteTime",
    ResetOffset = "resetOffset",
    DecreaseOffset = "decreaseOffset",
    IncreaseOffset = "increaseOffset",
    PrevLine = "prevLine",
    NextLine = "nextLine",
    FirstLine = "firstLine",
    LastLine = "lastLine",
    PageUp = "pageUp",
    PageDown = "pageDown",

    // Audio control actions
    SeekBackward = "seekBackward",
    SeekForward = "seekForward",
    ResetRate = "resetRate",
    IncreaseRate = "increaseRate",
    DecreaseRate = "decreaseRate",
    TogglePlay = "togglePlay",

    // Global actions
    ShowHelp = "showHelp",
}

export const inputActions = [
    InputAction.Sync,
    InputAction.DeleteTime,
    InputAction.ResetOffset,
    InputAction.DecreaseOffset,
    InputAction.IncreaseOffset,
    InputAction.PrevLine,
    InputAction.NextLine,
    InputAction.FirstLine,
    InputAction.LastLine,
    InputAction.PageUp,
    InputAction.PageDown,
    InputAction.SeekBackward,
    InputAction.SeekForward,
    InputAction.ResetRate,
    InputAction.IncreaseRate,
    InputAction.DecreaseRate,
    InputAction.TogglePlay,
    InputAction.ShowHelp,
] as const;
