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
import Sessions from "@/pages/Sessions";
import SettingsPage from "@/pages/Settings";
import Access from "@/pages/Access";
import MyAccount from "@/pages/MyAccount";
import Approvals from "@/pages/Approvals";
import LiveSessions from "@/pages/LiveSessions";
import CommandJournal from "@/pages/CommandJournal";
import Jobs from "@/pages/Jobs";
import JobDetail from "@/pages/JobDetail";
import Infrastructure from "@/pages/Infrastructure";
import Logins from "@/pages/Logins";
import Reports from "@/pages/Reports";
import Risks from "@/pages/Risks";
import Kubernetes from "@/pages/Kubernetes";
import KubernetesCluster from "@/pages/KubernetesCluster";
import PlatformOrgs from "@/pages/PlatformOrgs";

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
        <Route path="/kubernetes" element={<Kubernetes />} />
        <Route path="/kubernetes/:clusterId" element={<KubernetesCluster />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/live" element={<LiveSessions />} />
        <Route path="/commands" element={<CommandJournal />} />
        <Route path="/updates" element={<Updates />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/:jobId" element={<JobDetail />} />
        <Route path="/infrastructure" element={<Infrastructure />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/logins" element={<Logins />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/risks" element={<Risks />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/platform/orgs" element={<PlatformOrgs />} />
        <Route path="/access" element={<Access />} />
        <Route path="/account" element={<MyAccount />} />
        <Route path="/approvals" element={<Approvals />} />
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
