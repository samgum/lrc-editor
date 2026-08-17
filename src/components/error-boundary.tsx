import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("LRC Editor render failure", error, info.componentStack);
    }

    render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        const chinese = navigator.language.toLowerCase().startsWith("zh");
        return (
            <main className="app-failure" role="alert">
                <strong>LRC Editor</strong>
                <p>{chinese ? "界面载入失败" : "The interface could not be loaded"}</p>
                <button type="button" onClick={() => location.reload()}>
                    {chinese ? "重新载入" : "Reload"}
                </button>
            </main>
        );
    }
}
