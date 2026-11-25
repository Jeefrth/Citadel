// API location. Sign-in no longer talks to a provider from the browser (SaaS phase 3):
// the backend runs the OIDC flow and the app holds a Citadel session (services/session.ts).
export const apiConfig = {
  baseUrl: import.meta.env.VITE_API_URL || "",
};
