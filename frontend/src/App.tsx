import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import {
  AuthenticatedTemplate,
  UnauthenticatedTemplate,
  useMsal,
} from "@azure/msal-react";
import { setMsalInstance } from "@/services/api";
import Layout from "@/components/Layout";
import LoginPage from "@/components/LoginPage";
import Dashboard from "@/pages/Dashboard";
import Servers from "@/pages/Servers";
import TerminalPage from "@/pages/TerminalPage";
import Updates from "@/pages/Updates";
import Audit from "@/pages/Audit";
import ServerDetail from "@/pages/ServerDetail";

// DEV MODE: bypass Entra ID auth for local testing
const DEV_MODE = import.meta.env.VITE_DEV_MODE === "true";

function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/servers" element={<Servers />} />
            <Route path="/servers/:serverId" element={<ServerDetail />} />
        <Route path="/terminal" element={<TerminalPage />} />
        <Route path="/updates" element={<Updates />} />
        <Route path="/audit" element={<Audit />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  const { instance } = useMsal();

  useEffect(() => {
    setMsalInstance(instance);
  }, [instance]);

  if (DEV_MODE) {
    return <AppRoutes />;
  }

  return (
    <>
      <UnauthenticatedTemplate>
        <LoginPage />
      </UnauthenticatedTemplate>

      <AuthenticatedTemplate>
        <AppRoutes />
      </AuthenticatedTemplate>
    </>
  );
}
