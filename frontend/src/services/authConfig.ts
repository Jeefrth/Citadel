import { Configuration, LogLevel } from "@azure/msal-browser";

const tenantId = import.meta.env.VITE_AZURE_TENANT_ID || "";
const clientId = import.meta.env.VITE_AZURE_CLIENT_ID || "";

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => {
        if (level === LogLevel.Error) {
          console.error(message);
        }
      },
      logLevel: LogLevel.Error,
    },
  },
};

export const loginRequest = {
  scopes: [`api://${clientId}/access_as_user`],
};

export const apiConfig = {
  baseUrl: import.meta.env.VITE_API_URL || "",
};
