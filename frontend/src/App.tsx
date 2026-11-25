import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { toast } from "sonner";
import { useAuthState } from "@/services/session";
import Layout from "@/components/Layout";
import OrgChangedNotice from "@/components/shell/OrgChangedNotice";
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

function AppRoutes() {
  return (
    <>
    <OrgChangedNotice />
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
    </>
  );
}

/** Session first (refresh cookie): sign-in page when signed out (dev mode: always in). */
export default function App() {
  const auth = useAuthState();

  // A failed sign-in while a session is still open: show it, then clean the URL
  useEffect(() => {
    if (auth !== "signedIn") return;
    const url = new URL(window.location.href);
    const err = url.searchParams.get("auth_error");
    if (err === null) return;
    toast.error(`Connexion impossible : ${err}`);
    url.searchParams.delete("auth_error");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [auth]);

  if (auth === "loading") {
    return <div className="min-h-svh bg-background" aria-busy="true" />;
  }
  if (auth === "signedOut") return <LoginPage />;
  return <AppRoutes />;
}
