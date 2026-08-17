import * as React from "react";
import { AppProvider } from "./app.context.js";
import { Content } from "./content.js";
import { AppErrorBoundary } from "./error-boundary.js";
import { Footer } from "./footer.js";
import { Header } from "./header.js";
import { Toast } from "./toast.js";

export const App: React.FC = () => {
    return (
        <React.StrictMode>
            <AppErrorBoundary>
                <AppProvider>
                    <Header />
                    <Content />
                    <Footer />
                    <Toast />
                </AppProvider>
            </AppErrorBoundary>
        </React.StrictMode>
    );
};
