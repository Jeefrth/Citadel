import { Outlet, NavLink } from "react-router-dom";
import { useMsal } from "@azure/msal-react";
import {
  Server,
  Terminal,
  RefreshCw,
  LayoutDashboard,
  Shield,
  Film,
  LogOut,
  User,
} from "lucide-react";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/servers", icon: Server, label: "Serveurs" },
  { to: "/terminal", icon: Terminal, label: "Terminal" },
  { to: "/sessions", icon: Film, label: "Sessions" },
  { to: "/updates", icon: RefreshCw, label: "Mises à jour" },
  { to: "/audit", icon: Shield, label: "Audit" },
];

export default function Layout() {
  const { instance, accounts } = useMsal();
  const account = accounts[0];

  const handleLogout = () => {
    instance.logoutRedirect();
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-card flex flex-col">
        <div className="p-6 border-b">
          <h1 className="text-xl font-bold text-primary">srv_gest</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Gestion de serveurs
          </p>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User info */}
        <div className="p-4 border-t">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <User size={16} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {account?.name || "Utilisateur"}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {account?.username || ""}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground"
              title="Se déconnecter"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
