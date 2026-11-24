import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MsalProvider } from "@azure/msal-react";
import {
  PublicClientApplication,
  EventType,
  type Configuration,
} from "@azure/msal-browser";
import { ThemeProvider } from "next-themes";
import { MotionConfig } from "motion/react";
import { msalConfig } from "@/services/authConfig";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import App from "@/App";
import "@/index.css";

const DEV_MODE = import.meta.env.VITE_DEV_MODE === "true";

// In dev mode, use a dummy MSAL config that won't try to connect
const config: Configuration = DEV_MODE
  ? {
      auth: {
        clientId: "00000000-0000-0000-0000-000000000000",
        authority: "https://login.microsoftonline.com/common",
      },
    }
  : msalConfig;

const msalInstance = new PublicClientApplication(config);

// In dev mode, skip MSAL initialization to avoid network errors
if (!DEV_MODE) {
  msalInstance.initialize().then(() => {
    const accounts = msalInstance.getAllAccounts();
    if (accounts.length > 0) {
      msalInstance.setActiveAccount(accounts[0]);
    }

    msalInstance.addEventCallback((event) => {
      if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
        const payload = event.payload as { account?: unknown };
        if (payload.account) {
          msalInstance.setActiveAccount(payload.account as Parameters<typeof msalInstance.setActiveAccount>[0]);
        }
      }
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem storageKey="citadel-theme" disableTransitionOnChange>
      {/* reducedMotion="user": honour the OS "reduce motion" setting everywhere */}
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={300}>
          <MsalProvider instance={msalInstance}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </MsalProvider>
          <Toaster position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  </React.StrictMode>
);
