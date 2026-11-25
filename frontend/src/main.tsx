import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { bootstrapSession } from "@/services/session";
import App from "@/App";
import "@/index.css";

// Sign-in is handled by the backend (OIDC); the app starts by asking for an access
// token with the refresh cookie (no-op in dev mode).
void bootstrapSession();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem storageKey="citadel-theme" disableTransitionOnChange>
      {/* reducedMotion="user": honour the OS "reduce motion" setting everywhere */}
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={300}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
          <Toaster position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  </React.StrictMode>
);
